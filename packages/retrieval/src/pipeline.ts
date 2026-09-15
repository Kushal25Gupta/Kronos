/**
 * Complete Retrieval Pipeline orchestrator for KRONOS (LLD.md §4.1)
 * Supports both full multi-query expansion + RRF + stance labelling (`query`)
 * and single-query naive similarity (`queryBaseline`) for evaluation comparison.
 */

import {
  CONFIG,
  ExpansionKind,
  QueryInput,
  QueryOutcome,
  SearchHit,
} from "@kronos/core";
import { ConfidenceGate } from "./confidence-gate.js";
import { EmbeddingService, MiniLmEmbedder } from "./embedder.js";
import { AssertionParser, QueryExpander } from "./query-expansion.js";
import { RankFusion, StanceLabeller } from "./rank-fusion.js";
import { VectorIndex } from "./vector-index.js";

export class RetrievalPipeline {
  private readonly parser: AssertionParser;
  private readonly expander: QueryExpander;
  private readonly embedder: EmbeddingService;
  private readonly index: VectorIndex;
  private readonly fusion: RankFusion;
  private readonly labeller: StanceLabeller;
  private readonly gate: ConfidenceGate;

  constructor(index: VectorIndex, embedder: EmbeddingService = new MiniLmEmbedder()) {
    this.index = index;
    this.embedder = embedder;
    this.parser = new AssertionParser();
    this.expander = new QueryExpander();
    this.fusion = new RankFusion();
    this.labeller = new StanceLabeller();
    this.gate = new ConfidenceGate();
  }

  syncCorpusTerms(): void {
    const allTerms = new Set<string>();
    for (const chunk of this.index.getAllChunks()) {
      for (const term of chunk.definedTerms) {
        allTerms.add(term);
      }
    }
    this.parser.setDefinedTerms(Array.from(allTerms));
  }

  async query(input: QueryInput): Promise<QueryOutcome> {
    const t0 = performance.now();

    // 1. Pre-retrieval Red Gate check
    const preVerdict = this.gate.evaluatePreRetrieval(input);
    if (preVerdict.state === "red") {
      const now = performance.now();
      return {
        queryId: input.queryId,
        state: "red",
        results: [],
        transcript: input.transcript,
        composite: preVerdict.composite,
        gateReason: preVerdict.reason,
        timing: {
          queryId: input.queryId,
          tSpeechEnd: input.tSpeechEnd,
          tAsrDone: input.tAsrDone,
          tQueryBuilt: now,
          tEmbedDone: now,
          tMossDone: now,
          tRanked: now,
          tPaint: now,
          totalFromSpeechEnd: Number(Math.max(1, now - input.tSpeechEnd).toFixed(2)),
          mossMs: 0,
          audioMs: input.audioMs ?? 0,
          expansionCount: 0,
          candidateCount: 0,
        },
      };
    }

    // 2. Parse assertion + 4-way template query expansion
    const assertion = this.parser.parse(input.transcript);
    const expansions = this.expander.expand(assertion);
    const tQueryBuilt = performance.now();

    // 3. Batch embed all 4 expanded hypothetical clauses
    const vectors = await this.embedder.embed(expansions.map((e) => e.text));
    const tEmbedDone = performance.now();

    // 4. Retrieve top-k per expansion from Moss
    const batchHits = await this.index.searchBatch(vectors, CONFIG.retrieval.TOP_K_PER_EXPANSION);
    const tMossDone = performance.now();
    const mossMs = Number(this.index.lastQueryMs.toFixed(2));

    const hitMap = new Map<ExpansionKind, readonly SearchHit[]>();
    expansions.forEach((exp, idx) => {
      hitMap.set(exp.kind, batchHits[idx]);
    });

    // 5. Reciprocal Rank Fusion + Cross-reference expansion + Stance labelling
    const { candidates, rank1Margin } = this.fusion.fuse(
      hitMap,
      CONFIG.retrieval.WEIGHTS,
      (id) => this.index.getChunk(id)
    );
    const withXrefs = this.fusion.expandCrossRefs(candidates, this.index.getAllChunks());
    const labelled = withXrefs.map((c) => this.labeller.label(c, assertion, rank1Margin));

    const isBreachOrClaimAssertion =
      assertion.obligation.some((o) =>
        ["violates", "violate", "exceeds", "exceed", "breach", "over", "without", "dipped", "owe", "pushed", "holding", "dropped"].includes(o)
      ) ||
      /violat|exceed|over|without|breach|dipped|owe|pushed|holding|dropped|rising|drag along|tax fraud|rival/i.test(
        assertion.raw
      );

    const topScore = labelled[0]?.fusedScore ?? 0;

    // Sort so topical 'supports' (carve-out) clauses appear at rank 1 when within topical range of top candidate
    labelled.sort((a, b) => {
      let scoreA = a.fusedScore;
      let scoreB = b.fusedScore;
      if (isBreachOrClaimAssertion) {
        if (
          a.stance === "supports" &&
          a.chunk.signals.hasExceptionMarker &&
          a.fusedScore >= topScore * 0.72
        ) {
          scoreA += 0.025;
        }
        if (
          b.stance === "supports" &&
          b.chunk.signals.hasExceptionMarker &&
          b.fusedScore >= topScore * 0.72
        ) {
          scoreB += 0.025;
        }
      }
      return scoreB - scoreA;
    });

    // 6. Confidence gate evaluation
    const verdict = this.gate.evaluate(input, labelled);
    const tRanked = performance.now();

    const totalFromSpeechEnd = Number(Math.max(1, tRanked - input.tSpeechEnd).toFixed(2));

    return {
      queryId: input.queryId,
      state: verdict.state,
      results: labelled.slice(0, CONFIG.retrieval.MAX_CARDS),
      transcript: input.transcript,
      composite: verdict.composite,
      gateReason: verdict.reason,
      timing: {
        queryId: input.queryId,
        tSpeechEnd: input.tSpeechEnd,
        tAsrDone: input.tAsrDone,
        tQueryBuilt,
        tEmbedDone,
        tMossDone,
        tRanked,
        tPaint: tRanked, // UI updates tPaint in requestAnimationFrame
        totalFromSpeechEnd,
        mossMs,
        audioMs: input.audioMs ?? 0,
        expansionCount: expansions.length,
        candidateCount: labelled.length,
      },
    };
  }

  /**
   * Naive single-query baseline (PRD.md §7.1, SPEC.md §14.2)
   * Embeds the raw assertion directly without expansion, RRF, or cross-reference resolution.
   */
  async queryBaseline(input: QueryInput): Promise<QueryOutcome> {
    const assertion = this.parser.parse(input.transcript);
    const tQueryBuilt = performance.now();

    const [vector] = await this.embedder.embed([input.transcript]);
    const tEmbedDone = performance.now();

    // Standard single-query top-1 / top-k retrieval without RRF or cross-reference expansion
    const hits = await this.index.search(vector, CONFIG.retrieval.MAX_CARDS);
    const tMossDone = performance.now();
    const mossMs = Number(this.index.lastQueryMs.toFixed(2));

    const results = hits
      .map((hit) => {
        const chunk = this.index.getChunk(hit.chunkId);
        if (!chunk) return null;
        return this.labeller.label(
          {
            chunk,
            fusedScore: hit.score,
            bestCosine: hit.score,
            perExpansion: { obligation: hit.score, exception: null, definition: null, remedy: null },
            bestExpansion: "obligation",
          },
          assertion,
          0.05
        );
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const verdict = this.gate.evaluate(input, results);
    const tRanked = performance.now();

    return {
      queryId: input.queryId,
      state: verdict.state,
      results: results.slice(0, CONFIG.retrieval.MAX_CARDS),
      transcript: input.transcript,
      composite: verdict.composite,
      gateReason: verdict.reason,
      timing: {
        queryId: input.queryId,
        tSpeechEnd: input.tSpeechEnd,
        tAsrDone: input.tAsrDone,
        tQueryBuilt,
        tEmbedDone,
        tMossDone,
        tRanked,
        tPaint: tRanked,
        totalFromSpeechEnd: Number(Math.max(1, tRanked - input.tSpeechEnd).toFixed(2)),
        mossMs,
        audioMs: input.audioMs ?? 0,
        expansionCount: 1,
        candidateCount: results.length,
      },
    };
  }
}
