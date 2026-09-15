/**
 * KRONOS evaluation harness (SPEC.md §14, PRD.md §11).
 *
 * MEASUREMENT POLICY
 * ------------------
 * Every number this harness emits is either measured in this process or is
 * explicitly labelled as not measured. There are no floors, no clamps, no
 * "realistic" constants standing in for timings, and no stage that reports a
 * duration it did not observe.
 *
 * A previous version of this file applied `Math.max(0.4, observed)` to retrieval
 * time, `Math.max(1.8, observed)` to fusion time, added a fixed
 * `asrFlushSimulatedMs = 112.4` for a decoder that never ran, and appended a
 * constant `paintMs = 24.5` for a paint that never happened in Node. The
 * resulting "p50 144.1 ms / p95 144.9 ms" was arithmetic on constants. The 0.8 ms
 * spread across 50 samples was the tell: real measurements do not do that.
 *
 * WHAT IS AND IS NOT MEASURED HERE
 * --------------------------------
 *   MEASURED in Node:  embedding, vector search, fusion/ranking, and real
 *                      Whisper decode latency over real recorded audio.
 *   NOT MEASURED here: browser paint time. There is no renderer in Node, so
 *                      t_paint is reported as UNMEASURED and must be collected
 *                      from the in-browser debug overlay (?debug=1).
 *
 * Retrieval quality is evaluated on assertion TEXT, which is legitimate: the
 * retrieval stage consumes text regardless of whether a human or Whisper
 * produced it. ASR accuracy is a separate axis and is not folded into recall.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsrEngine, decodeWavTo16kMono } from "@kronos/audio";
import { IndexBuilder, LegalChunker, DocumentParser } from "@kronos/ingest";
import { CONFIG } from "@kronos/core";
import { FlatVectorIndex, RetrievalPipeline } from "@kronos/retrieval";

const CONFIG_C_AMBER = CONFIG.confidence.C_AMBER;

interface EvalEntry {
  id: string;
  assertion: string;
  goldChunkIds: string[];
  acceptableChunkIds: string[];
  expectedStance: string;
  adversarial: boolean;
  note: string;
}

/** Nearest-rank percentile over an already-sorted ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Number(sorted[idx].toFixed(2));
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2));
}

/**
 * Measures real Whisper decode latency across realistic utterance lengths.
 *
 * Uses a real speech recording rather than synthetic noise, because decode time
 * depends on how many tokens the decoder emits, and silence decodes to nothing
 * almost instantly. Timing against silence would understate the real cost by an
 * order of magnitude.
 *
 * The recording is sliced to 2s / 3s / 5s to bracket the length of a typical
 * negotiation assertion.
 */
async function benchmarkAsr(
  repoRoot: string
): Promise<{ rows: { seconds: number; decodeMs: number[]; rtf: number }[]; note: string } | null> {
  const wavPath = path.join(repoRoot, "samples", "audio", "jfk.wav");
  if (!fs.existsSync(wavPath)) {
    return null;
  }

  console.log("\n[2/3] Benchmarking real Whisper decode on recorded speech...");

  const asr = new AsrEngine();
  await asr.init();

  const full = decodeWavTo16kMono(fs.readFileSync(wavPath));
  const sampleRate = 16_000;

  // Warm the graph; the first ONNX run is not representative of steady state.
  await asr.transcribe(full.slice(0, sampleRate));

  const rows: { seconds: number; decodeMs: number[]; rtf: number }[] = [];
  const REPEATS = 3;

  for (const seconds of [2, 3, 5]) {
    const clip = full.slice(0, Math.min(full.length, seconds * sampleRate));
    const decodeMs: number[] = [];

    for (let i = 0; i < REPEATS; i++) {
      const result = await asr.transcribe(clip);
      decodeMs.push(result.decodeMs);
    }

    decodeMs.sort((a, b) => a - b);
    const rtf = Number((mean(decodeMs) / (seconds * 1000)).toFixed(3));
    rows.push({ seconds, decodeMs, rtf });
    console.log(
      `      ${seconds}s utterance -> ${mean(decodeMs).toFixed(1)} ms mean decode (RTF ${rtf})`
    );
  }

  return {
    rows,
    note:
      "Measured on an 11-second recording of natural English speech " +
      "(samples/audio/jfk.wav), sliced to each duration, 3 repeats each, " +
      "after a warm-up pass.",
  };
}

async function main() {
  console.log("==============================================================");
  console.log("  KRONOS — Evaluation Harness");
  console.log("==============================================================");

  const repoRoot = path.resolve(process.cwd(), "..");

  // ---------------------------------------------------------------- ingest
  console.log("\n[1/3] Building index with real all-MiniLM-L6-v2 embeddings...");

  const samplePath = path.join(repoRoot, "samples", "term_sheet_v4.md");
  const contractMd = fs.readFileSync(samplePath, "utf-8");

  const docParser = new DocumentParser();
  const parsedDoc = await docParser.parseTextOrMarkdown(contractMd, "term_sheet_v4.md");
  const chunker = new LegalChunker();
  const chunks = chunker.chunkDocument(parsedDoc);

  const builder = new IndexBuilder();
  const tIngest0 = performance.now();
  const { binary, meta } = await builder.buildArtifact(parsedDoc, chunks);
  const ingestMs = performance.now() - tIngest0;

  const webIndexDir = path.join(repoRoot, "apps", "web", "public", "index");
  fs.mkdirSync(webIndexDir, { recursive: true });
  fs.writeFileSync(path.join(webIndexDir, "term_sheet.moss"), binary);
  fs.writeFileSync(path.join(webIndexDir, "term_sheet.json"), JSON.stringify(meta, null, 2));

  console.log(
    `      ${chunks.length} chunks embedded in ${ingestMs.toFixed(0)} ms ` +
      `(${(ingestMs / chunks.length).toFixed(1)} ms/chunk)`
  );
  console.log(`      model fingerprint: ${meta.modelFingerprint}`);

  const index = new FlatVectorIndex();
  await index.load(binary);

  const pipeline = new RetrievalPipeline(index);
  await pipeline.init();
  pipeline.syncCorpusTerms();

  // --------------------------------------------------------------- dataset
  const datasetPath = path.resolve(process.cwd(), "dataset/assertions.jsonl");
  const lines = fs.readFileSync(datasetPath, "utf-8").trim().split(/\r?\n/);
  const dataset: EvalEntry[] = lines.map((l) => JSON.parse(l));

  let kronosHitsAt1 = 0;
  let kronosHitsAt3 = 0;
  let kronosHitsAt5 = 0;
  let kronosMrrSum = 0;

  let kronosAdvHitsAt1 = 0;
  let kronosAdvHitsAt3 = 0;

  let baseHitsAt1 = 0;
  let baseHitsAt3 = 0;
  let baseHitsAt5 = 0;
  let baseMrrSum = 0;

  let baseAdvHitsAt1 = 0;
  let baseAdvHitsAt3 = 0;

  let falseConfidentCount = 0;
  let greenCount = 0;

  const searchTimes: number[] = [];
  const embedTimes: number[] = [];
  const queryBuildTimes: number[] = [];
  const rankTimes: number[] = [];
  const retrievalPipelineTimes: number[] = [];

  const perItem: Record<string, unknown>[] = [];
  const adversarialTotal = dataset.filter((d) => d.adversarial).length;

  console.log(`\n[3/3] Running ${dataset.length} assertions (${adversarialTotal} adversarial)...`);

  for (const item of dataset) {
    // t_speech_end is the moment the utterance ended. In this harness the ASR
    // stage is benchmarked separately, so the pipeline is handed text directly
    // and tAsrDone == tSpeechEnd. The end-to-end figure is composed explicitly
    // further down rather than smuggled in here as a constant.
    const tSpeechEnd = performance.now();

    const outcome = await pipeline.query({
      queryId: item.id,
      transcript: item.assertion,
      tSpeechEnd,
      tAsrDone: tSpeechEnd,
      // Confidence inputs are held at fixed, clearly-stated values so that the
      // gate calibration measures the RETRIEVAL contribution rather than noise
      // injected from a fake ASR. These are inputs to the experiment, not
      // measurements of anything.
      asrMeanLogprob: -0.22,
      asrNoSpeechProb: 0.03,
      snrDb: 19.2,
      audioMs: 3200,
    });

    const baseOutcome = await pipeline.queryBaseline({
      queryId: `${item.id}-base`,
      transcript: item.assertion,
      tSpeechEnd,
      tAsrDone: tSpeechEnd,
      asrMeanLogprob: -0.22,
      asrNoSpeechProb: 0.03,
      snrDb: 19.2,
      audioMs: 3200,
    });

    const goldSet = item.adversarial
      ? new Set(item.goldChunkIds)
      : new Set([...item.goldChunkIds, ...item.acceptableChunkIds]);
    const strictGoldSet = new Set(item.goldChunkIds);

    const rankOf = (ids: string[], gold: Set<string>): number => {
      for (let i = 0; i < ids.length; i++) {
        if (gold.has(ids[i])) return i + 1;
      }
      return 0;
    };

    const kronosIds = outcome.results.map((r) => r.chunk.id);
    const baseIds = baseOutcome.results.map((r) => r.chunk.id);

    const kronosRank = rankOf(kronosIds, goldSet);
    const baseRank = rankOf(baseIds, goldSet);
    const kronosAdvRank = rankOf(kronosIds, strictGoldSet);
    const baseAdvRank = rankOf(baseIds, strictGoldSet);

    if (kronosRank === 1) kronosHitsAt1++;
    if (kronosRank > 0 && kronosRank <= 3) kronosHitsAt3++;
    if (kronosRank > 0 && kronosRank <= 5) kronosHitsAt5++;
    if (kronosRank > 0) kronosMrrSum += 1 / kronosRank;

    if (baseRank === 1) baseHitsAt1++;
    if (baseRank > 0 && baseRank <= 3) baseHitsAt3++;
    if (baseRank > 0 && baseRank <= 5) baseHitsAt5++;
    if (baseRank > 0) baseMrrSum += 1 / baseRank;

    if (item.adversarial) {
      if (kronosAdvRank === 1) kronosAdvHitsAt1++;
      if (kronosAdvRank > 0 && kronosAdvRank <= 3) kronosAdvHitsAt3++;
      if (baseAdvRank === 1) baseAdvHitsAt1++;
      if (baseAdvRank > 0 && baseAdvRank <= 3) baseAdvHitsAt3++;
    }

    // A false-confident is the failure that actually matters: the panel showed
    // green (asserting it found the governing clause) and was wrong.
    if (outcome.state === "green") {
      greenCount++;
      if (kronosRank === 0) falseConfidentCount++;
    }

    // Raw observed stage timings. No flooring.
    const t = outcome.timing;
    const qbMs = t.tQueryBuilt - tSpeechEnd;
    const embMs = t.tEmbedDone - t.tQueryBuilt;
    const searchMs = t.vectorSearchMs;
    const rankMs = t.tRanked - t.tSearchDone;
    const pipelineMs = t.tRanked - tSpeechEnd;

    queryBuildTimes.push(qbMs);
    embedTimes.push(embMs);
    searchTimes.push(searchMs);
    rankTimes.push(rankMs);
    retrievalPipelineTimes.push(pipelineMs);

    perItem.push({
      id: item.id,
      adversarial: item.adversarial,
      kronosRank,
      baseRank,
      state: outcome.state,
      composite: outcome.composite,
      topCosine: outcome.results[0]?.bestCosine ?? 0,
      hit: kronosRank > 0,
      topChunk: kronosIds[0] ?? null,
      gold: item.goldChunkIds,
      pipelineMs: Number(pipelineMs.toFixed(2)),
    });
  }

  for (const arr of [queryBuildTimes, embedTimes, searchTimes, rankTimes, retrievalPipelineTimes]) {
    arr.sort((a, b) => a - b);
  }

  const asrBenchmark = await benchmarkAsr(repoRoot);

  /**
   * Gate threshold sweep.
   *
   * For each candidate threshold, reports what fraction of queries would be
   * shown at all (coverage) and what fraction of those shown would be wrong
   * (false-confident). This is the tradeoff the gate actually controls, and
   * publishing the whole curve means the chosen operating point can be
   * disagreed with rather than merely trusted.
   */
  const sweep = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((threshold) => {
    const shown = perItem.filter((i) => (i.composite as number) >= threshold);
    const wrong = shown.filter((i) => !(i.hit as boolean));
    return {
      threshold,
      shownCount: shown.length,
      coveragePct: Number(((shown.length / perItem.length) * 100).toFixed(1)),
      falseConfidentCount: wrong.length,
      falseConfidentPct:
        shown.length === 0 ? 0 : Number(((wrong.length / shown.length) * 100).toFixed(1)),
      amberPct: Number((((perItem.length - shown.length) / perItem.length) * 100).toFixed(1)),
    };
  });


  // ---------------------------------------------------------------- scoring
  const N = dataset.length;
  const pct = (n: number, d: number) => Number(((n / d) * 100).toFixed(1));

  const kronosRecall1 = pct(kronosHitsAt1, N);
  const kronosRecall3 = pct(kronosHitsAt3, N);
  const kronosRecall5 = pct(kronosHitsAt5, N);
  const kronosMrr = Number((kronosMrrSum / N).toFixed(3));

  const baseRecall1 = pct(baseHitsAt1, N);
  const baseRecall3 = pct(baseHitsAt3, N);
  const baseRecall5 = pct(baseHitsAt5, N);
  const baseMrr = Number((baseMrrSum / N).toFixed(3));

  const kronosAdvRecall1 = pct(kronosAdvHitsAt1, adversarialTotal);
  const kronosAdvRecall3 = pct(kronosAdvHitsAt3, adversarialTotal);
  const baseAdvRecall1 = pct(baseAdvHitsAt1, adversarialTotal);
  const baseAdvRecall3 = pct(baseAdvHitsAt3, adversarialTotal);

  const liftRecall3Pts = Number((kronosRecall3 - baseRecall3).toFixed(1));
  const advLiftRecall3Pts = Number((kronosAdvRecall3 - baseAdvRecall3).toFixed(1));
  const falseConfidentRate =
    greenCount === 0 ? 0 : Number(((falseConfidentCount / greenCount) * 100).toFixed(2));

  const cpuModel = os.cpus()[0]?.model ?? "unknown CPU";
  const hardwareStamp =
    `${cpuModel} (${os.cpus().length} cores, Node ${process.version}, ` +
    `${os.platform()} ${os.release()})`;

  const p = (arr: number[], q: number) => percentile(arr, q);

  // Composed end-to-end estimate, with every component labelled by provenance.
  const retrievalP50 = p(retrievalPipelineTimes, 50);
  const asr5s = asrBenchmark?.rows.find((r) => r.seconds === 5);
  const asrMean5s = asr5s ? mean(asr5s.decodeMs) : null;

  // ---------------------------------------------------------------- reports
  const resultsDir = path.resolve(process.cwd(), "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const asrSection = asrBenchmark
    ? `
### Whisper decode latency — MEASURED

${asrBenchmark.note}

| Utterance length | Mean decode | Min | Max | Real-time factor |
|---|---|---|---|---|
${asrBenchmark.rows
  .map(
    (r) =>
      `| ${r.seconds}s | **${mean(r.decodeMs).toFixed(1)} ms** | ${Math.min(...r.decodeMs).toFixed(1)} ms | ${Math.max(...r.decodeMs).toFixed(1)} ms | ${r.rtf} |`
  )
  .join("\n")}

> Whisper is not a streaming model: it decodes a complete segment. A single
> decode beginning at \`t_speech_end\` therefore cannot meet the 350 ms paint
> budget for utterances of realistic length. KRONOS mitigates this with trailing
> partial decodes during speech and fires retrieval on the provisional
> transcript (\`ListeningSession\`), but the mitigation shifts the cost, it does
> not remove it. See "Known limitations".
`
    : `
### Whisper decode latency — NOT MEASURED

No reference audio was present at \`samples/audio/jfk.wav\`, so ASR latency was
not benchmarked in this run.
`;

  const md = `# KRONOS — Evaluation Results

**Generated:** ${new Date().toISOString()}
**Hardware:** ${hardwareStamp}
**Embedding model:** \`${meta.modelFingerprint}\`
**Corpus:** \`samples/term_sheet_v4.md\` — ${chunks.length} legal-boundary chunks
**Dataset:** ${N} labelled assertions (${adversarialTotal} adversarial)
**Retrieval backend:** flat exact in-memory search (no Moss SDK — see README)

---

## 1. Retrieval quality — MEASURED

Gold set for standard items includes \`acceptableChunkIds\`. Adversarial items are
scored strictly against \`goldChunkIds\` only: for those, retrieving the obligation
instead of the carve-out counts as a miss, because surfacing the rule the other
side just quoted at you is not a useful answer.

| Metric | KRONOS | Naive single-query baseline | Lift |
|---|---|---|---|
| Recall@1 | **${kronosRecall1}%** | ${baseRecall1}% | ${(kronosRecall1 - baseRecall1).toFixed(1)} pts |
| Recall@3 | **${kronosRecall3}%** | ${baseRecall3}% | **${liftRecall3Pts} pts** |
| Recall@5 | **${kronosRecall5}%** | ${baseRecall5}% | ${(kronosRecall5 - baseRecall5).toFixed(1)} pts |
| MRR | **${kronosMrr}** | ${baseMrr} | ${(kronosMrr - baseMrr).toFixed(3)} |

### Adversarial subset (n=${adversarialTotal}) — the carve-out cases

| Metric | KRONOS | Naive baseline | Lift |
|---|---|---|---|
| Recall@1 | **${kronosAdvRecall1}%** | ${baseAdvRecall1}% | ${(kronosAdvRecall1 - baseAdvRecall1).toFixed(1)} pts |
| Recall@3 | **${kronosAdvRecall3}%** | ${baseAdvRecall3}% | **${advLiftRecall3Pts} pts** |

Both arms use the same real embeddings, the same index, and the same corpus. The
only difference is multi-query expansion + RRF + cross-reference resolution.

---

## 2. Latency

### Retrieval pipeline — MEASURED (n=${N})

Observed values, unmodified. No floors, no clamps, no substituted constants.

| Stage | p50 | p95 | Mean | Budget | Status |
|---|---|---|---|---|---|
| Assertion parse + expansion | ${p(queryBuildTimes, 50)} ms | ${p(queryBuildTimes, 95)} ms | ${mean(queryBuildTimes)} ms | — | — |
| MiniLM embedding (4 queries) | ${p(embedTimes, 50)} ms | ${p(embedTimes, 95)} ms | ${mean(embedTimes)} ms | — | — |
| Vector search (flat exact) | **${p(searchTimes, 50)} ms** | **${p(searchTimes, 95)} ms** | ${mean(searchTimes)} ms | < 10 ms | ${p(searchTimes, 95) < 10 ? "PASS" : "FAIL"} |
| RRF + xref + stance | ${p(rankTimes, 50)} ms | ${p(rankTimes, 95)} ms | ${mean(rankTimes)} ms | — | — |
| **Text in → ranked clauses out** | **${p(retrievalPipelineTimes, 50)} ms** | **${p(retrievalPipelineTimes, 95)} ms** | ${mean(retrievalPipelineTimes)} ms | — | — |
${asrSection}
### Browser paint — NOT MEASURED

\`t_paint\` cannot be observed from Node; there is no renderer. The end-of-utterance
→ painted-clause figure must be collected in-browser from the debug overlay
(\`?debug=1\`). It is deliberately left blank here rather than estimated.

### Composed end-to-end estimate

${
  asrMean5s
    ? `For a 5-second utterance: ~${asrMean5s.toFixed(0)} ms final Whisper decode + ` +
      `${retrievalP50.toFixed(1)} ms retrieval + unmeasured paint. With the provisional-transcript ` +
      `path, retrieval starts at \`t_speech_end\` rather than after the decode, so perceived ` +
      `latency is dominated by paint plus the ~${retrievalP50.toFixed(0)} ms retrieval — but the ` +
      `authoritative transcript, and any correction it triggers, still arrives ~${asrMean5s.toFixed(0)} ms later.`
    : "Not computable without the ASR benchmark."
}

---

## 3. Confidence gate — MEASURED

| Metric | Value | Target | Status |
|---|---|---|---|
| Green verdicts | ${greenCount} / ${N} | — | — |
| Amber verdicts | ${N - greenCount} / ${N} | — | — |
| False-confident (green but gold not retrieved) | ${falseConfidentCount} | — | — |
| **False-confident rate** | **${falseConfidentRate}%** | ≤ 5% | ${falseConfidentRate <= 5 ? "PASS" : "FAIL"} |

A false-confident is the only retrieval failure that actively harms the user: an
amber "no confident match" sends them to the document, whereas a confident wrong
clause invites them to argue from it.

### Threshold sweep

Coverage is the share of queries shown at all; false-confident is the share of
*shown* queries whose gold clause was not retrieved. Current operating point
\`C_AMBER = ${CONFIG_C_AMBER}\` is marked.

| Threshold | Shown | Coverage | False-confident | Amber rate |
|---|---|---|---|---|
${sweep
  .map(
    (s) =>
      `| ${s.threshold === CONFIG_C_AMBER ? `**${s.threshold}** ←` : s.threshold} | ${s.shownCount}/${N} | ${s.coveragePct}% | ${s.falseConfidentCount} (${s.falseConfidentPct}%) | ${s.amberPct}% |`
  )
  .join("\n")}

> [!IMPORTANT]
> The threshold was selected using this same 50-item set, so the false-confident
> rate above is an **in-sample** figure and is optimistic. It is not a held-out
> estimate of production behaviour. With n=${N} there is not enough data to split
> a meaningful validation fold; treating this number as a generalisation bound
> would be wrong.


---

## 4. Known limitations

1. **No Moss.** Retrieval is exact flat search implemented in this repository.
   No Moss SDK was resolvable from public registries at build time. The adapter
   seam is in \`packages/retrieval/src/moss-adapter.ts\`.
2. **Whisper decode exceeds the paint budget** for utterances beyond ~2 seconds.
   Mitigated, not solved.
3. **Paint time unmeasured** in this harness.
4. **Single corpus.** All ${N} assertions are scored against one term sheet of
   ${chunks.length} clauses. Recall on a 30-clause corpus is a substantially easier
   problem than on a 3,000-clause one, and these numbers should not be read as
   generalising to large document sets.
5. **English-only ASR** (\`whisper-tiny.en\`), and far-field / accented speech
   accuracy is untested.
6. **Confidence-gate inputs are fixed constants** in this harness, so the gate
   calibration reflects retrieval quality only, not end-to-end behaviour under
   real acoustic conditions.
`;

  fs.writeFileSync(path.join(resultsDir, "RESULTS.md"), md);

  fs.writeFileSync(
    path.join(resultsDir, "calibration.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        hardware: hardwareStamp,
        modelFingerprint: meta.modelFingerprint,
        retrievalBackend: "flat-exact",
        mossSdkPresent: false,
        corpus: { file: "samples/term_sheet_v4.md", chunks: chunks.length },
        dataset: { n: N, adversarial: adversarialTotal },
        recall: {
          kronos: { at1: kronosRecall1, at3: kronosRecall3, at5: kronosRecall5, mrr: kronosMrr },
          baseline: { at1: baseRecall1, at3: baseRecall3, at5: baseRecall5, mrr: baseMrr },
          adversarial: {
            kronos: { at1: kronosAdvRecall1, at3: kronosAdvRecall3 },
            baseline: { at1: baseAdvRecall1, at3: baseAdvRecall3 },
          },
        },
        latencyMs: {
          measured: {
            queryBuild: { p50: p(queryBuildTimes, 50), p95: p(queryBuildTimes, 95) },
            embed: { p50: p(embedTimes, 50), p95: p(embedTimes, 95) },
            vectorSearch: { p50: p(searchTimes, 50), p95: p(searchTimes, 95) },
            rank: { p50: p(rankTimes, 50), p95: p(rankTimes, 95) },
            retrievalTotal: {
              p50: p(retrievalPipelineTimes, 50),
              p95: p(retrievalPipelineTimes, 95),
            },
            asrDecode: asrBenchmark?.rows ?? null,
          },
          unmeasured: ["paint"],
        },
        gate: {
          green: greenCount,
          falseConfident: falseConfidentCount,
          falseConfidentRatePct: falseConfidentRate,
          thresholdSweep: sweep,
          calibratedInSample: true,
        },
        perItem,
      },
      null,
      2
    )
  );

  // ---------------------------------------------------------------- console
  console.log("\n==============================================================");
  console.log("  RESULTS");
  console.log("==============================================================");
  console.log(`  Recall@3          KRONOS ${kronosRecall3}%  |  baseline ${baseRecall3}%  (${liftRecall3Pts >= 0 ? "+" : ""}${liftRecall3Pts} pts)`);
  console.log(`  Recall@3 (adv)    KRONOS ${kronosAdvRecall3}%  |  baseline ${baseAdvRecall3}%  (${advLiftRecall3Pts >= 0 ? "+" : ""}${advLiftRecall3Pts} pts)`);
  console.log(`  MRR               KRONOS ${kronosMrr}  |  baseline ${baseMrr}`);
  console.log(`  Vector search     p50 ${p(searchTimes, 50)} ms  |  p95 ${p(searchTimes, 95)} ms`);
  console.log(`  Embedding         p50 ${p(embedTimes, 50)} ms  |  p95 ${p(embedTimes, 95)} ms`);
  console.log(`  Retrieval total   p50 ${p(retrievalPipelineTimes, 50)} ms  |  p95 ${p(retrievalPipelineTimes, 95)} ms`);
  if (asrMean5s) {
    console.log(`  Whisper (5s utt)  ${asrMean5s.toFixed(0)} ms mean decode`);
  }
  console.log(`  False-confident   ${falseConfidentRate}%  (${falseConfidentCount}/${greenCount} green)`);
  console.log(`  Paint             NOT MEASURED (requires browser)`);
  console.log("\n  Wrote eval/results/RESULTS.md and calibration.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
