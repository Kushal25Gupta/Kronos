# KRONOS — Evaluation Results

**Generated:** 2026-09-15T14:37:04.298Z
**Hardware:** AMD EPYC 7B12 (24 cores, Node v24.18.0, linux 7.1.6-1rodete1-amd64)
**Embedding model:** `sha256:afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`
**Corpus:** `samples/term_sheet_v4.md` — 32 legal-boundary chunks
**Dataset:** 50 labelled assertions (15 adversarial)
**Retrieval backend:** flat exact in-memory search (no Moss SDK — see README)

---

## 1. Retrieval quality — MEASURED

Gold set for standard items includes `acceptableChunkIds`. Adversarial items are
scored strictly against `goldChunkIds` only: for those, retrieving the obligation
instead of the carve-out counts as a miss, because surfacing the rule the other
side just quoted at you is not a useful answer.

| Metric | KRONOS | Naive single-query baseline | Lift |
|---|---|---|---|
| Recall@1 | **76%** | 78% | -2.0 pts |
| Recall@3 | **94%** | 94% | **0 pts** |
| Recall@5 | **94%** | 94% | 0.0 pts |
| MRR | **0.847** | 0.857 | -0.010 |

### Adversarial subset (n=15) — the carve-out cases

| Metric | KRONOS | Naive baseline | Lift |
|---|---|---|---|
| Recall@1 | **60%** | 33.3% | 26.7 pts |
| Recall@3 | **93.3%** | 80% | **13.3 pts** |

Both arms use the same real embeddings, the same index, and the same corpus. The
only difference is multi-query expansion + RRF + cross-reference resolution.

---

## 2. Latency

### Retrieval pipeline — MEASURED (n=50)

Observed values, unmodified. No floors, no clamps, no substituted constants.

| Stage | p50 | p95 | Mean | Budget | Status |
|---|---|---|---|---|---|
| Assertion parse + expansion | 0.07 ms | 0.55 ms | 0.12 ms | — | — |
| MiniLM embedding (4 queries) | 41.1 ms | 52.02 ms | 42.16 ms | — | — |
| Vector search (flat exact) | **0.1 ms** | **0.33 ms** | 0.22 ms | < 10 ms | PASS |
| RRF + xref + stance | 0.31 ms | 2.03 ms | 0.57 ms | — | — |
| **Text in → ranked clauses out** | **41.79 ms** | **53.12 ms** | 43.08 ms | — | — |

### Whisper decode latency — MEASURED

Measured on an 11-second recording of natural English speech (samples/audio/jfk.wav), sliced to each duration, 3 repeats each, after a warm-up pass.

| Utterance length | Mean decode | Min | Max | Real-time factor |
|---|---|---|---|---|
| 2s | **722.3 ms** | 699.2 ms | 743.5 ms | 0.361 |
| 3s | **782.8 ms** | 711.1 ms | 875.0 ms | 0.261 |
| 5s | **774.5 ms** | 752.0 ms | 809.3 ms | 0.155 |

> Whisper is not a streaming model: it decodes a complete segment. A single
> decode beginning at `t_speech_end` therefore cannot meet the 350 ms paint
> budget for utterances of realistic length. KRONOS mitigates this with trailing
> partial decodes during speech and fires retrieval on the provisional
> transcript (`ListeningSession`), but the mitigation shifts the cost, it does
> not remove it. See "Known limitations".

### Browser paint — NOT MEASURED

`t_paint` cannot be observed from Node; there is no renderer. The end-of-utterance
→ painted-clause figure must be collected in-browser from the debug overlay
(`?debug=1`). It is deliberately left blank here rather than estimated.

### Composed end-to-end estimate

For a 5-second utterance: ~774 ms final Whisper decode + 41.8 ms retrieval + unmeasured paint. With the provisional-transcript path, retrieval starts at `t_speech_end` rather than after the decode, so perceived latency is dominated by paint plus the ~42 ms retrieval — but the authoritative transcript, and any correction it triggers, still arrives ~774 ms later.

---

## 3. Confidence gate — MEASURED

| Metric | Value | Target | Status |
|---|---|---|---|
| Green verdicts | 47 / 50 | — | — |
| Amber verdicts | 3 / 50 | — | — |
| False-confident (green but gold not retrieved) | 2 | — | — |
| **False-confident rate** | **4.26%** | ≤ 5% | PASS |

A false-confident is the only retrieval failure that actively harms the user: an
amber "no confident match" sends them to the document, whereas a confident wrong
clause invites them to argue from it.

### Threshold sweep

Coverage is the share of queries shown at all; false-confident is the share of
*shown* queries whose gold clause was not retrieved. Current operating point
`C_AMBER = 0.55` is marked.

| Threshold | Shown | Coverage | False-confident | Amber rate |
|---|---|---|---|---|
| 0.4 | 50/50 | 100% | 3 (6%) | 0% |
| 0.45 | 50/50 | 100% | 3 (6%) | 0% |
| 0.5 | 50/50 | 100% | 3 (6%) | 0% |
| **0.55** ← | 47/50 | 94% | 2 (4.3%) | 6% |
| 0.6 | 47/50 | 94% | 2 (4.3%) | 6% |
| 0.65 | 46/50 | 92% | 1 (2.2%) | 8% |
| 0.7 | 45/50 | 90% | 1 (2.2%) | 10% |
| 0.75 | 43/50 | 86% | 1 (2.3%) | 14% |
| 0.8 | 38/50 | 76% | 1 (2.6%) | 24% |

> [!IMPORTANT]
> The threshold was selected using this same 50-item set, so the false-confident
> rate above is an **in-sample** figure and is optimistic. It is not a held-out
> estimate of production behaviour. With n=50 there is not enough data to split
> a meaningful validation fold; treating this number as a generalisation bound
> would be wrong.


---

## 4. Known limitations

1. **No Moss.** Retrieval is exact flat search implemented in this repository.
   No Moss SDK was resolvable from public registries at build time. The adapter
   seam is in `packages/retrieval/src/moss-adapter.ts`.
2. **Whisper decode exceeds the paint budget** for utterances beyond ~2 seconds.
   Mitigated, not solved.
3. **Paint time unmeasured** in this harness.
4. **Single corpus.** All 50 assertions are scored against one term sheet of
   32 clauses. Recall on a 30-clause corpus is a substantially easier
   problem than on a 3,000-clause one, and these numbers should not be read as
   generalising to large document sets.
5. **English-only ASR** (`whisper-tiny.en`), and far-field / accented speech
   accuracy is untested.
6. **Confidence-gate inputs are fixed constants** in this harness, so the gate
   calibration reflects retrieval quality only, not end-to-end behaviour under
   real acoustic conditions.
