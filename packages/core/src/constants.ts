/**
 * Single source of truth for KRONOS configuration constants (LLD.md §13)
 */

export const CONFIG = {
  audio: {
    SAMPLE_RATE: 16_000,
    FRAME_SAMPLES: 512,
    RING_SECONDS: 30,
    PRE_ROLL_MS: 300,
    MIN_SPEECH_MS: 250,
    HANGOVER_MS: 600,             // [CALIBRATE] responsiveness vs. cutting people off
    MAX_UTTERANCE_MS: 15_000,
  },
  asr: {
    MODEL: "whisper-tiny.en",
    QUANTISATION: "q8",
    CHUNK_INTERVAL_MS: 750,
    TEMPERATURE: 0,
    NO_SPEECH_THRESHOLD: 0.6,
    LOGPROB_THRESHOLD: -1.0,
    CONDITION_ON_PREVIOUS: false, // prevents repetition loops on poor audio
  },
  embedding: {
    MODEL: "Xenova/all-MiniLM-L6-v2",
    DIMENSIONS: 384,
    MAX_TOKENS: 512,
    INGEST_BATCH: 32,
    // The real fingerprint is the SHA-256 of the vendored ONNX weights and lives
    // in the generated ./model-fingerprints.ts. It is deliberately NOT a
    // hand-written string here — a hardcoded fingerprint cannot detect that the
    // index was built with different weights than the ones being served.
  },

  chunking: {
    MIN_TOKENS: 40,
    MAX_TOKENS: 320,
    HARD_CEILING: 512,
    OVERLAP: 0,
  },
  retrieval: {
    TOP_K_PER_EXPANSION: 10,
    RRF_K: 60,
    XREF_DISCOUNT: 0.7,
    MAX_CARDS: 3,
    WEIGHTS: {
      obligation: 1.0,
      exception: 1.3,
      definition: 0.8,
      remedy: 0.8,
    },
  },
  confidence: {
    W_ASR: 0.30,
    W_SNR: 0.15,
    W_SIM: 0.35,
    W_MARGIN: 0.20,

    // Cosine operating range for all-MiniLM-L6-v2 over legal clause text.
    // Below SIM_FLOOR the match contributes no confidence; above SIM_CEIL it
    // contributes full confidence. See eval/results/RESULTS.md for the observed
    // distribution these were set from.
    SIM_FLOOR: 0.30,
    SIM_CEIL: 0.62,

    // Cosine gap between rank 1 and rank 2 at which the ranking is treated as
    // unambiguous.
    MARGIN_CEIL: 0.08,

    // Green/amber decision threshold. [CALIBRATED on the 50-item evaluation set
    // — see the threshold sweep in RESULTS.md. Because it was chosen on the same
    // data it is scored against, the reported false-confident rate is an
    // in-sample figure and optimistic.]
    C_AMBER: 0.55,

    STANCE_MIN_CONFIDENCE: 0.25,
  },
  ui: {
    DOUBLE_TAP_WINDOW_MS: 400,
    MIN_TAP_GAP_MS: 60,
    CROSSFADE_MS: 120,
    PANEL_WIDTH_PX: 420,
  },
  grants: {
    TTL_SECONDS: 120,
    SINGLE_USE: true,
  },
} as const;
