/**
 * Real sentence-embedding service for KRONOS (LLD.md §3, SPEC.md §2).
 *
 * Runs the actual all-MiniLM-L6-v2 transformer (int8-quantised ONNX) via
 * transformers.js, with mean pooling over the token dimension and L2
 * normalisation, which is the pooling scheme the model was trained under.
 *
 * Isomorphic by construction: the same class runs in Node (ingest + eval) and
 * in the browser worker (query time). Both load weights from the same vendored
 * files, so a vector produced at ingest and a vector produced at query time are
 * directly comparable. That property is load-bearing — the index is built once,
 * offline, and searched later in a different runtime.
 *
 * NETWORK: `allowRemoteModels` is false. If the vendored weights are missing,
 * this throws rather than silently reaching out to huggingface.co. A product
 * whose entire pitch is "documents never leave the machine" must not have a
 * quiet fallback that phones home.
 */

import { CONFIG, EMBEDDING_FINGERPRINT, MODEL_FINGERPRINTS } from "@kronos/core";

export interface EmbeddingService {
  init(): Promise<void>;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  fingerprint(): string;
  readonly dimensions: number;
}

export interface EmbedderOptions {
  /**
   * Directory containing the vendored model repos.
   * Node: a filesystem path (default: apps/web/public/models).
   * Browser: a same-origin URL prefix, e.g. "/models".
   */
  readonly modelPath?: string;
  /** Emit per-batch progress during long ingest runs. */
  readonly onProgress?: (done: number, total: number) => void;
}

const MODEL_ID = MODEL_FINGERPRINTS.embedding.repo;

function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    process.versions != null &&
    process.versions.node != null
  );
}

/** Default location of the vendored weights when running under Node. */
function defaultNodeModelPath(): string {
  // packages/retrieval/src/ -> repo root -> apps/web/public/models
  const here = new URL(".", import.meta.url).pathname;
  return new URL("../../../apps/web/public/models/", `file://${here}`).pathname;
}

export class MiniLmEmbedder implements EmbeddingService {
  readonly dimensions = CONFIG.embedding.DIMENSIONS;

  private extractor: unknown = null;
  private initPromise: Promise<void> | null = null;
  private readonly modelPath: string;
  private readonly onProgress?: (done: number, total: number) => void;

  constructor(options: EmbedderOptions = {}) {
    this.modelPath =
      options.modelPath ?? (isNode() ? defaultNodeModelPath() : "/models");
    this.onProgress = options.onProgress;
  }

  fingerprint(): string {
    return EMBEDDING_FINGERPRINT;
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");

      // Zero egress: weights must come from the vendored directory, never the hub.
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = this.modelPath;
      if (env.backends?.onnx?.wasm) {
        // Single-threaded WASM avoids requiring cross-origin isolation purely for
        // the embedder; COOP/COEP are still set for SharedArrayBuffer in audio.
        env.backends.onnx.wasm.numThreads = 1;
      }

      this.extractor = await pipeline("feature-extraction", MODEL_ID, {
        quantized: true,
      });
    })();

    return this.initPromise;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();

    const extract = this.extractor as (
      input: string[],
      opts: { pooling: "mean"; normalize: boolean }
    ) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

    const out: Float32Array[] = [];
    const batchSize = CONFIG.embedding.INGEST_BATCH;

    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize).map(normaliseForEmbedding);

      const result = await extract(batch, { pooling: "mean", normalize: true });
      const dim = result.dims[result.dims.length - 1];

      if (dim !== this.dimensions) {
        throw new Error(
          `Embedding dimension mismatch: model produced ${dim}, expected ${this.dimensions}`
        );
      }

      for (let i = 0; i < batch.length; i++) {
        const slice = (result.data as Float32Array).slice(i * dim, (i + 1) * dim);
        out.push(Float32Array.from(slice));
      }

      this.onProgress?.(Math.min(start + batchSize, texts.length), texts.length);
    }

    return out;
  }
}

/**
 * Whitespace-normalises text before embedding.
 *
 * Deliberately conservative: no stemming, no stopword removal, no lowercasing.
 * MiniLM's WordPiece tokenizer handles casing itself, and legal text carries
 * meaning in capitalisation ("Confidential Information" as a defined term vs.
 * the same words used descriptively) that aggressive preprocessing destroys.
 *
 * Truncation to the model's 512-token window happens inside the tokenizer and
 * affects the embedding input ONLY. Chunk.text is never mutated — a user must
 * never be shown a clause that stops mid-sentence (LLD.md §2.2).
 */
function normaliseForEmbedding(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
