/**
 * Composite confidence gate for KRONOS (PRD.md §8, SPEC.md §8, LLD.md §10.5).
 *
 * Decides between three display states:
 *   green — show the clauses, we believe they govern the assertion
 *   amber — "No confident match", send the user to the document
 *   red   — "Didn't catch that", we did not hear a usable utterance
 *
 * WHY THIS MATTERS MORE THAN RECALL
 * ---------------------------------
 * An amber costs the user a few seconds: they look it up themselves, which is
 * what they would have done anyway. A confident wrong clause is far worse — it
 * invites someone to argue a live negotiation from a provision that does not say
 * what the panel implied. The gate exists to make the second failure rare, and
 * it is allowed to be conservative to achieve that.
 *
 * A BUG THIS FILE USED TO HAVE
 * ----------------------------
 * The similarity term was previously computed as `results[0].fusedScore * 20`,
 * i.e. from the RRF score. RRF is ordinal: for a chunk ranked first by all four
 * expansions it evaluates to roughly sum(weight)/(k+1) ≈ 0.064 regardless of
 * whether the clause is an excellent match or a terrible one. Multiplied by 20
 * that is 1.28, which saturated the clamp at 1.0 on literally every query. The
 * margin term saturated for the same reason. The gate therefore returned green
 * 50 times out of 50 on the evaluation set and had no ability to decline.
 *
 * The fix is to score similarity from `bestCosine` — the real cosine between the
 * query and the clause — which is the only quantity here that actually carries
 * information about match quality.
 */

import { CONFIG, GateState, QueryInput, RankedResult } from "@kronos/core";

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

/**
 * Maps a Whisper mean log-probability to [0,1].
 * Centred at -0.8, which is around where whisper-tiny output stops being
 * reliably usable on conversational speech.
 */
function asrConfidence(meanLogprob: number): number {
  return 1 / (1 + Math.exp(-(meanLogprob - -0.8) * 3.0));
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
    const asrConf = asrConfidence(input.asrMeanLogprob);
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

    // Real semantic similarity of the best candidate.
    const top1Cosine = results[0].bestCosine;

    const asrConf = asrConfidence(input.asrMeanLogprob);
    const snrConf = clamp((input.snrDb - 6) / 18, 0, 1);

    // Operating range for all-MiniLM-L6-v2 on legal clause text. Measured on
    // this corpus: a genuinely governing clause lands around 0.45-0.65, while an
    // unrelated clause sits near 0.10-0.20. SIM_FLOOR/CEIL bracket that band so
    // the term spans its full range over the region that actually discriminates
    // rather than saturating.
    const SIM_FLOOR = CONFIG.confidence.SIM_FLOOR;
    const SIM_CEIL = CONFIG.confidence.SIM_CEIL;
    const simConf = clamp((top1Cosine - SIM_FLOOR) / (SIM_CEIL - SIM_FLOOR), 0, 1);

    // SIMILARITY IS A NECESSARY CONDITION, NOT JUST A WEIGHTED TERM.
    //
    // With a purely additive score, a crisp recording of a sentence about
    // something the contract does not cover scores 0.30*asr + 0.15*snr ≈ 0.37
    // from audio quality alone, and a small margin contribution can tip that
    // over the line. The panel would then confidently display an unrelated
    // clause because the microphone was good. Audio quality is evidence that we
    // heard the words correctly; it is not evidence that the corpus contains an
    // answer. Below the floor, decline regardless of everything else.
    if (top1Cosine < SIM_FLOOR) {
      return {
        state: "amber",
        composite: Number(clamp(simConf, 0, 0.99).toFixed(2)),
        reason: "weak_similarity_match",
      };
    }

    // Rank margin requires an actual rank 2 to measure against. With a single
    // candidate there is no separation to observe, and treating the absent
    // second result as cosine 0 would manufacture a large margin out of nothing
    // — which is precisely how a lone weak match used to score as unambiguous.
    const MARGIN_CEIL = CONFIG.confidence.MARGIN_CEIL;
    const marginConf =
      results.length > 1
        ? clamp(Math.max(0, top1Cosine - results[1].bestCosine) / MARGIN_CEIL, 0, 1)
        : 0;

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
      reason: simConf < 0.35 ? "weak_similarity_match" : "narrow_rank_margin",
    };
  }
}
