/**
 * Composite Confidence Gate for KRONOS (PRD.md §8, SPEC.md §8, LLD.md §10.5)
 *
 * Combines ASR token logprob, input SNR dB, top-1 similarity score, and rank-1/rank-2 margin
 * to drive three deterministic display states: Green, Amber, Red.
 * Calibrated for false-confident rate <= 5%.
 */

import { CONFIG, GateState, QueryInput, RankedResult } from "@kronos/core";

function sigmoid(x: number, centre = -0.8): number {
  return 1 / (1 + Math.exp(-(x - centre) * 3.0));
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export interface GateVerdict {
  readonly state: GateState;
  readonly composite: number;
  readonly reason: string;
}

export class ConfidenceGate {
  evaluatePreRetrieval(input: QueryInput): GateVerdict {
    if (!input.transcript || input.transcript.trim().length < 3) {
      return { state: "red", composite: 0, reason: "empty_transcript" };
    }
    if (input.asrNoSpeechProb > CONFIG.asr.NO_SPEECH_THRESHOLD) {
      return { state: "red", composite: 0, reason: "no_speech_detected" };
    }
    const asrConf = sigmoid(input.asrMeanLogprob, -0.8);
    if (asrConf < 0.25) {
      return { state: "red", composite: asrConf, reason: "asr_confidence_below_floor" };
    }
    return { state: "green", composite: asrConf, reason: "proceed" };
  }

  evaluate(input: QueryInput, results: readonly RankedResult[]): GateVerdict {
    const pre = this.evaluatePreRetrieval(input);
    if (pre.state === "red") return pre;

    if (results.length === 0) {
      return { state: "amber", composite: 0.2, reason: "no_candidates_retrieved" };
    }

    const top1Score = results[0].fusedScore * 20; // Scale RRF score to cosine-equivalent range [0, 1]
    const top2Score = results.length > 1 ? results[1].fusedScore * 20 : top1Score * 0.5;
    const rawMargin = Math.max(0, top1Score - top2Score);

    const asrConf = sigmoid(input.asrMeanLogprob, -0.8);
    const snrConf = clamp((input.snrDb - 6) / 18, 0, 1);
    const simConf = clamp((top1Score - 0.15) / 0.35, 0, 1);
    const marginConf = clamp(rawMargin / 0.08, 0, 1);

    const composite =
      CONFIG.confidence.W_ASR * asrConf +
      CONFIG.confidence.W_SNR * snrConf +
      CONFIG.confidence.W_SIM * simConf +
      CONFIG.confidence.W_MARGIN * marginConf;

    const rounded = Number(clamp(composite, 0, 0.99).toFixed(2));

    if (rounded >= CONFIG.confidence.C_AMBER) {
      return { state: "green", composite: rounded, reason: "confident_match" };
    }

    return {
      state: "amber",
      composite: rounded,
      reason: rounded < 0.4 ? "weak_similarity_match" : "narrow_rank_margin",
    };
  }
}
