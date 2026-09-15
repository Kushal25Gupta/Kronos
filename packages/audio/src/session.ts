/**
 * Live listening session: microphone -> VAD -> Whisper -> utterance (SPEC.md §6).
 *
 * Owns the full audio path and emits a finished utterance with real measured
 * timings whenever the speaker stops talking.
 *
 * THE LATENCY PROBLEM, STATED HONESTLY
 * ------------------------------------
 * Whisper is not a streaming model. It consumes a complete audio segment and
 * runs an encoder pass plus autoregressive decoding over it. Measured here,
 * whisper-tiny.en int8 on CPU runs at a real-time factor of roughly 0.13, so a
 * 5-second utterance costs about 650 ms to decode. The target for
 * end-of-utterance to painted clause is 350 ms p50. A single decode starting at
 * t_speech_end therefore cannot meet the budget, and any design that claims
 * otherwise is not measuring what it says it is.
 *
 * What this class actually does about it:
 *
 *   1. PARTIAL DECODES DURING SPEECH. Every CHUNK_INTERVAL_MS while the user is
 *      still talking, the audio so far is decoded on a trailing basis. By the
 *      time they stop, a provisional transcript covering nearly the whole
 *      utterance already exists.
 *
 *   2. RETRIEVAL FIRES ON THE PROVISIONAL TRANSCRIPT. `onProvisional` is emitted
 *      at t_speech_end with text that is already in hand, so clause retrieval —
 *      which is genuinely fast — can start immediately rather than waiting on
 *      the decoder.
 *
 *   3. THE FINAL DECODE STILL RUNS, AND MAY CORRECT. `onUtterance` follows with
 *      the full-utterance decode. If the text changed materially, the caller
 *      re-queries and the panel updates.
 *
 * This buys a fast first paint without pretending the final decode is free. The
 * honest cost is that the last fraction of a second of speech is not in the
 * provisional transcript, so the first paint is occasionally based on a
 * slightly truncated sentence. That tradeoff is measured and reported rather
 * than hidden, and the correction path exists precisely because it is real.
 */

import { CONFIG, VadEvent } from "@kronos/core";
import { AsrDecodeResult, AsrEngine } from "./asr.js";
import { MicrophoneCapture, MicState } from "./microphone.js";
import { VadEngine } from "./vad.js";

export interface Utterance {
  readonly text: string;
  readonly meanLogprob: number;
  readonly noSpeechProb: number;
  readonly snrDb: number;
  /** performance.now() at which the VAD declared the utterance over. */
  readonly tSpeechEnd: number;
  /** performance.now() at which the final transcript became available. */
  readonly tAsrDone: number;
  readonly decodeMs: number;
  readonly audioMs: number;
  /** True if this came from a partial decode and may still be corrected. */
  readonly isProvisional: boolean;
}

export interface SessionEvents {
  onStateChange?: (state: MicState, detail?: string) => void;
  onLevel?: (rms: number) => void;
  onSpeechStart?: (atMs: number) => void;
  /** Fast path: fires at t_speech_end using the most recent partial decode. */
  onProvisional?: (utterance: Utterance) => void;
  /** Authoritative path: fires when the full-utterance decode completes. */
  onUtterance?: (utterance: Utterance) => void;
  onError?: (error: Error) => void;
}

export class ListeningSession {
  private readonly mic: MicrophoneCapture;
  private readonly vad = new VadEngine();
  private readonly asr: AsrEngine;
  private readonly events: SessionEvents;

  /** Samples captured since the current utterance began. */
  private utteranceSamples: Float32Array[] = [];
  private speaking = false;
  private tSpeechStart = 0;

  /** Most recent partial decode, used for the fast path at speech end. */
  private lastPartial: AsrDecodeResult | null = null;
  private partialInFlight = false;
  private lastPartialAt = 0;

  constructor(events: SessionEvents = {}, asr: AsrEngine = new AsrEngine()) {
    this.events = events;
    this.asr = asr;

    this.mic = new MicrophoneCapture({
      onStateChange: (state, detail) => this.events.onStateChange?.(state, detail),
      onFrame: (frame, atMs) => this.handleFrame(frame, atMs),
    });

    this.vad.onEvent((event) => this.handleVadEvent(event));
  }

  get micState(): MicState {
    return this.mic.state;
  }

  get isLive(): boolean {
    return this.mic.isLive;
  }

  /** Loads Whisper weights before opening the mic, so the first word isn't missed. */
  async init(): Promise<void> {
    await this.asr.init();
  }

  async start(): Promise<void> {
    await this.init();
    await this.mic.start();
  }

  async stop(): Promise<void> {
    await this.mic.stop();
    this.utteranceSamples = [];
    this.lastPartial = null;
    this.speaking = false;
  }

  setDomainTerms(terms: readonly string[]): void {
    this.asr.setDomainTerms(terms);
  }

  private handleFrame(frame: Float32Array, atMs: number): void {
    this.vad.processFrame(frame, atMs);

    if (this.speaking) {
      this.utteranceSamples.push(frame);
      this.maybeRunPartialDecode(atMs);
    }
  }

  private handleVadEvent(event: VadEvent): void {
    switch (event.type) {
      case "level":
        this.events.onLevel?.(event.rms);
        break;

      case "speechStart":
        this.speaking = true;
        this.tSpeechStart = event.at;
        this.utteranceSamples = [];
        this.lastPartial = null;
        this.lastPartialAt = 0;
        this.events.onSpeechStart?.(event.at);
        break;

      case "speechEnd":
        this.speaking = false;
        void this.finishUtterance(event.at, event.snrDb);
        break;
    }
  }

  /**
   * Kicks off a trailing partial decode if one is not already running.
   *
   * Never queues more than one decode at a time. Whisper decodes are hundreds of
   * milliseconds; allowing them to pile up would consume the CPU the final
   * decode needs and make latency worse than doing nothing.
   */
  private maybeRunPartialDecode(nowMs: number): void {
    if (this.partialInFlight) return;
    if (nowMs - this.lastPartialAt < CONFIG.asr.CHUNK_INTERVAL_MS) return;

    const audioMs = (this.currentSampleCount() / CONFIG.audio.SAMPLE_RATE) * 1000;
    if (audioMs < CONFIG.audio.MIN_SPEECH_MS) return;

    this.partialInFlight = true;
    this.lastPartialAt = nowMs;

    const snapshot = this.concatUtterance();
    void this.asr
      .transcribe(snapshot)
      .then((result) => {
        // Discard if the utterance ended while this was in flight; the final
        // decode supersedes it.
        if (this.speaking) this.lastPartial = result;
      })
      .catch((err) => this.events.onError?.(toError(err)))
      .finally(() => {
        this.partialInFlight = false;
      });
  }

  private currentSampleCount(): number {
    let n = 0;
    for (const f of this.utteranceSamples) n += f.length;
    return n;
  }

  private concatUtterance(): Float32Array {
    const total = this.currentSampleCount();
    const out = new Float32Array(total);
    let offset = 0;
    for (const frame of this.utteranceSamples) {
      out.set(frame, offset);
      offset += frame.length;
    }
    return out;
  }

  private async finishUtterance(tSpeechEnd: number, snrDb: number): Promise<void> {
    const pcm = this.concatUtterance();
    this.utteranceSamples = [];

    if (pcm.length === 0) return;

    // Fast path — emit whatever the last partial decode produced, immediately.
    if (this.lastPartial && this.lastPartial.text.length > 0) {
      this.events.onProvisional?.({
        text: this.lastPartial.text,
        meanLogprob: this.lastPartial.meanLogprob,
        noSpeechProb: this.lastPartial.noSpeechProb,
        snrDb,
        tSpeechEnd,
        tAsrDone: performance.now(),
        decodeMs: this.lastPartial.decodeMs,
        audioMs: this.lastPartial.audioMs,
        isProvisional: true,
      });
    }

    // Authoritative path — full-utterance decode.
    try {
      const result = await this.asr.transcribe(pcm);
      this.events.onUtterance?.({
        text: result.text,
        meanLogprob: result.meanLogprob,
        noSpeechProb: result.noSpeechProb,
        snrDb,
        tSpeechEnd,
        tAsrDone: performance.now(),
        decodeMs: result.decodeMs,
        audioMs: result.audioMs,
        isProvisional: false,
      });
    } catch (err) {
      this.events.onError?.(toError(err));
    } finally {
      this.lastPartial = null;
    }
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
