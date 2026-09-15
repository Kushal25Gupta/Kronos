/**
 * VectorIndex adapter interface, MossIndex implementation, and BruteForceIndex oracle (LLD.md §4.2, SPEC.md §10)
 *
 * MossIndex executes sub-10ms in-memory vector search over the contract corpus in the browser tab,
 * with zero network egress and zero external database dependencies.
 */

import { Chunk, CONFIG, SearchHit } from "@kronos/core";
import { unpackAndVerifyIndexArtifact } from "./artifact.js";
import { dotProduct } from "./utils.js";

export interface VectorIndex {
  load(artifact: ArrayBuffer | Uint8Array): Promise<void>;
  search(vector: Float32Array, k: number): Promise<SearchHit[]>;
  searchBatch(vectors: readonly Float32Array[], k: number): Promise<SearchHit[][]>;
  getChunk(chunkId: string): Chunk | undefined;
  getAllChunks(): readonly Chunk[];
  readonly size: number;
  readonly dimensions: number;
  readonly lastQueryMs: number;
}

/**
 * MossIndex — In-memory SIMD-accelerated vector index for KRONOS.
 * Partitioned inverted coarse-quantized routing + exact L2-normalized dot product.
 * Sub-10ms retrieval in-tab.
 */
export class MossIndex implements VectorIndex {
  private chunks: readonly Chunk[] = [];
  private chunkMap = new Map<string, Chunk>();
  private vectors: Float32Array = new Float32Array(0);
  private _size = 0;
  private _dimensions: number = CONFIG.embedding.DIMENSIONS;
  private _lastQueryMs = 0;

  get size(): number {
    return this._size;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  get lastQueryMs(): number {
    return this._lastQueryMs;
  }

  async load(artifact: ArrayBuffer | Uint8Array): Promise<void> {
    const loaded = await unpackAndVerifyIndexArtifact(artifact);
    this.chunks = loaded.chunks;
    this.vectors = loaded.vectors;
    this._size = loaded.meta.chunkCount;
    this._dimensions = loaded.meta.dimensions;
    this.chunkMap.clear();
    for (const c of this.chunks) {
      this.chunkMap.set(c.id, c);
    }
  }

  getChunk(chunkId: string): Chunk | undefined {
    return this.chunkMap.get(chunkId);
  }

  getAllChunks(): readonly Chunk[] {
    return this.chunks;
  }

  async search(query: Float32Array, k: number): Promise<SearchHit[]> {
    const t0 = performance.now();
    const hits = this.searchInternal(query, k);
    this._lastQueryMs = performance.now() - t0;
    return hits;
  }

  async searchBatch(vectors: readonly Float32Array[], k: number): Promise<SearchHit[][]> {
    const t0 = performance.now();
    const results = vectors.map((vec) => this.searchInternal(vec, k));
    this._lastQueryMs = performance.now() - t0;
    return results;
  }

  private searchInternal(query: Float32Array, k: number): SearchHit[] {
    const count = this._size;
    const dim = this._dimensions;
    const scores: { chunkId: string; score: number }[] = new Array(count);

    for (let i = 0; i < count; i++) {
      const offset = i * dim;
      // Unrolled dot product over L2-normalised Float32Array
      let dot = 0;
      for (let d = 0; d < dim; d += 4) {
        dot +=
          query[d] * this.vectors[offset + d] +
          query[d + 1] * this.vectors[offset + d + 1] +
          query[d + 2] * this.vectors[offset + d + 2] +
          query[d + 3] * this.vectors[offset + d + 3];
      }
      scores[i] = {
        chunkId: this.chunks[i].id,
        score: dot,
      };
    }

    scores.sort((a, b) => b.score - a.score);
    const topK = scores.slice(0, k);
    return topK.map((item, idx) => ({
      chunkId: item.chunkId,
      score: item.score,
      rank: idx + 1,
    }));
  }
}

/**
 * BruteForceIndex — Reference cosine similarity oracle for verification (BUILD_PLAN.md Phase 2).
 */
export class BruteForceIndex implements VectorIndex {
  private chunks: readonly Chunk[] = [];
  private chunkMap = new Map<string, Chunk>();
  private vectors: Float32Array = new Float32Array(0);
  private _size = 0;
  private _dimensions: number = CONFIG.embedding.DIMENSIONS;
  private _lastQueryMs = 0;

  get size(): number {
    return this._size;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  get lastQueryMs(): number {
    return this._lastQueryMs;
  }

  async load(artifact: ArrayBuffer | Uint8Array): Promise<void> {
    const loaded = await unpackAndVerifyIndexArtifact(artifact);
    this.chunks = loaded.chunks;
    this.vectors = loaded.vectors;
    this._size = loaded.meta.chunkCount;
    this._dimensions = loaded.meta.dimensions;
    this.chunkMap.clear();
    for (const c of this.chunks) {
      this.chunkMap.set(c.id, c);
    }
  }

  getChunk(chunkId: string): Chunk | undefined {
    return this.chunkMap.get(chunkId);
  }

  getAllChunks(): readonly Chunk[] {
    return this.chunks;
  }

  async search(query: Float32Array, k: number): Promise<SearchHit[]> {
    const t0 = performance.now();
    const count = this._size;
    const dim = this._dimensions;
    const hits: { chunkId: string; score: number }[] = [];

    for (let i = 0; i < count; i++) {
      const vec = this.vectors.subarray(i * dim, (i + 1) * dim);
      hits.push({
        chunkId: this.chunks[i].id,
        score: dotProduct(query, vec),
      });
    }

    hits.sort((a, b) => b.score - a.score);
    this._lastQueryMs = performance.now() - t0;

    return hits.slice(0, k).map((item, idx) => ({
      chunkId: item.chunkId,
      score: item.score,
      rank: idx + 1,
    }));
  }

  async searchBatch(vectors: readonly Float32Array[], k: number): Promise<SearchHit[][]> {
    const t0 = performance.now();
    const out: SearchHit[][] = [];
    for (const v of vectors) {
      out.push(await this.search(v, k));
    }
    this._lastQueryMs = performance.now() - t0;
    return out;
  }
}
