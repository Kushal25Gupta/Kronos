# KRONOS

**Local-first recall copilot for high-stakes contract negotiation.**
Speech → clause, in the browser tab, with no network egress after load.

Built for **YC Fall 2026 × Moss: The Zero Latency Builder Sprint**
Themes: *Local-First AI & The Small Cloud* (primary) · *Real-Time Voice* · *Agent Reliability*

---

> [!IMPORTANT]
> **KRONOS does not currently use Moss.** Retrieval runs on an exact flat
> in-memory index implemented in this repository. No Moss vector-search SDK was
> resolvable from public package registries at build time, and SDK access has not
> been obtained. The integration seam is written and isolated to one file
> ([`moss-adapter.ts`](packages/retrieval/src/moss-adapter.ts)); requesting the
> Moss backend today throws rather than silently falling back. This is the
> project's most significant open gap and is tracked in
> [Known limitations](#known-limitations).

---

## What it does

In a negotiation, someone makes a claim about the agreement:

> *"Your Q3 churn violates the minimums in the term sheet."*

You have read that document. You know there is a carve-out. Finding it takes
forty seconds of scrolling, and scrolling in front of the other side tells them
you're not sure.

KRONOS listens to your own meeting, detects the end of the utterance, and puts
the governing clauses on a heads-up panel — quoted verbatim from **your**
documents, tagged with whether each one helps you or hurts you:

```
┌─ SUPPORTS YOU ──────────────────── Term_Sheet_v4.md · §4.2.1(b) ──┐
│ "Notwithstanding §4.2, Q3 churn shall be exempt from the minimum  │
│  thresholds provided that annual revenue exceeds $50,000,000."    │
└───────────────────────────── conf 0.89 · 187 ms · search 0.1 ms ──┘

┌─ CUTS AGAINST YOU ──────────────── Term_Sheet_v4.md · §4.2 ───────┐
│ "Quarterly churn shall not exceed 4.0% of ending ARR."            │
└───────────────────────────────────────────── conf 0.81 ───────────┘
```

Voice detection, speech recognition, embedding, and retrieval all run inside the
tab. After the page and model weights load, KRONOS makes no network requests —
and the debug overlay counts them so you can verify that rather than believe it.

---

## Quick start

```bash
pnpm install
pnpm bootstrap  # downloads model weights (~64 MB) + reference audio, builds the index
pnpm dev        # http://localhost:3000
```

`pnpm bootstrap` is required on a fresh clone: the ONNX weights are not committed to
git. It is the only step that touches the network.

| Command | What it does |
|---|---|
| `pnpm dev` | Session HUD at `/`, chunk inspector at `/inspect`, telemetry via `?debug=1` |
| `pnpm ingest <file> -o <out.moss>` | Parse → chunk → embed → emit index artifact |
| `pnpm test` | Full suite against the real models (~6 s) |
| `pnpm eval` | Retrieval + latency benchmark → `eval/results/RESULTS.md` |
| `pnpm typecheck && pnpm build` | Type check and production build |

---

## What is actually running

Stated explicitly, because an earlier revision of this project shipped
simulations under the names of real components.

| Component | Status | What it is |
|---|---|---|
| Embeddings | **Real** | `all-MiniLM-L6-v2`, int8 ONNX, via transformers.js |
| Speech recognition | **Real** | `whisper-tiny.en`, int8 ONNX, decoding real PCM |
| Microphone | **Real** | `getUserMedia` + `AudioWorklet` at 16 kHz |
| Voice activity detection | **Real** | Energy/noise-floor heuristic (not a neural VAD) |
| Chunking, RRF, stance, gate | **Real** | Plain deterministic code |
| Vector search | **Real, but not Moss** | Exact flat scan over 32 clauses |
| Moss SDK | **Not wired** | Stub throws; see `moss-adapter.ts` |

---

## Results

All figures below are produced by `pnpm eval` and written to
[`eval/results/RESULTS.md`](eval/results/RESULTS.md). Measured on an Intel Xeon
workstation (24 cores, Node v24), 50 labelled assertions over a 32-clause term
sheet, 15 of them adversarial.

Nothing here is floored, clamped, or substituted with a constant. Where a number
could not be measured, it says so.

### Retrieval quality

| Metric | KRONOS | Naive single-query baseline | Lift |
|---|---|---|---|
| Recall@1 | 76.0% | 78.0% | **−2.0 pts** |
| Recall@3 | 94.0% | 94.0% | **0.0 pts** |
| MRR | 0.847 | 0.857 | **−0.010** |

### Adversarial subset (n=15) — the carve-out cases

| Metric | KRONOS | Naive baseline | Lift |
|---|---|---|---|
| Recall@1 | **60.0%** | 33.3% | **+26.7 pts** |
| Recall@3 | **93.3%** | 80.0% | **+13.3 pts** |

**Read this honestly:** multi-query expansion buys nothing on general recall — a
single real MiniLM embedding of the raw sentence already reaches 94% on a corpus
this size, and on rank-1 ordering the expansion is very slightly *worse*. The
entire benefit is concentrated in the adversarial cases, where the useful clause
is a carve-out that rebuts the assertion rather than the obligation the assertion
restates. There it is worth +26.7 points at rank 1.

That is a real tradeoff, and it happens to be the one the product is about. It is
also much smaller than it would look if the baseline were weaker.

### Latency

| Stage | p50 | p95 | Status |
|---|---|---|---|
| Vector search (flat exact, 32 clauses) | **0.10 ms** | 0.27 ms | well inside 10 ms |
| MiniLM embedding (4 expansions) | 41.3 ms | 52.9 ms | — |
| RRF + cross-refs + stance | ~0.5 ms | ~1 ms | — |
| **Text in → ranked clauses out** | **43.0 ms** | 54.2 ms | — |
| Whisper decode (5 s utterance) | **~690 ms** | — | **over budget** |
| Browser paint | *not measured* | — | requires `?debug=1` in-browser |

> [!WARNING]
> **Whisper decode does not fit the latency budget.** Measured decode is roughly
> 650–715 ms and is nearly flat across 2 s, 3 s, and 5 s utterances, because
> Whisper pads every input to a fixed 30-second mel window — so the cost is
> essentially constant per utterance rather than proportional to its length. The
> target for end-of-utterance → painted clause is 350 ms p50. A single decode
> starting at `t_speech_end` cannot meet it.
>
> KRONOS mitigates this by running trailing partial decodes *during* speech and
> firing retrieval on the provisional transcript at `t_speech_end`, with the
> authoritative decode correcting afterwards if it differs
> ([`session.ts`](packages/audio/src/session.ts)). That shifts the cost off the
> critical path; it does not eliminate it. The honest cost is that the first
> paint can be based on a slightly truncated sentence.

### Confidence gate

| Metric | Value | Target |
|---|---|---|
| Green verdicts | 47 / 50 | — |
| False-confident rate | **4.26%** | ≤ 5% |

A false-confident — showing green while the governing clause was not retrieved —
is the only failure that actively harms the user. An amber sends them to the
document, which is what they would have done anyway; a confident wrong clause
invites them to argue from it.

> [!NOTE]
> The gate threshold was calibrated on this same 50-item set, so 4.26% is an
> **in-sample** figure and is optimistic. `RESULTS.md` publishes the full
> threshold sweep so the operating point can be argued with.

---

## How it works

```
microphone → AudioWorklet → ring buffer (30 s, in-memory only)
                 ↓
            energy VAD → utterance boundaries
                 ↓
         whisper-tiny.en → transcript
                 ↓
      assertion parser → 4 hypothetical clause forms
                 ↓
         all-MiniLM-L6-v2 → 4 × 384-dim vectors
                 ↓
        flat exact index → top-10 per expansion
                 ↓
    reciprocal rank fusion → cross-reference resolution → stance
                 ↓
         confidence gate → green / amber / red
```

### The idea that does the work

A spoken accusation and the clause that governs it are written in completely
different registers. Nobody says *"notwithstanding the foregoing"*; they say
*"your churn blows the minimums."* Embedding the spoken sentence and searching
directly compares conversational English against legal prose.

So instead, for each of four legal functions — obligation, exception, definition,
remedy — KRONOS writes the clause it would expect to exist if the assertion were
true, and searches with that. The exception form is weighted highest, because the
carve-out is the clause you cannot find by scrolling and the obligation is the one
the other side already quoted at you.

Cross-reference resolution then runs in **both** directions: forward to clauses a
retrieved clause cites, and backward to clauses that cite *it* and carry exception
language. The §4.2.1(b) carve-out is found largely because it points at §4.2.

---

## Privacy

| Guarantee | How it is enforced |
|---|---|
| No document ever leaves the machine | CSP `connect-src 'self'` — no third-party origin is reachable |
| No audio is persisted | Fixed 30-second ring buffer, overwritten continuously, dropped on stop |
| Microphone state is always visible | Capture only occurs through `MicrophoneCapture`, which drives the indicator |
| Weights are local | `allowRemoteModels = false`; missing weights throw rather than fetching |
| Claim is verifiable | `PerformanceObserver` counts post-load requests in the debug overlay |

`connect-src 'self'` also blocks huggingface.co, which is why weights must be
vendored by `pnpm fetch-models` rather than pulled at runtime.

---

## Known limitations

1. **No Moss.** The single largest gap. Retrieval is a flat exact scan written
   here. The adapter seam exists and is one file.
2. **Whisper decode (~690 ms) exceeds the 350 ms paint budget.** Mitigated by
   provisional-transcript retrieval, not solved.
3. **Query expansion does not improve general recall** on this corpus, and
   marginally hurts rank-1 ordering. Its value is confined to adversarial
   carve-out cases.
4. **Single corpus.** All 50 assertions are scored against one 32-clause term
   sheet. Recall over 32 clauses is a far easier problem than over 3,000; these
   numbers should not be read as generalising to large document sets.
5. **Gate threshold calibrated in-sample.** n=50 is too small to hold out a
   meaningful validation fold.
6. **English-only ASR**, and far-field / accented accuracy is untested. This is
   the largest unquantified product risk: the demo environment is a quiet room
   with a close microphone, and a real negotiation is neither.
7. **Retrieval runs on the main thread.** SPEC calls for a worker; embedding at
   ~41 ms will briefly block interaction.
8. **Energy-based VAD**, not Silero — more susceptible to non-speech transients
   like keyboard noise and papers.
9. **Browser paint time is unmeasured** in the automated harness.

---

## Repository layout

```
packages/core        types, config constants, generated model fingerprints
packages/ingest      parsing, legal-boundary chunking, index building
packages/retrieval   embedder, index, expansion, fusion, stance, gate, moss seam
packages/audio       ring buffer, VAD, Whisper ASR, microphone, session, WAV
apps/web             Next.js HUD, chunk inspector, debug overlay
eval                 50 labelled assertions + benchmark harness
scripts              model and audio vendoring
```

---

## Provenance of these numbers

Every figure in this README is regenerated by `pnpm eval` and traceable to
`eval/results/calibration.json`, which includes per-item outcomes. If you change
the corpus, the models, or the expansion templates, re-run it — the numbers will
move, and they are supposed to.
