/**
 * Moss integration seam (SPEC.md §10.1).
 *
 * STATUS: NOT WIRED. No Moss SDK is installed, and KRONOS does not currently use
 * Moss for retrieval.
 *
 * This is deliberate and disclosed rather than faked. As of this commit no Moss
 * vector-search SDK is resolvable from the public npm registry (the package
 * named `moss` is an unrelated terminal music player). Access must come from the
 * hackathon organisers. Until it does, shipping a class called `MossIndex` that
 * is secretly a hand-rolled cosine loop would misrepresent the sponsor's
 * technology to the people judging it.
 *
 * SPEC.md §10.1 promised that adopting Moss would change exactly one file. This
 * is that file. To wire it:
 *
 *   1. pnpm --filter @kronos/retrieval add <the-moss-package>
 *   2. Implement the four marked TODOs below against the SDK.
 *   3. Set KRONOS_VECTOR_BACKEND=moss (Node) or ?backend=moss (browser).
 *
 * Nothing else in the codebase imports a Moss symbol; everything depends only on
 * the VectorIndex interface, so the swap is genuinely local to this file.
 */

import { Chunk, SearchHit } from "@kronos/core";
import { FlatVectorIndex, VectorIndex } from "./vector-index.js";

export class MossSdkUnavailableError extends Error {
  readonly code = "MOSS_SDK_UNAVAILABLE";
  constructor() {
    super(
      "Moss backend requested but no Moss SDK is installed. " +
        "KRONOS is running on the exact flat in-tab index instead. " +
        "See packages/retrieval/src/moss-adapter.ts for the integration steps."
    );
    this.name = "MossSdkUnavailableError";
  }
}

/**
 * Skeleton adapter. Every method throws until the SDK is present, so there is no
 * way to accidentally ship this while believing Moss is doing the work.
 */
export class MossIndex implements VectorIndex {
  readonly backendName = "moss (NOT WIRED)";
  readonly size = 0;
  readonly dimensions = 0;
  readonly lastQueryMs = 0;

  async load(_artifact: ArrayBuffer | Uint8Array): Promise<void> {
    // TODO(moss): hand the packed vector block to the SDK's index loader.
    throw new MossSdkUnavailableError();
  }

  async search(_vector: Float32Array, _k: number): Promise<SearchHit[]> {
    // TODO(moss): single-query search; time it with performance.now() around the
    // call only, excluding embedding (SPEC.md §10.3).
    throw new MossSdkUnavailableError();
  }

  async searchBatch(_vectors: readonly Float32Array[], _k: number): Promise<SearchHit[][]> {
    // TODO(moss): use native multi-query if the SDK exposes it — one call for the
    // four expansions beats four calls. Otherwise loop search(). (SPEC.md §10.2)
    throw new MossSdkUnavailableError();
  }

  getChunk(_chunkId: string): Chunk | undefined {
    // TODO(moss): chunk metadata stays on our side; the SDK only holds vectors.
    throw new MossSdkUnavailableError();
  }

  getAllChunks(): readonly Chunk[] {
    throw new MossSdkUnavailableError();
  }
}

export type VectorBackend = "flat" | "moss";

export function isMossAvailable(): boolean {
  return false;
}

/**
 * Selects the retrieval backend.
 *
 * Requesting "moss" throws loudly rather than silently degrading to flat search.
 * A silent fallback is how you end up reporting "Moss: 0.4 ms" for a loop that
 * never touched Moss.
 */
export function createVectorIndex(backend: VectorBackend = "flat"): VectorIndex {
  if (backend === "moss") {
    if (!isMossAvailable()) throw new MossSdkUnavailableError();
    return new MossIndex();
  }
  return new FlatVectorIndex();
}
