/**
 * GENERATED FILE — do not edit by hand.
 * Produced by scripts/fetch-models.mjs from the actual vendored ONNX weights in
 * apps/web/public/models/. These are real SHA-256 digests of real model files.
 *
 * If you re-run the fetch script against different model revisions, these values
 * change, every previously built .moss artifact stops verifying, and you must
 * re-run `pnpm ingest`. That is deliberate: a stale index silently paired with
 * different weights produces confident nonsense, which is the single worst
 * failure mode this product can have.
 */

export interface ModelFingerprint {
  readonly repo: string;
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

export const MODEL_FINGERPRINTS = {
  "embedding": {
    "repo": "Xenova/all-MiniLM-L6-v2",
    "file": "onnx/model_quantized.onnx",
    "sha256": "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
    "bytes": 22972370
  },
  "asr": {
    "repo": "Xenova/whisper-tiny.en",
    "file": "onnx/encoder_model_quantized.onnx",
    "sha256": "8cc3c6f8563d1b3fbd2c5af9f64c2bed8b020bc593c402d1ef53b9f08fbf1b90",
    "bytes": 10124913
  }
} as const satisfies Record<string, ModelFingerprint>;

/** Fingerprint stamped into .moss artifacts and checked at load time. */
export const EMBEDDING_FINGERPRINT = `sha256:${MODEL_FINGERPRINTS.embedding.sha256}`;

/** Reported in the debug overlay so the ASR weights in use are identifiable. */
export const ASR_FINGERPRINT = `sha256:${MODEL_FINGERPRINTS.asr.sha256}`;
