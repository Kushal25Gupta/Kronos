# KRONOS — Product Requirements Document

**Local-first recall copilot for high-stakes contract negotiation.**

| Field | Value |
|---|---|
| Version | v5 (supersedes internal v4 pitch) |
| Status | Draft — pre-implementation |
| Author | Project owner |
| Created | 2026-09-15 14:22 IST |
| Target submission | 2026-09-20 23:59 IST (YC Fall 2026 × Moss: The Zero Latency Builder Sprint) |
| Primary theme | Local-First AI & The Small Cloud |
| Secondary theme | Real-Time Voice & Conversational AI, Agent Reliability |

> [!IMPORTANT]
> Every performance number in this document is labelled either **`[TARGET]`** (a goal we
> have not yet measured) or **`[MEASURED]`** (produced by our own eval harness on named
> hardware). No number appears in the demo, README, or video without that label.
> This rule exists because the v4 pitch contained a latency figure that omitted the
> dominant term, and a single unsupported number destroys the credibility of all the others.

---

## 1. Summary

KRONOS gives a negotiator **perfect recall of their own documents, without breaking eye contact.**

During a live negotiation, the counterparty makes an assertion about the agreement
("your Q3 churn violates the minimums"). Finding the governing clause takes 10–60 seconds of
scrolling and Ctrl-F, and doing it visibly signals uncertainty. Meanwhile, the obvious fix —
piping live M&A audio and deal documents into a cloud LLM API — is not available to regulated
dealmakers.

KRONOS runs the entire pipeline **inside the browser tab**: voice activity detection, speech
recognition, embedding, and retrieval. After the initial asset load there is **zero network
egress**. A discreet keyboard trigger arms the listener; when the speaker finishes, the
relevant clauses from *your* document set appear on a heads-up panel, labelled by whether they
help you or hurt you.

Moss is the retrieval layer, and it is load-bearing: it is what makes in-browser,
no-vector-database, sub-10ms search over a contract corpus possible at all.

---

## 2. Positioning and the consent boundary

### 2.1 What changed from v4, and why

The v4 pitch framed KRONOS as a covert tool — "stealth," "the opponent never knows,"
"hunting them." That framing is abandoned. It is not a cosmetic change; it is a
correctness change.

Covertly recording a conversation without the consent of all parties is a criminal offence in
all-party-consent jurisdictions, including California, Illinois, Florida, Pennsylvania,
Washington, and Massachusetts — which is to say, most of the venues where M&A negotiations
actually happen. A product whose core pitch is non-consensual recording cannot be sold to an
enterprise, cannot pass a CISO review, and should not win a hackathon judged by people who
work at companies with a legal department.

### 2.2 The reframe

KRONOS is **your own side's recall copilot**. The user is a **party to the conversation**,
retrieving from **documents they already own and are authorised to read**.

| v4 framing (dropped) | v5 framing (adopted) |
|---|---|
| "Stealth" | "Discreet" |
| "The opponent never knows" | "You never have to look down" |
| Covert surveillance of a counterparty | Hands-down, heads-up recall of your own files |
| A weapon against the other side | Removing the latency between memory and speech |

### 2.3 Consent posture (hard requirements)

- **CR-1** — Audio is processed in a rolling in-memory ring buffer and is **never persisted
  to disk, never uploaded, and never retained after the utterance is transcribed.**
  KRONOS is not a recorder. There is no "save recording" feature and there will not be one.
- **CR-2** — The UI shows a **persistent, non-dismissible microphone state indicator**
  whenever the listener is armed. No hidden-capture mode ships.
- **CR-3** — The README, PRD, and video state plainly that the operator is responsible for
  complying with the recording and disclosure law of their jurisdiction, and that the
  intended deployment is a meeting the operator is a party to.
- **CR-4** — The product surfaces **only the operator's own documents.** KRONOS never
  attempts to infer, store, or profile the counterparty.

> [!NOTE]
> The "Ghost Trigger" UX survives this reframe completely intact. Its value was never
> secrecy from the other party — it was **not breaking eye contact and not visibly
> searching.** That is a real and defensible UX insight, and it is the thing we demo.

---

## 3. The problem, stated precisely

A negotiator operating on a 40–200 page agreement set faces three simultaneous constraints:

1. **Recall latency.** The governing clause exists and the negotiator has read it, but
   locating the exact language mid-sentence takes tens of seconds. The window in which a
   rebuttal is socially effective is roughly **3–8 seconds** after the assertion.
2. **Data residency.** Deal documents under an NDA, or in a regulated M&A process, cannot be
   sent to a third-party inference API. This eliminates essentially every cloud AI product.
3. **Presentation cost.** Visible searching — scrolling, typing, squinting at a laptop —
   communicates that you do not know your own agreement.

Existing tools fail at least one constraint:

| Tool | Recall latency | Data residency | Presentation cost |
|---|---|---|---|
| Ctrl-F in a PDF | Poor (keyword only, 10–60s) | Good | Poor |
| Cloud contract-AI (Harvey, Spellbook, etc.) | Moderate (1–5s) | **Fails** | Poor |
| A junior associate with the binder | Moderate | Good | Poor (whispering) |
| Memorisation | Good | Good | Good, but doesn't scale past ~20 pages |
| **KRONOS** | **Target sub-second** | **Good (no egress)** | **Good** |

---

## 4. Users

**Primary — "The Principal."** Partner, GC, or founder-CEO in a live negotiation. Low
tolerance for UI. Will not read a manual. Needs the answer in their peripheral vision. Judges
the product entirely on whether the right clause appeared.

**Secondary — "The Preparer."** Associate or deal-desk analyst who ingests the document set
the night before, verifies the chunking, and hands over a prepared session. This user tolerates
configuration and cares about coverage and correctness.

**Gatekeeper — "The CISO."** Never uses the product; can veto it. Cares only about what leaves
the machine. Satisfied by a network trace showing zero egress, not by adjectives.

---

## 5. Goals and non-goals

### 5.1 Goals

- **G-1** Sub-second, measured, from **end of the speaker's utterance** to clause rendered.
- **G-2** Retrieve the clause that is *responsive* to the assertion — including exceptions and
  carve-outs — not merely the clause most textually similar to it. (See §7, this is the hard part.)
- **G-3** Zero network egress after initial asset load, demonstrable in DevTools.
- **G-4** Never display a confidently-wrong clause. Degrade visibly instead. (See §8.)
- **G-5** Quote verbatim. No generative text in the retrieval path, therefore no fabricated clauses.

### 5.2 Non-goals for this build

Stated explicitly so scope stays honest:

- **NG-1** Not a recorder, transcriber-of-record, or minutes generator.
- **NG-2** Not legal advice. Retrieves text; does not interpret it.
- **NG-3** Not speaker diarisation. v1 does not distinguish who is talking.
- **NG-4** Not multi-party or synced-across-devices.
- **NG-5** Not a hardened enclave. See §9 for the calibrated security claim.
- **NG-6** Not a general-purpose data room. v1 targets a single active agreement set.

---

## 6. Latency: the honest budget

### 6.1 What we measure and why

The v4 pitch claimed ~450ms end-to-end while also specifying a 4–6 second audio capture
window. Those cannot both be true. Measured from the moment the counterparty begins speaking,
that system takes **five or more seconds**, because the capture window dominates every other term.

KRONOS therefore does two things differently:

1. **It streams.** Transcription runs incrementally on a rolling buffer *while* the person is
   still talking, rather than waiting for a fixed window to fill.
2. **It defines the metric precisely.** The number we report is
   **`t_paint − t_speech_end`**: from the moment voice-activity detection declares the
   utterance finished, to the moment the browser has painted the clause.

This is the interval the user actually experiences as "wait," and it is the only interval a
streaming architecture can legitimately claim credit for.

### 6.2 Budget

All values are **`[TARGET]`** until the eval harness fills them in.

| Stage | Symbol | Target p50 | Target p95 | Notes |
|---|---|---|---|---|
| VAD end-of-speech decision | `t_speech_end` | 0 (origin) | 0 | Hangover window accounted separately |
| Final ASR flush on tail audio | `t_asr_done` | 120 ms | 300 ms | Only the un-transcribed tail; body already streamed |
| Query construction / expansion | `t_query_built` | 5 ms | 15 ms | Template-based, no LLM |
| Embedding (N expanded queries) | `t_embed_done` | 25 ms | 60 ms | all-MiniLM-L6-v2, 384-dim, batched |
| **Moss retrieval** | `t_moss_done` | **< 10 ms** | **< 10 ms** | The sponsor-critical number |
| Rerank + stance labelling | `t_ranked` | 10 ms | 25 ms | Heuristic, in-thread |
| Render to paint | `t_paint` | 30 ms | 60 ms | Measured at rAF after commit |
| **Total (end-of-utterance → painted)** | | **~200 ms** | **~470 ms** | Reported with hardware named |

### 6.3 Reporting rules

- Always report **p50 and p95**, never a single flattering number.
- Always name the hardware and browser the measurement came from.
- Separately disclose the **cold-start cost** (model download + index hydration), which is
  seconds, not milliseconds, and is a real part of the user's experience.
- The on-screen timer in the demo video measures **`t_paint − t_speech_end`** and the video
  says so in text. Putting an unlabelled stopwatch on screen that silently starts at
  end-of-buffer would be manufacturing a favourable number, and is prohibited.

---

## 7. Retrieval quality: the actual hard problem

### 7.1 The failure that kills the demo

The counterparty asserts:

> "Your Q3 churn violates the minimums in the term sheet."

The clause that saves you:

> "Q3 churn is exempt from the minimums set out in §4.2 provided annual revenue exceeds $50M."

Embedding the assertion and taking nearest neighbours retrieves **clauses about churn
minimums** — ranked by topical similarity. The top hit is very likely §4.2 itself, the clause
that *states the obligation being used against you*. Semantic similarity to an assertion does
not retrieve that assertion's rebuttal. A naive embed-and-search pipeline produces a demo
that works on the one example it was tuned on and fails on anything a judge invents live.

This is the single most important engineering problem in the product.

### 7.2 The approach

**Multi-query expansion with rank fusion, then stance labelling.**

1. **Parse the assertion** into `{subject, obligation, instrument, qualifier}` —
   e.g. `{churn, minimum threshold, term sheet, Q3}`. Shallow heuristic extraction; no LLM.
2. **Expand into several hypothetical clause texts**, each embedded separately:
   - *Obligation form* — "Churn shall not exceed the minimum thresholds set forth herein."
   - *Exception form* — "Notwithstanding the foregoing, churn shall be exempt from the
     minimum thresholds provided that…"
   - *Definition form* — "'Churn' means…"
   - *Remedy form* — "In the event churn exceeds the thresholds, the remedy shall be…"
   
   This is HyDE in spirit, but template-driven so it costs microseconds and cannot hallucinate.
3. **Retrieve top-k from Moss for each expansion** and fuse with **Reciprocal Rank Fusion**.
   Because expansions are embedded as a batch and Moss is sub-10ms, the whole fan-out stays
   inside the latency budget.
4. **Label the stance of each surviving candidate** using structural and lexical legal signals:
   - *Exception markers*: "notwithstanding," "except," "provided that," "shall not apply,"
     "exempt," "carve-out," "unless."
   - *Obligation markers*: "shall," "must," "no less than," "at a minimum."
   - *Cross-reference resolution*: a clause citing §4.2 is pulled in alongside §4.2.
5. **Present 2–3 cards, ranked, each tagged** `SUPPORTS YOU` / `CUTS AGAINST YOU` /
   `CONTEXT`.

### 7.3 Why the stance labelling matters beyond accuracy

Showing the clause that hurts you is not a weakness — it is the difference between a search
box and a product. A negotiator who is about to be ambushed by §4.2 needs to know §4.2 exists.
Surfacing it, labelled, is more valuable than hiding it, and it is an honest answer to the
question "so where is the intelligence in this system, if you don't generate text?"

### 7.4 Requirements

- **R-1** Retrieval fans out over ≥3 query expansions and fuses results. `[P1]`
- **R-2** Every returned card carries a stance label and a confidence score. `[P1]`
- **R-3** Cards quote the source verbatim with document name and clause number. `[P0]`
- **R-4** Clicking a card reveals the surrounding context block. `[P2]`
- **R-5** The eval set includes an **adversarial subset** of assertions where naive
  single-query similarity retrieves the wrong clause, and we report our lift over that
  baseline. `[P1]`

---

## 8. Reliability: the amber state

**Whisper-tiny on low-SNR audio does not degrade gracefully — it fabricates fluent,
plausible sentences.** A laptop microphone four feet away, in a hard-surfaced conference room,
capturing a person who is not facing it, is exactly the input condition that produces this.
If the ASR invents "fern minimums," the rest of the pipeline will confidently retrieve
something, and the user will read out an irrelevant clause in a boardroom.

Requirements:

- **R-6** Compute a composite confidence from **(a)** ASR average token logprob / no-speech
  probability, **(b)** input SNR estimate from the VAD, and **(c)** top Moss similarity score
  and the margin between rank-1 and rank-2. `[P0]`
- **R-7** Three display states, driven by thresholds calibrated on the eval set — never
  hand-picked to make the demo look good: `[P0]`

| State | Condition | Display |
|---|---|---|
| **Green** | High confidence, clear rank-1 margin | Clause card, full text, stance label |
| **Amber** | Weak match or low margin | "No confident match — closest: §X.Y" collapsed, plus the recognised text so the user can see what was misheard |
| **Red** | ASR confidence below floor, or no voice detected | "Didn't catch that" — retrieval is not attempted |

- **R-8** The recognised transcript is always visible in small type, so the user can instantly
  tell the difference between "the system misheard me" and "my documents don't cover this." `[P0]`
- **R-9** Thresholds ship as named constants with the eval run that produced them recorded
  in the repo. `[P1]`

> This is the requirement that makes KRONOS a serious entry in the **Agent Reliability**
> theme, not just the Local-First theme. An honest "I don't know" is a feature.

---

## 9. Security: the calibrated claim

### 9.1 What we actually claim

> After initial asset load, KRONOS makes **no network requests**. Document text, embeddings,
> audio, and transcripts exist only in the tab's memory. Nothing is written to `localStorage`,
> `sessionStorage`, `IndexedDB`, the Cache API, or the filesystem. Closing the tab releases
> everything. This is demonstrated by a DevTools network trace and a storage inspection,
> both shown in the video.

### 9.2 What we explicitly do NOT claim

The v4 pitch said data is decrypted "strictly inside the WASM memory space" and therefore
protected. **This is not a security boundary.** WebAssembly linear memory is an ordinary
`ArrayBuffer` in the host JavaScript realm: fully readable from the console, from DevTools
memory snapshots, and from any script running in the origin. It is not an enclave, it is not
attested, and it does not defend against a compromised browser, a malicious extension, or
anyone with access to the unlocked machine.

We will say this out loud, in the PRD and in the video. Overclaiming security in front of
people who ship security is the fastest way to lose the room, and the *true* claim — no
egress, no persistence — is already a meaningfully better posture than any cloud alternative.

### 9.3 Threat model

| Threat | In scope | Mitigation / status |
|---|---|---|
| Deal text sent to a third-party inference API | Yes | Eliminated by design — no inference API exists in the pipeline |
| Deal text persisted to disk, recoverable later | Yes | No storage APIs used; verified by automated test |
| Audio retained after transcription | Yes | Ring buffer, overwritten; no recording feature |
| Passive network observer | Yes | No traffic to observe post-load |
| Shoulder-surfing the HUD | Partial | Compact panel; panic-hide hotkey `[P2]` |
| Malicious browser extension in the origin | **No** | Out of scope; stated plainly |
| Compromised OS / physical access to unlocked device | **No** | Out of scope; stated plainly |
| Cold-boot / memory forensics on the RAM | **No** | Out of scope; "evaporates instantly" is not a claim we make |

### 9.4 Deferred to roadmap (explicitly not built for this submission)

WebAuthn-derived key material, AES-256-GCM encrypted payload provisioning from an enterprise
server, and attested delivery are **described in the roadmap and not implemented.** WebAuthn
PRF extension support is inconsistent across browsers and would consume a full day of a
five-day build to produce a half-working feature that invites exactly the line of questioning
in §9.2. Scope down, say what you cut, and say why.

---

## 10. Functional requirements

### 10.1 Ingest (offline, pre-session)

- **F-1** Accept PDF and DOCX; extract text with layout awareness. `[P0]`
- **F-2** **Legal-boundary chunking.** Split on clause numbering (`4.2.1`, `(a)`, `(iv)`),
  headings, and defined-term blocks — never mid-sentence, never on a fixed token count. A
  retrieved chunk is always a complete, readable logical unit. `[P0]`
- **F-3** Each chunk carries: document name, clause path (`§4.2.1`), page, heading trail,
  and cross-references it cites. `[P0]`
- **F-4** Embed with all-MiniLM-L6-v2 (384-dim) and emit a Moss-ready index artifact. `[P0]`
- **F-5** A **chunk inspector** page renders every chunk so the Preparer can visually confirm
  nothing was mangled. Cheap to build, and it is the fastest way to catch a bad parse
  before it embarrasses you live. `[P1]`
- **F-6** Scanned/image PDFs are **detected and rejected with a clear error**, not silently
  processed into garbage. OCR is out of scope. `[P1]`

### 10.2 Session

- **F-7** Load models and index; show honest staged progress (bytes, not a fake spinner). `[P0]`
- **F-8** **Discreet trigger** — double-tap of a modifier key arms the listener; configurable;
  visible mic-state indicator at all times (per CR-2). `[P0]`
- **F-9** Rolling VAD segments speech and fires end-of-utterance. `[P0]`
- **F-10** Incremental ASR during speech; final flush at utterance end. `[P0]`
- **F-11** Query expansion → batch embed → Moss → RRF → stance labelling. `[P0/P1]`
- **F-12** HUD renders 1–3 stance-labelled cards, or the amber/red state. `[P0]`
- **F-13** Per-query timing breakdown available behind a `?debug=1` flag — every stage,
  every millisecond. This is what we screen-record for judges. `[P0]`
- **F-14** **Demo mode**: replay a bundled audio clip through the identical live pipeline.
  Not a mock, not a fake — the same code path, with recorded audio instead of a microphone.
  Exists because judges will open the deployed link on a laptop in a noisy room with no
  document set loaded, and must still see the product work. `[P0]`

---

## 11. Success metrics

| Metric | Target | How measured |
|---|---|---|
| p50 end-of-utterance → paint | < 350 ms | Eval harness, 50 runs, named hardware |
| p95 end-of-utterance → paint | < 700 ms | Same |
| Moss query time | < 10 ms | Instrumented directly |
| Recall@3 on eval set | ≥ 0.85 | 50 labelled assertion → clause pairs |
| Recall@3 on adversarial subset | ≥ 0.70 | The 15 assertions where naive similarity fails |
| Lift over naive single-query baseline | ≥ +15 pts recall@3 | Both pipelines run on the same set |
| False-confident rate | ≤ 5% | Green state shown while rank-1 is wrong |
| Cold start to interactive | < 15 s warm cache | Measured, disclosed, not hidden |
| Network bytes after load | **0** | Automated test asserts this |

> [!TIP]
> Almost no hackathon submission ships an eval harness. A chart with p50/p95 and a
> recall-vs-baseline bar is the cheapest possible way to look like an engineering team
> instead of a demo team. It is scheduled as a P1, not an "if there's time."

---

## 12. Scope and cut list

| Priority | Item | Rationale |
|---|---|---|
| **P0** | Moss in-browser validation spike | Everything is downstream of this. Hour one. |
| **P0** | Real-audio ASR spike (4 ft, hard room) | Gates the entire architecture. Do it tonight. |
| **P0** | Legal-boundary chunking + inspector | 80% of perceived quality |
| **P0** | Streaming VAD → ASR → embed → Moss → HUD | The core loop |
| **P0** | Amber / red confidence states | Reliability story; cheap |
| **P0** | Demo mode with bundled audio | Survives a judge's laptop |
| **P0** | Honest instrumentation + debug overlay | The proof |
| **P1** | Query expansion + RRF + stance labels | The differentiator |
| **P1** | Eval harness + charts | The credibility |
| **P1** | Zero-egress automated test | The CISO answer |
| **P2** | Panic-hide hotkey, card expansion, multi-doc | Polish |
| **P3** | WebAuthn + AES provisioning | **Roadmap only. Do not build.** |
| **P3** | OCR, diarisation, multi-party sync | **Roadmap only.** |

---

## 13. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | ASR unusable on realistic far-field audio | **Critical** | Spike tonight. Fallbacks: better model quant, headset/lapel mic stated as a requirement, Web Speech API comparison, demo-mode audio |
| 2 | Retrieval returns the harmful clause, not the carve-out | **Critical** | §7 expansion + RRF + stance labels; adversarial eval subset |
| 3 | Cold start too slow, judge closes the tab | High | Streamed load, progress in bytes, quantised models, demo mode ready immediately |
| 4 | Moss browser SDK doesn't behave as expected | High | Hour-one spike; thin adapter interface so the index layer is swappable |
| 5 | Running out of time on the security layer | High | Already cut to roadmap (§9.4) |
| 6 | Chunker breaks on a real contract | Medium | Inspector page; curated demo corpus; reject scanned PDFs loudly |
| 7 | Judge tries a live off-script assertion and gets nothing | Medium | Amber state means "nothing" is a designed outcome, not a crash |
| 8 | Consent/legal objection from a judge | Medium | §2 reframe; explicit disclosure in video and README |

> [!WARNING]
> Risks 1 and 2 are the ones that end the project. Both are resolved by experiments that cost
> under two hours each and are scheduled before any product code is written. Do not build the
> UI first.

---

## 14. Five-day plan

Time remaining at authoring: **5 days, 9 hours** (2026-09-15 14:22 IST → 2026-09-20 23:59 IST).
Internal submission target is **2026-09-20 20:00 IST**, leaving four hours of buffer.

| Day | Date | Objective | Gate to pass before moving on |
|---|---|---|---|
| 0 | Sep 15 (PM) | Spikes: Moss in browser; far-field Whisper-tiny; MiniLM in browser | Do all three work? If ASR fails, change architecture **now** |
| 1 | Sep 16 | Ingest: parse → legal-boundary chunk → embed → Moss index + inspector page | Chunks are clean on the real demo contract |
| 2 | Sep 17 | Live loop: mic → VAD → streaming ASR → embed → Moss → basic HUD | End-to-end works once, live, with instrumentation |
| 3 | Sep 18 | Query expansion, RRF, stance labels, confidence states, HUD polish | Adversarial assertion retrieves the carve-out |
| 4 | Sep 19 | Eval harness, charts, zero-egress test, cold-start work, **deploy** | Public URL works on a clean machine |
| 5 | Sep 20 | Video, architecture diagram, README/PRD final, submit by 20:00 IST | Submitted with buffer |

---

## 15. Demo video plan

Ninety seconds, three beats. The sponsor is grading how Moss is used; the judges are grading
whether it is real.

1. **The problem (0:00–0:15).** Two people at a table. An assertion is made about the
   agreement. Cut to a person scrolling a PDF while the room waits. That silence is the product.
2. **The product (0:15–0:55).** Same assertion. Discreet trigger. Cut to the screen: the
   on-screen timer — **labelled "end of utterance → clause on screen"** — and the clause
   card appears with its stance label. Then, immediately, the credibility shots:
   DevTools network panel with **zero requests**; the debug overlay showing the per-stage
   breakdown with **Moss at single-digit milliseconds**; and one deliberate amber state
   showing the system declining to guess.
3. **Why Moss (0:55–1:30).** Explicitly: the corpus is embedded and searched **in the tab**,
   with no vector database and no server, which is what makes the no-egress guarantee possible
   at all. Show p50/p95 from the eval harness and the recall-vs-baseline chart. Close on the
   honest scope statement: what is built, what is roadmap.

Rules for the video: every number on screen carries its definition; the network panel is shown
unedited; nothing is faked.

---

## 16. Explicitly rejected advice

Recorded so the reasoning is not relitigated later.

| Suggestion | Decision | Why |
|---|---|---|
| "Constrain the corpus to stay under the 2–4 GB WASM memory limit" | **Rejected reasoning, kept the action** | The arithmetic doesn't support it: 200 chunks × 384 dims × 4 bytes ≈ 300 KB; even 10,000 pages is ~150 MB. The real constraint is **model download and cold start**, not corpus size. We constrain the demo corpus for cold-start and chunk-quality reasons, and we will say that, because a judge who does the multiplication will otherwise conclude we don't understand our own system. |
| "Fake the edges if you have to" | **Rejected** | The submission requires a public deployed link. Judges click it unsupervised. Faked functionality behind a live URL gets discovered, and costs more than the missing feature. We cut scope and disclose it instead. |
| "Overlay a counter to prove the ~450ms" | **Rejected as stated; adopted corrected** | An unlabelled counter starting at end-of-buffer displays a number we know is misleading. We overlay a counter that measures `t_paint − t_speech_end` and label it on screen. |
| "WASM memory bypasses compliance nightmares" | **Rejected** | It is not a security boundary (§9.2). |
| Amber "no confident match" state | **Adopted** | Correct, cheap, and directly serves the Agent Reliability theme. |
| Far-field mic SNR is the real risk | **Adopted, promoted to Risk #1** | The strongest point in the external review. Whisper-tiny fabricates on poor input, which defeats the "zero hallucinations" claim at the input layer. |
| Constrain the demo to one high-value contract | **Adopted** (for corrected reasons) | Cold start and chunk quality |

---

## 17. Open questions

1. Which ASR configuration survives the far-field test — and if none do, does the product
   require a stated hardware assumption (lapel/directional mic)? **Resolved by the Day-0 spike.**
2. Does the Moss browser SDK expose per-query timing, or must we wrap it?
3. What is the real cold-start cost on a mid-range laptop over conference-room Wi-Fi?
4. Do we need a cross-encoder rerank, or do the lexical stance heuristics carry it?
5. Which contract becomes the demo corpus? Must be public-domain or synthetic — **do not use
   any real confidential agreement in a public repo.**

---

## 18. Roadmap beyond the hackathon

- WebAuthn-gated, AES-256-GCM encrypted index provisioning from an enterprise server
- Origin Private File System for encrypted at-rest caching of large data rooms
- Speaker diarisation to distinguish your side from theirs
- Cross-encoder reranking; fine-tuned legal embeddings
- Native desktop shell for real system-audio capture and a hardware trigger
- Multi-document conflict detection ("§4.2 of the SPA contradicts §7 of the side letter")
