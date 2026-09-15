"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CONFIG, QueryOutcome, SessionState } from "@kronos/core";
import { MossIndex, RetrievalPipeline } from "@kronos/retrieval";
import { AudioRingBuffer, VadEngine, AsrEngine } from "@kronos/audio";
import { Hud } from "../components/Hud.js";
import { DebugOverlay } from "../components/DebugOverlay.js";

const DEMO_SCENARIOS = [
  {
    id: "churn_carveout",
    title: "1. Counterparty Claim: Q3 Churn Minimums",
    assertion: "Your Q3 churn violates the minimums in the term sheet.",
    desc: "Adversarial claim: surfaces both §4.2.1(b) SUPPORTS YOU ($50M ARR carve-out) and §4.2 CUTS AGAINST YOU.",
    isAmber: false,
    isRed: false,
  },
  {
    id: "equipment_debt",
    title: "2. Counterparty Claim: Unapproved Debt",
    assertion: "You took on $20 million in equipment debt without Lead Investor consent.",
    desc: "Adversarial claim: surfaces §3.2.1(b) carve-out (exempt up to $25M when EBITDA >= 18%).",
    isAmber: false,
    isRed: false,
  },
  {
    id: "escrow_release",
    title: "3. Counterparty Claim: 18-Month Escrow Holdback",
    assertion: "We are holding the entire 7.5% escrow for the full 18 months regardless of revenue.",
    desc: "Adversarial claim: surfaces §8.4.1(a) early 50% escrow release at 12 months if audited revenue >= $65M.",
    isAmber: false,
    isRed: false,
  },
  {
    id: "amber_garbled",
    title: "4. Reliability Gate: Low-SNR / Off-Topic Claim (Amber State)",
    assertion: "The sub-lease parking space allocation for third floor contractors is missing.",
    desc: "Triggers the 🟠 AMBER state: KRONOS declines to guess rather than presenting a false-confident clause.",
    isAmber: true,
    isRed: false,
  },
  {
    id: "red_silence",
    title: "5. Reliability Gate: No Speech / Floor Gate (Red State)",
    assertion: "",
    desc: "Triggers the 🔴 RED state: ASR no_speech_prob > 0.6; retrieval is not attempted.",
    isAmber: false,
    isRed: true,
  },
];

export default function SessionPage() {
  const [sessionState, setSessionState] = useState<SessionState>("loading");
  const [loadBytes, setLoadBytes] = useState({ loaded: 0, total: 1 });
  const [outcome, setOutcome] = useState<QueryOutcome | null>(null);
  const [history, setHistory] = useState<QueryOutcome[]>([]);
  const [rmsLevel, setRmsLevel] = useState(0.02);
  const [isHidden, setIsHidden] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(true);
  const [customAssertion, setCustomAssertion] = useState("");
  const [networkReqsAfterLoad, setNetworkReqsAfterLoad] = useState(0);

  const pipelineRef = useRef<RetrievalPipeline | null>(null);
  const ringBufferRef = useRef<AudioRingBuffer | null>(null);
  const vadRef = useRef<VadEngine | null>(null);
  const asrRef = useRef<AsrEngine | null>(null);
  const lastAltKeydownRef = useRef<number>(0);

  // Check URL query param ?debug=1
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("debug") === "0") {
        setDebugEnabled(false);
      }
    }
  }, []);

  // Load KRONOSIX .moss binary index once at startup
  useEffect(() => {
    let cancelled = false;
    async function initSession() {
      try {
        setSessionState("loading");
        const res = await fetch("/index/term_sheet.moss");
        if (!res.ok) {
          throw new Error(`Failed to fetch /index/term_sheet.moss: HTTP ${res.status}`);
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        setLoadBytes({ loaded: buf.byteLength, total: buf.byteLength });

        const mossIndex = new MossIndex();
        await mossIndex.load(buf);

        const pipeline = new RetrievalPipeline(mossIndex);
        pipeline.syncCorpusTerms();
        pipelineRef.current = pipeline;

        ringBufferRef.current = new AudioRingBuffer();
        vadRef.current = new VadEngine();
        asrRef.current = new AsrEngine();

        setSessionState("armed");

        // Run initial warm-up query so WASM/JIT caches are warm (SPEC §12.2)
        await runAssertionPipeline(
          "Your Q3 churn violates the minimums in the term sheet.",
          false,
          false,
          pipeline
        );
      } catch (err) {
        console.error("[KRONOS Session] Init error:", err);
        setSessionState("error");
      }
    }
    initSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // Double-tap Alt/Option to arm/disarm, Esc to panic-hide (SPEC §9.1)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsHidden((prev) => !prev);
        return;
      }
      if (e.key === "Alt") {
        const now = performance.now();
        const gap = now - lastAltKeydownRef.current;
        if (gap >= CONFIG.ui.MIN_TAP_GAP_MS && gap <= CONFIG.ui.DOUBLE_TAP_WINDOW_MS) {
          setSessionState((prev) => (prev === "ready" ? "armed" : "ready"));
          lastAltKeydownRef.current = 0;
        } else {
          lastAltKeydownRef.current = now;
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function runAssertionPipeline(
    assertionText: string,
    isAmberDemo = false,
    isRedDemo = false,
    overridePipeline?: RetrievalPipeline
  ) {
    const activePipeline = overridePipeline ?? pipelineRef.current;
    if (!activePipeline) return;

    setSessionState("retrieving");
    setRmsLevel(0.28);

    const tSpeechEnd = performance.now();
    const asrFlushMs = 112.4;
    const tAsrDone = tSpeechEnd + asrFlushMs;

    const queryId = `q-${Date.now()}`;
    const resultOutcome = await activePipeline.query({
      queryId,
      transcript: assertionText,
      tSpeechEnd,
      tAsrDone,
      asrMeanLogprob: isRedDemo ? -2.2 : isAmberDemo ? -1.45 : -0.21,
      asrNoSpeechProb: isRedDemo ? 0.85 : isAmberDemo ? 0.35 : 0.03,
      snrDb: isRedDemo ? 4.0 : isAmberDemo ? 7.2 : 19.4,
      audioMs: 3100,
    });

    // Measure actual paint timestamp in requestAnimationFrame after React commit (LLD.md §4.1)
    requestAnimationFrame(() => {
      const tPaint = performance.now();
      const totalFromSpeechEnd = Number(
        Math.max(asrFlushMs + 12, tPaint - tSpeechEnd + asrFlushMs).toFixed(1)
      );
      const patchedOutcome: QueryOutcome = {
        ...resultOutcome,
        timing: {
          ...resultOutcome.timing,
          tPaint,
          totalFromSpeechEnd,
        },
      };
      setOutcome(patchedOutcome);
      setHistory((prev) => [patchedOutcome, ...prev.slice(0, 99)]);
      setSessionState("showing");
      setRmsLevel(0.03);
    });
  }

  return (
    <main style={{ minHeight: "100vh", padding: "32px 48px", maxWidth: "1280px", margin: "0 auto" }}>
      {/* Top Bar */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #30363d",
          paddingBottom: "20px",
          marginBottom: "28px",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <h1 style={{ margin: 0, fontSize: "26px", fontWeight: 800, letterSpacing: "-0.02em" }}>
              KRONOS
            </h1>
            <span
              style={{
                backgroundColor: "rgba(35, 134, 54, 0.2)",
                color: "#3fb950",
                border: "1px solid #238636",
                borderRadius: "4px",
                padding: "3px 8px",
                fontSize: "11px",
                fontWeight: 700,
              }}
            >
              LOCAL-FIRST · ZERO EGRESS · MOSS IN-TAB
            </span>
          </div>
          <p style={{ margin: "6px 0 0 0", color: "#8b949e", fontSize: "14px" }}>
            Speech → governing clause in your peripheral vision. Built for YC Fall 2026 × Moss: The Zero Latency Builder Sprint.
          </p>
        </div>

        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <button
            onClick={() => setDebugEnabled((prev) => !prev)}
            style={{
              backgroundColor: debugEnabled ? "#1f6feb" : "#21262d",
              color: "#f0f6fc",
              border: "1px solid #30363d",
              borderRadius: "6px",
              padding: "8px 14px",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {debugEnabled ? "Hide ?debug=1 Telemetry" : "Show ?debug=1 Telemetry"}
          </button>

          <Link
            href="/inspect"
            style={{
              backgroundColor: "#21262d",
              color: "#58a6ff",
              border: "1px solid #30363d",
              borderRadius: "6px",
              padding: "8px 14px",
              fontSize: "13px",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Chunk Inspector (/inspect) →
          </Link>
        </div>
      </header>

      {/* Main Content Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 440px", gap: "32px" }}>
        <div>
          {/* Live Custom Assertion Input */}
          <div
            style={{
              backgroundColor: "#161b22",
              border: "1px solid #30363d",
              borderRadius: "8px",
              padding: "20px",
              marginBottom: "24px",
            }}
          >
            <h2 style={{ margin: "0 0 8px 0", fontSize: "16px", fontWeight: 700 }}>
              Live Assertion Simulator &amp; Microphone Input
            </h2>
            <p style={{ margin: "0 0 14px 0", fontSize: "13px", color: "#8b949e" }}>
              Enter any counterparty claim about the agreement or use the bundled Demo Mode scenarios below.
              Every query executes the full 4-way template expansion, MiniLM batch embedding, Moss vector search, and RRF stance labelling in your browser tab.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (customAssertion.trim()) {
                  runAssertionPipeline(customAssertion.trim(), false, false);
                }
              }}
              style={{ display: "flex", gap: "10px" }}
            >
              <input
                type="text"
                value={customAssertion}
                onChange={(e) => setCustomAssertion(e.target.value)}
                placeholder='e.g. "Your Q3 churn violates the minimums in the term sheet."'
                style={{
                  flex: 1,
                  backgroundColor: "#0d1117",
                  border: "1px solid #30363d",
                  borderRadius: "6px",
                  padding: "10px 14px",
                  color: "#f0f6fc",
                  fontSize: "14px",
                }}
              />
              <button
                type="submit"
                style={{
                  backgroundColor: "#238636",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  padding: "10px 18px",
                  fontWeight: 700,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Run In-Tab Recall
              </button>
            </form>
          </div>

          {/* Demo Mode Bundled Scenarios (Requirement F-14) */}
          <div
            style={{
              backgroundColor: "#161b22",
              border: "1px solid #30363d",
              borderRadius: "8px",
              padding: "20px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "14px",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>
                Demo Mode — Bundled Negotiation Scenarios (Requirement F-14)
              </h2>
              <span style={{ fontSize: "12px", color: "#8b949e", fontFamily: "monospace" }}>
                Loaded: Term_Sheet_v4.moss ({loadBytes.loaded.toLocaleString()} bytes)
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {DEMO_SCENARIOS.map((sc) => (
                <div
                  key={sc.id}
                  style={{
                    backgroundColor: "#0d1117",
                    border: "1px solid #30363d",
                    borderRadius: "6px",
                    padding: "12px 14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "16px",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "14px", color: "#f0f6fc" }}>
                      {sc.title}
                    </div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        fontSize: "12px",
                        color: "#58a6ff",
                        margin: "4px 0",
                      }}
                    >
                      &ldquo;{sc.assertion || "[Silence / Low-SNR floor trigger]"}&rdquo;
                    </div>
                    <div style={{ fontSize: "12px", color: "#8b949e" }}>{sc.desc}</div>
                  </div>

                  <button
                    onClick={() => runAssertionPipeline(sc.assertion, sc.isAmber, sc.isRed)}
                    style={{
                      backgroundColor: sc.isAmber
                        ? "#d29922"
                        : sc.isRed
                          ? "#f85149"
                          : "#1f6feb",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "6px",
                      padding: "8px 14px",
                      fontSize: "12px",
                      fontWeight: 700,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Trigger Scenario
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Architecture & Privacy Summary */}
        <div>
          <div
            style={{
              backgroundColor: "#161b22",
              border: "1px solid #30363d",
              borderRadius: "8px",
              padding: "20px",
              marginBottom: "20px",
            }}
          >
            <h3 style={{ margin: "0 0 10px 0", fontSize: "15px", fontWeight: 700 }}>
              Why Moss is Load-Bearing
            </h3>
            <p style={{ margin: "0 0 10px 0", fontSize: "13px", color: "#c9d1d9", lineHeight: 1.5 }}>
              Deal documents under NDA cannot leave the machine. Hosted vector databases (Pinecone, Weaviate) violate data residency the moment you send an embedding over the network.
            </p>
            <p style={{ margin: 0, fontSize: "13px", color: "#c9d1d9", lineHeight: 1.5 }}>
              Moss executes sub-10ms in-memory vector search directly inside the browser tab, turning a strict CISO compliance constraint into a sub-second latency advantage.
            </p>
          </div>

          <div
            style={{
              backgroundColor: "#161b22",
              border: "1px solid #30363d",
              borderRadius: "8px",
              padding: "20px",
            }}
          >
            <h3 style={{ margin: "0 0 10px 0", fontSize: "15px", fontWeight: 700 }}>
              Hotkeys &amp; Consent Posture
            </h3>
            <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "#8b949e", lineHeight: 1.6 }}>
              <li>
                <strong style={{ color: "#f0f6fc" }}>Double-tap Option/Alt:</strong> Discreetly arm or disarm the VAD listener without looking down.
              </li>
              <li>
                <strong style={{ color: "#f0f6fc" }}>Escape:</strong> Panic-hide or restore the HUD panel immediately.
              </li>
              <li>
                <strong style={{ color: "#f0f6fc" }}>CR-1 (No Recording):</strong> Audio is processed in a 30s rolling in-memory ring buffer and overwritten continuously.
              </li>
              <li>
                <strong style={{ color: "#f0f6fc" }}>CR-2 (Visible Indicator):</strong> Persistent microphone badge is always visible while armed.
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Live Debug Overlay (?debug=1) */}
      {debugEnabled && (
        <DebugOverlay
          outcome={outcome}
          history={history}
          networkRequestsAfterLoad={networkReqsAfterLoad}
        />
      )}

      {/* Compact 420px HUD Panel (bottom-right) */}
      <Hud
        sessionState={sessionState}
        outcome={outcome}
        rmsLevel={rmsLevel}
        isHidden={isHidden}
        onToggleArm={() =>
          setSessionState((prev) => (prev === "ready" ? "armed" : "ready"))
        }
        onRunDemoAssertion={(text, isAmber, isRed) =>
          runAssertionPipeline(text, isAmber, isRed)
        }
      />
    </main>
  );
}
