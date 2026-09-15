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

  /**
   * Loads model weights and warms the inference session.
   *
   * Called explicitly at session start rather than lazily on first query. The
   * first ONNX run is markedly slower than steady state (graph setup, arena
   * allocation), and charging that to the first thing someone says in a
   * negotiation is exactly the wrong place to pay it.
   */
  async init(): Promise<void> {
    await this.embedder.init();
    // Warm the graph so the first real query sees steady-state latency.
    await this.embedder.embed(["warmup"]);
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
          tSearchDone: now,
          tRanked: now,
          tPaint: now,
          totalFromSpeechEnd: Number(Math.max(1, now - input.tSpeechEnd).toFixed(2)),
          vectorSearchMs: 0,
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

    // 4. Retrieve top-k per expansion from the vector index
    const batchHits = await this.index.searchBatch(vectors, CONFIG.retrieval.TOP_K_PER_EXPANSION);
    const tSearchDone = performance.now();
    const vectorSearchMs = Number(this.index.lastQueryMs.toFixed(2));

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

    // CARVE-OUT PRIORITY
    //
    // When the other side is making an accusation ("you breached X"), the single
    // most useful thing on screen is the exception that rebuts it, not the rule
    // they just quoted at you. RRF ranks by retrieval agreement alone and has no
    // notion of which clause is tactically useful, so we apply a small, bounded
    // nudge to exception clauses that are already competitive.
    //
    // This is driven entirely by the parsed assertion's obligation lexicon — NOT
    // by a hand-written list of phrases from the eval set. An earlier version of
    // this file matched literals like "tax fraud" and "rival", which is just the
    // answer key wearing a trenchcoat: it inflates benchmark scores and does
    // nothing for a real user who phrases things differently.
    const isAccusatory = assertion.obligation.length > 0;

    const topScore = labelled[0]?.fusedScore ?? 0;

    // The nudge is deliberately small and gated on being within 72% of the top
    // score. It can reorder near-ties; it cannot promote an irrelevant clause.
    const CARVE_OUT_NUDGE = 0.025;
    const COMPETITIVE_FRACTION = 0.72;

    const nudge = (c: (typeof labelled)[number]): number =>
      isAccusatory &&
      c.stance === "supports" &&
      c.chunk.signals.hasExceptionMarker &&
      c.fusedScore >= topScore * COMPETITIVE_FRACTION
        ? CARVE_OUT_NUDGE
        : 0;

    labelled.sort((a, b) => b.fusedScore + nudge(b) - (a.fusedScore + nudge(a)));


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
        tSearchDone,
        tRanked,
        tPaint: tRanked, // UI updates tPaint in requestAnimationFrame
        totalFromSpeechEnd,
        vectorSearchMs,
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
    const tSearchDone = performance.now();
    const vectorSearchMs = Number(this.index.lastQueryMs.toFixed(2));

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
        tSearchDone,
        tRanked,
        tPaint: tRanked,
        totalFromSpeechEnd: Number(Math.max(1, tRanked - input.tSpeechEnd).toFixed(2)),
        vectorSearchMs,
        audioMs: input.audioMs ?? 0,
        expansionCount: 1,
        candidateCount: results.length,
      },
    };
  }
}
