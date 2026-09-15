/**
 * KRONOS test suite (SPEC.md §15, traceability matrix LLD.md §14).
 *
 * These tests exercise the real models. They are slower than mocked tests would
 * be, and that is the point: the previous suite passed against a hash function
 * pretending to be a transformer and a function that returned its own input
 * pretending to be a speech recogniser. Tests that cannot tell the difference
 * between a real system and a simulation of one are not protecting anything.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG,
  EMBEDDING_FINGERPRINT,
  ModelMismatchError,
  ScannedDocumentError,
} from "@kronos/core";
import { DocumentParser, IndexBuilder, LegalChunker } from "@kronos/ingest";
import {
  AssertionParser,
  BruteForceIndex,
  ConfidenceGate,
  FlatVectorIndex,
  MiniLmEmbedder,
  MossIndex,
  MossSdkUnavailableError,
  QueryExpander,
  RetrievalPipeline,
  createVectorIndex,
  unpackAndVerifyIndexArtifact,
} from "@kronos/retrieval";
import {
  AsrEngine,
  AudioRingBuffer,
  VadEngine,
  decodeWavTo16kMono,
} from "@kronos/audio";

const ROOT = process.cwd();
const contractContent = fs.readFileSync(
  path.resolve(ROOT, "samples/term_sheet_v4.md"),
  "utf-8"
);
const jfkWavPath = path.resolve(ROOT, "samples/audio/jfk.wav");

/** Builds the index once and shares it; embedding 32 chunks is not free. */
let cachedArtifact: Uint8Array | null = null;
async function buildArtifact(): Promise<Uint8Array> {
  if (cachedArtifact) return cachedArtifact;
  const parser = new DocumentParser();
  const doc = await parser.parseTextOrMarkdown(contractContent, "term_sheet_v4.md");
  const chunks = new LegalChunker().chunkDocument(doc);
  const { binary } = await new IndexBuilder().buildArtifact(doc, chunks);
  cachedArtifact = binary;
  return binary;
}

describe("Ingest", () => {
  it("T-1: chunker produces complete logical units with no mid-sentence splits", async () => {
    const parser = new DocumentParser();
    const doc = await parser.parseTextOrMarkdown(contractContent, "term_sheet_v4.md");
    const chunks = new LegalChunker().chunkDocument(doc);

    expect(chunks.length).toBeGreaterThanOrEqual(20);
    for (const chunk of chunks) {
      expect(chunk.clauseLabel).toBeTruthy();
      expect(chunk.text.trim().length).toBeGreaterThan(20);
      const lastChar = chunk.text.trim().slice(-1);
      expect([".", ";", ":", '"', "'", ")"]).toContain(lastChar);
    }
  });

  it("T-2: scanned-PDF heuristic rejects image-only documents", () => {
    const parser = new DocumentParser();
    expect(() =>
      parser.detectScanned(["   ", " [scanned page] ", " short text "], "scanned_deal.pdf")
    ).toThrow(ScannedDocumentError);
  });
});

describe("Embedding model", () => {
  it("produces 384-dim unit vectors from the real MiniLM weights", async () => {
    const embedder = new MiniLmEmbedder();
    const [vec] = await embedder.embed(["Quarterly churn shall not exceed 4.0% of ending ARR."]);

    expect(vec.length).toBe(384);

    let norm = 0;
    for (const v of vec) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 5);
  }, 60_000);

  it("places semantically related clauses closer than unrelated ones", async () => {
    // This is the property a real embedding model has and a keyword hash does
    // not. The old FNV-1a implementation would fail this for any pair that
    // shared no literal substrings.
    const embedder = new MiniLmEmbedder();
    const [cap, carveOut, board] = await embedder.embed([
      "Quarterly churn shall not exceed 4.0% of ending ARR.",
      "Notwithstanding the foregoing, Q3 churn shall be exempt from the minimum thresholds.",
      "The Board of Directors shall consist of five members.",
    ]);

    const cos = (a: Float32Array, b: Float32Array) => {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i] * b[i];
      return s;
    };

    expect(cos(cap, carveOut)).toBeGreaterThan(cos(cap, board));
    expect(cos(cap, carveOut)).toBeGreaterThan(cos(carveOut, board));
  }, 60_000);

  it("reports a fingerprint derived from the actual weight file", () => {
    const embedder = new MiniLmEmbedder();
    // A real SHA-256 digest, not a hand-written label.
    expect(embedder.fingerprint()).toBe(EMBEDDING_FINGERPRINT);
    expect(embedder.fingerprint()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("Index artifact", () => {
  it("T-3: rejects an artifact built with different model weights", async () => {
    const binary = await buildArtifact();
    await expect(
      unpackAndVerifyIndexArtifact(binary, "sha256:mismatched-quant-model-v0")
    ).rejects.toThrow(ModelMismatchError);
  }, 120_000);

  it("round-trips through verification with the correct fingerprint", async () => {
    const binary = await buildArtifact();
    const loaded = await unpackAndVerifyIndexArtifact(binary);
    expect(loaded.meta.dimensions).toBe(384);
    expect(loaded.meta.chunkCount).toBeGreaterThan(20);
    expect(loaded.meta.modelFingerprint).toBe(EMBEDDING_FINGERPRINT);
  }, 120_000);
});

describe("Vector index", () => {
  it("T-6: flat index and brute-force oracle return identical rankings", async () => {
    const binary = await buildArtifact();

    const flat = new FlatVectorIndex();
    const brute = new BruteForceIndex();
    await flat.load(binary);
    await brute.load(binary);

    const embedder = new MiniLmEmbedder();
    const [query] = await embedder.embed(["churn exceeds the minimum threshold"]);

    const flatHits = await flat.search(query, 5);
    const bruteHits = await brute.search(query, 5);

    expect(flatHits.map((h) => h.chunkId)).toEqual(bruteHits.map((h) => h.chunkId));
    for (let i = 0; i < flatHits.length; i++) {
      expect(flatHits[i].score).toBeCloseTo(bruteHits[i].score, 5);
    }
  }, 120_000);

  it("T-14: search completes well inside the 10 ms budget", async () => {
    const binary = await buildArtifact();
    const index = new FlatVectorIndex();
    await index.load(binary);

    const embedder = new MiniLmEmbedder();
    const [query] = await embedder.embed(["indemnification cap and basket"]);

    await index.search(query, 3);
    expect(index.lastQueryMs).toBeLessThan(10.0);
  }, 120_000);

  it("reports a backend name that does not claim to be Moss", async () => {
    const index = new FlatVectorIndex();
    expect(index.backendName).not.toMatch(/moss/i);
  });
});

describe("Moss adapter", () => {
  it("throws rather than silently falling back when Moss is requested", () => {
    expect(() => createVectorIndex("moss")).toThrow(MossSdkUnavailableError);
  });

  it("defaults to the flat backend", () => {
    expect(createVectorIndex()).toBeInstanceOf(FlatVectorIndex);
  });

  it("stub methods throw instead of returning plausible-looking data", async () => {
    await expect(new MossIndex().search(new Float32Array(384), 3)).rejects.toThrow(
      MossSdkUnavailableError
    );
  });
});

describe("Query expansion", () => {
  it("T-5: is deterministic and produces exactly four weighted forms", () => {
    const parser = new AssertionParser(["churn", "arr"]);
    const expander = new QueryExpander();
    const a = expander.expand(parser.parse("Your Q3 churn violates the minimums."));
    const b = expander.expand(parser.parse("Your Q3 churn violates the minimums."));

    expect(a).toHaveLength(4);
    expect(a).toEqual(b);
    expect(a.map((e) => e.kind).sort()).toEqual([
      "definition",
      "exception",
      "obligation",
      "remedy",
    ]);
    expect(a.find((e) => e.kind === "exception")?.weight).toBe(
      CONFIG.retrieval.WEIGHTS.exception
    );
  });

  it("generates natural legal prose, not keyword soup", () => {
    const expander = new QueryExpander();
    const [, exception] = expander.expand(
      new AssertionParser().parse("Your Q3 churn violates the minimums.")
    );
    expect(exception.text).toMatch(/Notwithstanding/i);
    expect(exception.text).toMatch(/provided that/i);
  });
});

describe("Retrieval pipeline", () => {
  it("retrieves the churn carve-out within the top 3 for the adversarial claim", async () => {
    const binary = await buildArtifact();
    const index = new FlatVectorIndex();
    await index.load(binary);

    const pipeline = new RetrievalPipeline(index);
    pipeline.syncCorpusTerms();

    const outcome = await pipeline.query({
      queryId: "t-carveout",
      transcript: "Your Q3 churn violates the minimums in the term sheet.",
      tSpeechEnd: performance.now(),
      tAsrDone: performance.now(),
      asrMeanLogprob: -0.22,
      asrNoSpeechProb: 0.03,
      snrDb: 19.5,
    });

    const labels = outcome.results.map((r) => r.chunk.clauseLabel);
    expect(labels.some((l) => l.includes("4.2.1(b)"))).toBe(true);

    const carveOut = outcome.results.find((r) => r.chunk.clauseLabel.includes("4.2.1(b)"));
    expect(carveOut?.stance).toBe("supports");
  }, 120_000);
});

describe("Confidence gate", () => {
  const gate = new ConfidenceGate();

  it("T-11: returns red on high no-speech probability without attempting retrieval", () => {
    const verdict = gate.evaluatePreRetrieval({
      queryId: "q-red",
      transcript: "uhm...",
      tSpeechEnd: 0,
      tAsrDone: 50,
      asrMeanLogprob: -1.8,
      asrNoSpeechProb: 0.78,
      snrDb: 5.0,
    });
    expect(verdict.state).toBe("red");
    expect(verdict.reason).toBe("no_speech_detected");
  });

  it("T-10: returns amber when nothing was retrieved", () => {
    const verdict = gate.evaluate(
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
    expect(verdict.state).toBe("amber");
  });

  /**
   * Regression test for the saturation bug.
   *
   * The gate previously derived its similarity term from the RRF score, which is
   * ordinal and evaluated to ~0.064 for any top-ranked chunk. Scaled by 20 it
   * saturated the clamp at 1.0 on every query, so the gate returned green 50/50
   * on the eval set and could never decline. This asserts that a weak match
   * actually produces amber.
   */
  it("returns amber for a weak semantic match (RRF saturation regression)", () => {
    const weakResult = {
      chunk: {
        id: "x",
        clauseLabel: "§1.1",
        text: "irrelevant",
        crossRefs: [],
        definedTerms: [],
        signals: {
          hasExceptionMarker: false,
          hasObligationMarker: false,
          hasDefinitionMarker: false,
          hasRemedyMarker: false,
          matchedMarkers: [],
        },
      },
      fusedScore: 0.064,
      bestCosine: 0.12, // well below SIM_FLOOR — a poor match
      perExpansion: { obligation: 0.12, exception: null, definition: null, remedy: null },
      rank1Margin: 0.001,
      stance: "context",
      stanceConfidence: 0.5,
      stanceReasons: [],
      matchedTerms: [],
    } as never;

    const verdict = gate.evaluate(
      {
        queryId: "q-weak",
        transcript: "the parking space allocation for third floor contractors",
        tSpeechEnd: 0,
        tAsrDone: 50,
        asrMeanLogprob: -0.22,
        asrNoSpeechProb: 0.03,
        snrDb: 19.2,
      },
      [weakResult]
    );

    expect(verdict.state).toBe("amber");
  });

  it("returns green for a strong semantic match", () => {
    const strongResult = {
      chunk: {
        id: "y",
        clauseLabel: "§4.2.1(b)",
        text: "Notwithstanding Section 4.2, Q3 churn shall be exempt.",
        crossRefs: ["4.2"],
        definedTerms: [],
        signals: {
          hasExceptionMarker: true,
          hasObligationMarker: false,
          hasDefinitionMarker: false,
          hasRemedyMarker: false,
          matchedMarkers: ["notwithstanding"],
        },
      },
      fusedScore: 0.064,
      bestCosine: 0.68,
      perExpansion: { obligation: 0.5, exception: 0.68, definition: null, remedy: null },
      rank1Margin: 0.12,
      stance: "supports",
      stanceConfidence: 0.9,
      stanceReasons: [],
      matchedTerms: [],
    } as never;

    const verdict = gate.evaluate(
      {
        queryId: "q-strong",
        transcript: "Your Q3 churn violates the minimums in the term sheet.",
        tSpeechEnd: 0,
        tAsrDone: 50,
        asrMeanLogprob: -0.22,
        asrNoSpeechProb: 0.03,
        snrDb: 19.2,
      },
      [strongResult]
    );

    expect(verdict.state).toBe("green");
  });
});

describe("Audio", () => {
  it("T-4: ring buffer overwrites oldest samples and never grows (CR-1)", () => {
    const ring = new AudioRingBuffer(1, 16000);
    const samples = new Float32Array(8000).fill(0.5);
    ring.write(samples);
    ring.write(samples);
    ring.write(samples);

    const latest = ring.readLatest(4000);
    expect(latest.length).toBe(4000);
    expect(latest[0]).toBeCloseTo(0.5, 4);
    expect(ring.capacity).toBe(16000);
  });

  it("VAD emits speechStart and speechEnd with an SNR estimate", () => {
    const vad = new VadEngine();
    const events: string[] = [];
    let snr = -1;
    vad.onEvent((e) => {
      events.push(e.type);
      if (e.type === "speechEnd") snr = e.snrDb;
    });

    const speech = new Float32Array(512).fill(0.35);
    vad.processFrame(speech, 100);
    vad.processFrame(speech, 400);
    expect(events).toContain("speechStart");

    vad.processFrame(new Float32Array(512).fill(0.001), 1200);
    expect(events).toContain("speechEnd");
    expect(snr).toBeGreaterThan(0);
  });

  it("decodes WAV to 16 kHz mono", () => {
    if (!fs.existsSync(jfkWavPath)) return;
    const pcm = decodeWavTo16kMono(fs.readFileSync(jfkWavPath));
    expect(pcm.length).toBeGreaterThan(16000);
    // Real speech is bounded well inside [-1, 1] and is not silent.
    let peak = 0;
    for (const s of pcm) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThanOrEqual(1.0);
  });

  it("transcribes real speech with the real Whisper model", async () => {
    if (!fs.existsSync(jfkWavPath)) return;
    const pcm = decodeWavTo16kMono(fs.readFileSync(jfkWavPath));

    const asr = new AsrEngine();
    const result = await asr.transcribe(pcm);

    // Content check: the model must actually recognise the words.
    expect(result.text.toLowerCase()).toContain("country");
    expect(result.decodeMs).toBeGreaterThan(0);
    expect(result.noSpeechProb).toBeLessThan(0.5);
  }, 180_000);

  it("flags silence as no-speech instead of hallucinating a transcript", async () => {
    // Whisper reliably emits filler text on silence. The energy check must catch
    // it, otherwise the panel would retrieve clauses for words nobody said.
    const asr = new AsrEngine();
    const result = await asr.transcribe(new Float32Array(16000 * 2));
    expect(result.noSpeechProb).toBeGreaterThan(CONFIG.asr.NO_SPEECH_THRESHOLD);
  }, 180_000);
});
