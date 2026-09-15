/**
 * IndexBuilder — Embeds chunks and emits KRONOSIX binary .moss artifact (LLD.md §3, §5)
 */

import { Chunk, IndexArtifactMeta } from "@kronos/core";
import { EmbeddingService, MiniLmEmbedder, packIndexArtifact } from "@kronos/retrieval";
import { ParsedDocument } from "./parse.js";

export class IndexBuilder {
  private readonly embedder: EmbeddingService;

  constructor(embedder: EmbeddingService = new MiniLmEmbedder()) {
    this.embedder = embedder;
  }

  async buildArtifact(
    doc: ParsedDocument,
    chunks: readonly Chunk[]
  ): Promise<{ binary: Uint8Array; meta: IndexArtifactMeta; vectors: Float32Array }> {
    await this.embedder.init();

    // Embedding input = heading trail + clause label + verbatim text.
    //
    // The heading trail matters because clauses are written to be read in
    // context. "Such amounts shall be released within 30 days" is nearly
    // meaningless alone, but under ARTICLE 7 — ESCROW it is clearly about escrow
    // release. Prepending the trail puts that context into the vector.
    //
    // This concatenation is the EMBEDDING INPUT ONLY. chunk.text is stored
    // verbatim and untouched, because that is what gets quoted on screen
    // (LLD.md §2.2).
    const texts = chunks.map((c) => {
      const trail = c.headingTrail.length > 0 ? `${c.headingTrail.join(" > ")} — ` : "";
      return `${trail}${c.clauseLabel} ${c.text}`;
    });

    const embeddings = await this.embedder.embed(texts);

    const dimensions = this.embedder.dimensions;
    const packedVectors = new Float32Array(chunks.length * dimensions);
    embeddings.forEach((vec, idx) => {
      packedVectors.set(vec, idx * dimensions);
    });


    const meta: IndexArtifactMeta = {
      version: 1,
      builtAt: new Date().toISOString(),
      modelFingerprint: this.embedder.fingerprint(),
      dimensions,
      chunkCount: chunks.length,
      docs: [
        {
          id: doc.docId,
          title: doc.title,
          pageCount: doc.pageCount,
          sha256: doc.sha256,
        },
      ],
      chunks,
    };

    const binary = await packIndexArtifact(meta, packedVectors);
    return { binary, meta, vectors: packedVectors };
  }
}
