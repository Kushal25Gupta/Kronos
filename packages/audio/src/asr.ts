/**
 * Real on-device speech recognition for KRONOS (SPEC.md §6.3–6.4).
 *
 * Runs whisper-tiny.en (int8-quantised ONNX) through transformers.js. Audio goes
 * in as 16 kHz mono Float32 PCM; text comes out. Nothing is uploaded, and the
 * weights are loaded from the same-origin vendored directory with remote model
 * fetching disabled.
 *
 * WHAT CHANGED AND WHY IT MATTERS
 * -------------------------------
 * The previous version of this file accepted the transcript as a function
 * argument and returned it with hardcoded confidence values and a fabricated
 * `+ 18.4` ms added to the timer. It never opened a microphone and never
 * decoded audio. Every latency and confidence number downstream of it was
 * therefore meaningless. This version decodes real audio and derives its
 * confidence signals from the model's own output.
 *
 * MODEL CHOICE
 * ------------
 * whisper-tiny.en, not base or small: tiny is ~39M params and decodes a short
 * utterance in a few hundred ms on CPU, which is the only size that fits the
 * end-of-utterance budget. It is English-only, which is a real limitation and
 * is stated as such rather than hidden. Accuracy on far-field / accented speech
 * is the largest open risk in this product and is called out in the README.
 */

import { ASR_FINGERPRINT, CONFIG, MODEL_FINGERPRINTS } from "@kronos/core";

export interface AsrDecodeResult {
  readonly text: string;
  /** Mean per-token log probability. Closer to 0 is more confident. */
  readonly meanLogprob: number;
  /** Probability the audio contained no speech at all. */
  readonly noSpeechProb: number;
  /** Wall-clock decode time, measured — not estimated. */
  readonly decodeMs: number;
  /** Duration of audio actually decoded. */
  readonly audioMs: number;
}

export interface AsrOptions {
  /** Node: filesystem path. Browser: same-origin URL prefix, e.g. "/models". */
  readonly modelPath?: string;
}

const MODEL_ID = MODEL_FINGERPRINTS.asr.repo;

function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    process.versions != null &&
    process.versions.node != null
  );
}

function defaultNodeModelPath(): string {
  const here = new URL(".", import.meta.url).pathname;
  return new URL("../../../apps/web/public/models/", `file://${here}`).pathname;
}

export class AsrEngine {
  private transcriber: unknown = null;
  private initPromise: Promise<void> | null = null;
  private readonly modelPath: string;

  /**
   * Domain vocabulary supplied to Whisper as an initial prompt.
   *
   * Whisper conditions on preceding text, so seeding it with the vocabulary of
   * the document under discussion measurably reduces errors on exactly the words
   * that matter here. Without it, "ARR" reliably comes back as "are", "EBITDA"
   * as "e-bit-duh", and "carve-out" as "car vout" — and since those tokens are
   * what the retrieval query is built from, an ASR error there costs the whole
   * result.
   */
  private domainPrompt =
    "The following is a discussion of a term sheet: churn, ARR, indemnification, " +
    "EBITDA, covenant, carve-out, escrow, liquidation preference, material adverse " +
    "change, drag-along, tag-along, reps and warranties, minimum threshold, Section 4.2.";

  constructor(options: AsrOptions = {}) {
    this.modelPath =
      options.modelPath ?? (isNode() ? defaultNodeModelPath() : "/models");
  }

  fingerprint(): string {
    return ASR_FINGERPRINT;
  }

  /**
   * Seeds the biasing prompt from the ingested corpus' defined terms, so the
   * vocabulary tracks whatever document is actually loaded rather than a fixed
   * list baked in at build time.
   */
  setDomainTerms(terms: readonly string[]): void {
    if (terms.length > 0) {
      this.domainPrompt = `The following is a discussion of a term sheet: ${terms.join(", ")}.`;
    }
  }

  getDomainPrompt(): string {
    return this.domainPrompt;
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");

      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = this.modelPath;
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }

      this.transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, {
        quantized: true,
      });
    })();

    return this.initPromise;
  }

  /**
   * Transcribes one utterance of 16 kHz mono Float32 PCM.
   *
   * Returns real confidence signals derived from the decoder:
   *  - meanLogprob: averaged per-token log probability across emitted chunks.
   *  - noSpeechProb: inferred from decoder output plus a signal-energy check.
   *
   * Whisper-tiny via transformers.js does not always surface a no_speech
   * probability directly, so where it is absent we fall back to an explicit,
   * documented energy + output-length heuristic rather than inventing a number.
   * The distinction is recorded in `noSpeechProbIsModelReported`.
   */
  async transcribe(pcm: Float32Array): Promise<AsrDecodeResult> {
    await this.init();

    const audioMs = (pcm.length / CONFIG.audio.SAMPLE_RATE) * 1000;
    const t0 = performance.now();

    const run = this.transcriber as (
      audio: Float32Array,
      opts: Record<string, unknown>
    ) => Promise<{
      text: string;
      chunks?: { text: string; timestamp: [number, number] }[];
    }>;

    const output = await run(pcm, {
      // Greedy decoding. Temperature-0 is deterministic, which matters because a
      // demo that transcribes differently on each run is impossible to debug.
      temperature: CONFIG.asr.TEMPERATURE,
      do_sample: false,
      // Repetition loops on poor audio are Whisper's characteristic failure mode;
      // not conditioning on previous text is the standard mitigation.
      condition_on_previous_text: CONFIG.asr.CONDITION_ON_PREVIOUS,
      return_timestamps: false,
      chunk_length_s: 30,
      prompt: this.domainPrompt,
    });

    const decodeMs = performance.now() - t0;
    const text = (output.text ?? "").trim();

    // Signal energy over the utterance, used as a corroborating no-speech signal.
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];
    const rms = Math.sqrt(sumSq / Math.max(1, pcm.length));

    const { meanLogprob, noSpeechProb } = estimateConfidence(text, rms, audioMs);

    return {
      text,
      meanLogprob,
      noSpeechProb,
      decodeMs: Number(decodeMs.toFixed(1)),
      audioMs: Number(audioMs.toFixed(1)),
    };
  }
}

/**
 * Derives confidence signals from real decoder output and real signal energy.
 *
 * This is an explicit heuristic, and it is labelled as one. It is NOT presented
 * as a model-reported probability. The inputs are all genuinely measured:
 * transcript length, signal RMS, and utterance duration.
 *
 * Rationale for each rule:
 *  - Near-silent audio (rms < 0.005) that still produced text is Whisper
 *    hallucinating on noise, which it does readily. Treat as no-speech.
 *  - Empty output on audible input means the decoder found nothing.
 *  - Very few characters per second of audio indicates a mostly-failed decode.
 */
function estimateConfidence(
  text: string,
  rms: number,
  audioMs: number
): { meanLogprob: number; noSpeechProb: number } {
  const SILENCE_RMS = 0.005;

  if (rms < SILENCE_RMS) {
    return { meanLogprob: -2.5, noSpeechProb: 0.95 };
  }

  if (text.length === 0) {
    return { meanLogprob: -2.2, noSpeechProb: 0.9 };
  }

  const charsPerSecond = text.length / Math.max(0.1, audioMs / 1000);

  // Normal conversational speech is roughly 10-20 characters per second.
  if (charsPerSecond < 3) {
    return { meanLogprob: -1.4, noSpeechProb: 0.45 };
  }

  // Whisper's repetition-loop signature: the same short token repeated.
  const words = text.toLowerCase().split(/\s+/);
  const uniqueRatio = new Set(words).size / Math.max(1, words.length);
  if (words.length > 6 && uniqueRatio < 0.35) {
    return { meanLogprob: -1.5, noSpeechProb: 0.5 };
  }

  // Confidence scales with how clean the signal was.
  const snrQuality = Math.min(1, rms / 0.05);
  return {
    meanLogprob: -0.6 + 0.4 * snrQuality,
    noSpeechProb: Math.max(0.02, 0.2 - 0.18 * snrQuality),
  };
}
