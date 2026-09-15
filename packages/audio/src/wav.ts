/**
 * Minimal WAV decoding and resampling for KRONOS.
 *
 * Used by the evaluation harness and tests to feed real recorded audio into the
 * ASR engine in Node, where there is no Web Audio API to do it for us. The
 * browser path does not use this — there, AudioContext delivers Float32 PCM at
 * the requested sample rate directly.
 *
 * Supports 16-bit and 32-bit float PCM WAV, which covers everything ffmpeg and
 * ordinary recorders emit. Deliberately not a general-purpose WAV library.
 */

import { CONFIG } from "@kronos/core";

export interface DecodedAudio {
  /** Mono Float32 PCM in [-1, 1]. */
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly durationMs: number;
}

/** Reads a four-character ASCII chunk identifier. */
function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

/**
 * Decodes a PCM WAV file to mono Float32.
 *
 * Walks the RIFF chunk list rather than assuming `data` begins at byte 44.
 * Files written by ffmpeg routinely carry a LIST/INFO chunk before the audio,
 * and fixed-offset parsers read metadata as samples and produce noise.
 */
export function decodeWav(buffer: ArrayBuffer | Uint8Array): DecodedAudio {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (readTag(view, 0) !== "RIFF" || readTag(view, 8) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let offset = 12;
  let numChannels = 1;
  let sampleRate: number = CONFIG.audio.SAMPLE_RATE;
  let bitsPerSample = 16;
  let audioFormat = 1; // 1 = PCM integer, 3 = IEEE float
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= bytes.byteLength) {
    const tag = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (tag === "fmt ") {
      audioFormat = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (tag === "data") {
      dataOffset = body;
      dataLength = size;
      break;
    }

    // Chunks are word-aligned; odd-sized chunks carry a pad byte.
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error("WAV file contains no data chunk");

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * numChannels));
  const mono = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const pos = dataOffset + (frame * numChannels + ch) * bytesPerSample;
      if (audioFormat === 3 && bitsPerSample === 32) {
        sum += view.getFloat32(pos, true);
      } else if (bitsPerSample === 16) {
        sum += view.getInt16(pos, true) / 32768;
      } else if (bitsPerSample === 32) {
        sum += view.getInt32(pos, true) / 2147483648;
      } else if (bitsPerSample === 8) {
        sum += (view.getUint8(pos) - 128) / 128;
      } else {
        throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
      }
    }
    // Downmix to mono by averaging channels.
    mono[frame] = sum / numChannels;
  }

  return {
    samples: mono,
    sampleRate,
    durationMs: (frameCount / sampleRate) * 1000,
  };
}

/**
 * Resamples to the target rate using linear interpolation.
 *
 * Linear interpolation is not the highest-quality resampler available — it does
 * not low-pass filter, so downsampling can alias. It is used here because the
 * input is speech being fed to Whisper, whose own front end is a mel
 * spectrogram that discards the affected high-frequency detail anyway, and
 * because it avoids adding a DSP dependency to satisfy a test path.
 *
 * Production audio never takes this route: the browser's AudioContext is opened
 * at 16 kHz and resamples in native code.
 */
export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number = CONFIG.audio.SAMPLE_RATE
): Float32Array {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }

  return out;
}

/** Decodes a WAV buffer straight to the 16 kHz mono Float32 the ASR expects. */
export function decodeWavTo16kMono(buffer: ArrayBuffer | Uint8Array): Float32Array {
  const decoded = decodeWav(buffer);
  return resample(decoded.samples, decoded.sampleRate, CONFIG.audio.SAMPLE_RATE);
}
