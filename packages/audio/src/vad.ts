/**
 * Voice Activity Detection (VAD) and SNR Estimator (SPEC.md §6.2, LLD.md §8.3)
 *
 * Segments continuous speech frames, applies hangover window (HANGOVER_MS = 600),
 * computes SNR dB, and emits speechStart / speechEnd (stamping t_speech_end).
 */

import { CONFIG, VadEvent } from "@kronos/core";

export type VadListener = (event: VadEvent) => void;

export class VadEngine {
  private isSpeaking = false;
  private speechStartTimestamp = 0;
  private lastSpeechFrameTime = 0;
  private speechEnergySum = 0;
  private speechFrameCount = 0;
  private noiseFloorRms = 0.004;
  private listeners: VadListener[] = [];

  onEvent(listener: VadListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  processFrame(frame: Float32Array, nowMs = performance.now()): void {
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      sumSq += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sumSq / frame.length);

    this.emit({ type: "level", rms });

    // Probability heuristic calibrated to Silero VAD behaviour
    const snrRatio = rms / Math.max(1e-5, this.noiseFloorRms);
    const speechProb = Math.min(1.0, Math.max(0.0, (snrRatio - 1.5) / 6.0));

    if (speechProb >= 0.5) {
      this.lastSpeechFrameTime = nowMs;
      this.speechEnergySum += rms;
      this.speechFrameCount++;

      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartTimestamp = nowMs;
        this.emit({ type: "speechStart", at: nowMs });
      }
    } else {
      // Slowly adapt noise floor during non-speech frames
      this.noiseFloorRms = 0.98 * this.noiseFloorRms + 0.02 * Math.max(0.001, rms);

      if (this.isSpeaking) {
        const silenceDuration = nowMs - this.lastSpeechFrameTime;
        const totalDuration = nowMs - this.speechStartTimestamp;

        if (silenceDuration >= CONFIG.audio.HANGOVER_MS || totalDuration >= CONFIG.audio.MAX_UTTERANCE_MS) {
          this.isSpeaking = false;
          const meanSpeechRms =
            this.speechFrameCount > 0 ? this.speechEnergySum / this.speechFrameCount : rms;
          const snrDb = Number(
            Math.max(0, 20 * Math.log10(meanSpeechRms / Math.max(1e-5, this.noiseFloorRms))).toFixed(1)
          );

          if (totalDuration >= CONFIG.audio.MIN_SPEECH_MS) {
            this.emit({
              type: "speechEnd",
              at: nowMs,
              durationMs: Number(totalDuration.toFixed(1)),
              snrDb,
            });
          }

          this.speechEnergySum = 0;
          this.speechFrameCount = 0;
        }
      }
    }
  }

  private emit(event: VadEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
