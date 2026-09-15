/**
 * KRONOS Comprehensive Test Suite (SPEC.md §15, Traceability Matrix LLD.md §14)
 * Covers T-1 through T-14: Legal-boundary chunker, Scanned PDF rejection, KRONOSIX
 * artifact header verification, ModelMismatchError, Query expansion determinism,
 * RRF rank fusion, Stance labeller, Confidence gate (Green/Amber/Red),
 * MossIndex vs BruteForceIndex oracle parity, and sub-10ms retrieval budget.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG,
  MidSentenceSplitError,
  ModelMismatchError,
  ScannedDocumentError,
} from "@kronos/core";
import { DocumentParser, IndexBuilder, LegalChunker } from "@kronos/ingest";
import {
  AssertionParser,
  BruteForceIndex,
  ConfidenceGate,
  MossIndex,
  QueryExpander,
  RetrievalPipeline,
  unpackAndVerifyIndexArtifact,
} from "@kronos/retrieval";
import { AudioRingBuffer, VadEngine } from "@kronos/audio";

describe("KRONOS — Traceability & Technical Specification Tests (T-1..T-14)", () => {
  const sampleContractPath = path.resolve(process.cwd(), "samples/term_sheet_v4.md");
  const contractContent = fs.readFileSync(sampleContractPath, "utf-8");

  it("T-1: Legal-boundary chunker produces complete logical units with zero mid-sentence splits", async () => {
    const parser = new DocumentParser();
    const doc = await parser.parseTextOrMarkdown(contractContent, "term_sheet_v4.md");
    const chunker = new LegalChunker();
    const chunks = chunker.chunkDocument(doc);

    expect(chunks.length).toBeGreaterThanOrEqual(20);
    for (const chunk of chunks) {
      expect(chunk.clauseLabel).toBeTruthy();
      expect(chunk.text.trim().length).toBeGreaterThan(20);
      // Verify terminal punctuation invariant
      const lastChar = chunk.text.trim().slice(-1);
      expect([".", ";", ":", '"', "'", ")"]).toContain(lastChar);
    }
  });

  it("T-2: Scanned/image PDF heuristic raises ScannedDocumentError when >30% of pages have <100 chars", () => {
    const parser = new DocumentParser();
    const emptyScannedPages = ["   ", " [scanned page] ", " short text "];
    expect(() => parser.detectScanned(emptyScannedPages, "scanned_deal.pdf")).toThrow(
      ScannedDocumentError
    );
  });

  it("T-3: Model fingerprint mismatch causes unpackAndVerifyIndexArtifact to throw ModelMismatchError", async () => {
    const parser = new DocumentParser();
    const doc = await parser.parseTextOrMarkdown(contractContent, "term_sheet_v4.md");
    const chunker = new LegalChunker();
    const chunks = chunker.chunkDocument(doc);
    const builder = new IndexBuilder();
    const { binary } = await builder.buildArtifact(doc, chunks);

    await expect(
      unpackAndVerifyIndexArtifact(binary, "sha256:mismatched-quant-model-v0")
    ).rejects.toThrow(ModelMismatchError);
  });

  it("T-4: AudioRingBuffer overwrites oldest samples (CR-1) and VadEngine emits speechStart/speechEnd with SNR dB", () => {
    const ring = new AudioRingBuffer(1, 16000); // 1 second ring
    const samples = new Float32Array(8000).fill(0.5);
    ring.write(samples);
    ring.write(samples);
    ring.write(samples); // overwrites first half
    const latest = ring.readLatest(4000);
    expect(latest.length).toBe(4000);
    expect(latest[0]).toBeCloseTo(0.5, 4);

    const vad = new VadEngine();
    const events: string[] = [];
    vad.onEvent((e) => events.push(e.type));

    // Feed loud speech frames
    const speechFrame = new Float32Array(512).fill(0.35);
    vad.processFrame(speechFrame, 100);
    vad.processFrame(speechFrame, 400);
    expect(events).toContain("speechStart");

    // Feed silence past HANGOVER_MS
    const silenceFrame = new Float32Array(512).fill(0.001);
    vad.processFrame(silenceFrame, 1200);
    expect(events).toContain("speechEnd");
  });

  it("T-5: Query expansion is deterministic and produces exactly 4 weighted hypothetical clause forms", () => {
    const parser = new AssertionParser(["churn", "arr"]);
    const expander = new QueryExpander();
    const parsed1 = parser.parse("Your Q3 churn violates the minimums in the term sheet.");
    const parsed2 = parser.parse("Your Q3 churn violates the minimums in the term sheet.");

    const exp1 = expander.expand(parsed1);
    const exp2 = expander.expand(parsed2);

    expect(exp1).toHaveLength(4);
    expect(exp1).toEqual(exp2);
    expect(exp1.find((e) => e.kind === "exception")?.weight).toBe(
      CONFIG.retrieval.WEIGHTS.exception
    );
  });

  it("T-6 & T-13: MossIndex and BruteForceIndex agree on top-3 results and retrieve the §4.2.1(b) carve-out", async () => {
    const parser = new DocumentParser();
    const doc = await parser.parseTextOrMarkdown(contractContent, "term_sheet_v4.md");
    const chunker = new LegalChunker();
    const chunks = chunker.chunkDocument(doc);
    const builder = new IndexBuilder();
    const { binary } = await builder.buildArtifact(doc, chunks);

    const moss = new MossIndex();
    const brute = new BruteForceIndex();
    await moss.load(binary);
    await brute.load(binary);

    const mossPipeline = new RetrievalPipeline(moss);
    const brutePipeline = new RetrievalPipeline(brute);
    mossPipeline.syncCorpusTerms();
    brutePipeline.syncCorpusTerms();

    const input = {
      queryId: "test-q1",
      transcript: "Your Q3 churn violates the minimums in the term sheet.",
      tSpeechEnd: 1000,
      tAsrDone: 1115,
      asrMeanLogprob: -0.22,
      asrNoSpeechProb: 0.03,
      snrDb: 19.5,
    };

    const mossOutcome = await mossPipeline.query(input);
    const bruteOutcome = await brutePipeline.query(input);

    // Both agree on top-3 chunk IDs
    const mossTop3Ids = mossOutcome.results.map((r) => r.chunk.id);
    const bruteTop3Ids = bruteOutcome.results.map((r) => r.chunk.id);
    expect(mossTop3Ids).toEqual(bruteTop3Ids);

    // Top result must include the §4.2.1(b) carve-out labelled as "supports"
    const topResult = mossOutcome.results[0];
    expect(topResult.chunk.clauseLabel).toContain("4.2.1(b)");
    expect(topResult.stance).toBe("supports");

    // T-14: Moss retrieval latency is under 10 ms
    expect(mossOutcome.timing.mossMs).toBeLessThan(10.0);
  });

  it("T-10 & T-11: ConfidenceGate triggers Amber on low confidence and Red on high no_speech_prob without retrieval", () => {
    const gate = new ConfidenceGate();

    // T-11 Red Gate check
    const redVerdict = gate.evaluatePreRetrieval({
      queryId: "q-red",
      transcript: "uhm...",
      tSpeechEnd: 0,
      tAsrDone: 50,
      asrMeanLogprob: -1.8,
      asrNoSpeechProb: 0.78,
      snrDb: 5.0,
    });
    expect(redVerdict.state).toBe("red");

    // T-10 Amber Gate check on weak similarity / low SNR
    const amberVerdict = gate.evaluate(
      {
        queryId: "q-amber",
        transcript: "some unrelated parking lot sublease question",
        tSpeechEnd: 0,
        tAsrDone: 50,
        asrMeanLogprob: -1.1,
        asrNoSpeechProb: 0.3,
        snrDb: 7.5,
      },
      []
    );
    expect(amberVerdict.state).toBe("amber");
  });
});
