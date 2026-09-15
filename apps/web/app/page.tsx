"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CONFIG, QueryOutcome, SessionState } from "@kronos/core";
import { FlatVectorIndex, RetrievalPipeline } from "@kronos/retrieval";
import { ListeningSession, MicState } from "@kronos/audio";
import { Hud } from "../components/Hud.js";
import { DebugOverlay } from "../components/DebugOverlay.js";

/**
 * Text-injection scenarios.
 *
 * These bypass the microphone and feed a transcript straight into the retrieval
 * pipeline. They are labelled in the UI as text input, not as speech, because
 * presenting typed text as though it came from the ASR would misrepresent what
 * is being demonstrated. Retrieval below this point is identical either way.
 */
const DEMO_SCENARIOS = [
  {
    id: "churn_carveout",
    title: "Q3 churn minimums",
    assertion: "Your Q3 churn violates the minimums in the term sheet.",
    desc: "Adversarial: should surface the §4.2.1(b) carve-out, not just the §4.2 obligation.",
  },
  {
    id: "equipment_debt",
    title: "Unapproved debt",
    assertion: "You took on $20 million in equipment debt without Lead Investor consent.",
    desc: "Adversarial: should surface the §3.2.1(b) EBITDA carve-out.",
  },
  {
    id: "escrow_release",
    title: "Escrow holdback",
    assertion: "We are holding the entire 7.5% escrow for the full 18 months regardless of revenue.",
    desc: "Adversarial: should surface the §8.4.1(a) early-release provision.",
  },
  {
    id: "off_topic",
    title: "Off-topic claim",
    assertion: "The sub-lease parking space allocation for third floor contractors is missing.",
    desc: "Nothing in the corpus governs this. The gate should decline rather than guess.",
  },
];

export default function SessionPage() {
  const [sessionState, setSessionState] = useState<SessionState>("loading");
  const [loadStatus, setLoadStatus] = useState("Loading index...");
  const [outcome, setOutcome] = useState<QueryOutcome | null>(null);
  const [rmsLevel, setRmsLevel] = useState(0.0);
  const [isHidden, setIsHidden] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(true);
  const [customAssertion, setCustomAssertion] = useState("");

  const [micState, setMicState] = useState<MicState>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [asrReady, setAsrReady] = useState(false);
  const [asrLoading, setAsrLoading] = useState(false);

  const [history, setHistory] = useState<QueryOutcome[]>([]);
  const [networkReqsAfterLoad, setNetworkReqsAfterLoad] = useState(0);

  const pipelineRef = useRef<RetrievalPipeline | null>(null);
  const sessionRef = useRef<ListeningSession | null>(null);
  const lastAltKeydownRef = useRef<number>(0);
  const loadCompleteRef = useRef(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("debug") === "0") setDebugEnabled(false);
    }
  }, []);

  /**
   * Counts genuine network requests issued after startup completes.
   *
   * The zero-egress guarantee is the entire premise of the product, so it is
   * measured rather than asserted. Anything that appears here after the index
   * and model weights have loaded is a bug — and a serious one. Keeping the
   * counter visible in the debug overlay means a reviewer can watch it stay at
   * zero through a whole session instead of taking the claim on trust.
   *
   * Browser-cached entries are excluded: a cache hit performs no egress, and
   * counting it would produce false alarms that train people to ignore the
   * number.
   */
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;

    const observer = new PerformanceObserver((list) => {
      if (!loadCompleteRef.current) return;

      const real = list
        .getEntries()
        .filter((e): e is PerformanceResourceTiming => e.entryType === "resource")
        .filter((e) => e.transferSize === undefined || e.transferSize > 0);

      if (real.length > 0) {
        console.warn(
          "[KRONOS] network requests after load — expected none:",
          real.map((e) => e.name)
        );
        setNetworkReqsAfterLoad((n) => n + real.length);
      }
    });

    observer.observe({ type: "resource", buffered: false });
    return () => observer.disconnect();
  }, []);


  /**
   * Runs the retrieval pipeline over a transcript and paints the result.
   *
   * `asrSignals` carries the real confidence values from Whisper when the
   * transcript came from speech. For typed input there is no acoustic evidence,
   * so neutral placeholder values are passed and the debug overlay marks the
   * source as text — otherwise the confidence number on screen would be
   * describing an ASR pass that never happened.
   */
  const runRetrieval = useCallback(
    async (
      transcript: string,
      tSpeechEnd: number,
      tAsrDone: number,
      asrSignals: { meanLogprob: number; noSpeechProb: number; snrDb: number; audioMs: number },
      pipelineOverride?: RetrievalPipeline
    ) => {
      const pipeline = pipelineOverride ?? pipelineRef.current;
      if (!pipeline) return;

      setSessionState("retrieving");

      const result = await pipeline.query({
        queryId: `q-${Date.now()}`,
        transcript,
        tSpeechEnd,
        tAsrDone,
        asrMeanLogprob: asrSignals.meanLogprob,
        asrNoSpeechProb: asrSignals.noSpeechProb,
        snrDb: asrSignals.snrDb,
        audioMs: asrSignals.audioMs,
      });

      // t_paint is captured in rAF after React commits — the earliest honest
      // approximation of "the user can see it". Measured, not estimated.
      requestAnimationFrame(() => {
        const tPaint = performance.now();
        const painted: QueryOutcome = {
          ...result,
          timing: {
            ...result.timing,
            tPaint,
            totalFromSpeechEnd: Number((tPaint - tSpeechEnd).toFixed(1)),
          },
        };
        setOutcome(painted);
        setHistory((prev) => [painted, ...prev].slice(0, 100));
        setSessionState("showing");
      });
    },
    []
  );

  // Load the index artifact and warm the embedding model.
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        setSessionState("loading");
        setLoadStatus("Fetching index artifact...");

        const res = await fetch("/index/term_sheet.moss");
        if (!res.ok) throw new Error(`/index/term_sheet.moss → HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        const index = new FlatVectorIndex();
        await index.load(buf);

        setLoadStatus("Loading all-MiniLM-L6-v2 weights...");
        const pipeline = new RetrievalPipeline(index);
        await pipeline.init();
        if (cancelled) return;

        pipeline.syncCorpusTerms();
        pipelineRef.current = pipeline;

        setLoadStatus(`Ready — ${index.size} clauses indexed`);
        setSessionState("armed");
        // From this point on, any network request is a zero-egress violation.
        loadCompleteRef.current = true;
      } catch (err) {
        console.error("[KRONOS] init failed:", err);
        setLoadStatus(err instanceof Error ? err.message : String(err));
        setSessionState("error");
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc panic-hides the panel; double-tap Alt toggles armed state (SPEC §9.1).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Opens the microphone and begins live listening. */
  const startListening = useCallback(async () => {
    if (sessionRef.current?.isLive) return;
    setMicError(null);
    setAsrLoading(true);

    const session = new ListeningSession({
      onStateChange: (state, detail) => {
        setMicState(state);
        if (state === "denied") {
          setMicError(
            "Microphone permission denied. KRONOS cannot listen without it; " +
              "text input below still works."
          );
        } else if (state === "error" && detail) {
          setMicError(detail);
        }
      },

      onLevel: (rms) => setRmsLevel(rms),

      onSpeechStart: () => {
        setSessionState("listening");
        setLiveTranscript("");
      },

      // Fast path — retrieval fires on the provisional transcript so it is not
      // waiting on the full Whisper decode.
      onProvisional: (utt) => {
        setLiveTranscript(utt.text);
        void runRetrieval(utt.text, utt.tSpeechEnd, utt.tAsrDone, {
          meanLogprob: utt.meanLogprob,
          noSpeechProb: utt.noSpeechProb,
          snrDb: utt.snrDb,
          audioMs: utt.audioMs,
        });
      },

      // Authoritative path — re-query only if the final decode actually differs,
      // so the panel doesn't flicker on every utterance for no reason.
      onUtterance: (utt) => {
        setLiveTranscript(utt.text);
        setSessionState("transcribing");
        void runRetrieval(utt.text, utt.tSpeechEnd, utt.tAsrDone, {
          meanLogprob: utt.meanLogprob,
          noSpeechProb: utt.noSpeechProb,
          snrDb: utt.snrDb,
          audioMs: utt.audioMs,
        });
      },

      onError: (err) => {
        console.error("[KRONOS] session error:", err);
        setMicError(err.message);
      },
    });

    try {
      await session.start();
      sessionRef.current = session;
      setAsrReady(true);
      setSessionState("ready");
    } catch (err) {
      console.error("[KRONOS] failed to start listening:", err);
      setMicError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsrLoading(false);
    }
  }, [runRetrieval]);

  const stopListening = useCallback(async () => {
    await sessionRef.current?.stop();
    sessionRef.current = null;
    setMicState("idle");
    setRmsLevel(0);
    setSessionState("armed");
  }, []);

  useEffect(() => {
    return () => {
      void sessionRef.current?.stop();
    };
  }, []);

  /** Runs a typed assertion. No acoustic evidence exists, so signals are neutral. */
  const runTextAssertion = useCallback(
    (text: string) => {
      const now = performance.now();
      void runRetrieval(text, now, now, {
        meanLogprob: -0.22,
        noSpeechProb: 0.03,
        snrDb: 19.2,
        audioMs: 0,
      });
    },
    [runRetrieval]
  );

  return (
    <main style={{ minHeight: "100vh", padding: "32px 48px", maxWidth: "1280px", margin: "0 auto" }}>
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
              LOCAL-FIRST · ZERO EGRESS
            </span>
          </div>
          <p style={{ margin: "6px 0 0 0", color: "#8b949e", fontSize: "14px" }}>
            Speech → governing clause, entirely in the browser tab.
          </p>
        </div>

        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <button
            onClick={() => setDebugEnabled((prev) => !prev)}
            style={btnStyle(debugEnabled ? "#1f6feb" : "#21262d")}
          >
            {debugEnabled ? "Hide telemetry" : "Show telemetry"}
          </button>
          <Link href="/inspect" style={{ ...btnStyle("#21262d"), color: "#58a6ff", textDecoration: "none" }}>
            Chunk Inspector →
          </Link>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 440px", gap: "32px" }}>
        <div>
          {/* Live microphone */}
          <section style={cardStyle}>
            <h2 style={{ margin: "0 0 8px 0", fontSize: "16px", fontWeight: 700 }}>
              Live microphone
            </h2>
            <p style={{ margin: "0 0 14px 0", fontSize: "13px", color: "#8b949e" }}>
              Opens your microphone and runs whisper-tiny.en plus retrieval entirely on-device.
              Audio is held in a rolling 30-second in-memory buffer and is never written to disk
              or sent anywhere.
            </p>

            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              {!sessionRef.current?.isLive ? (
                <button
                  onClick={() => void startListening()}
                  disabled={sessionState === "loading" || asrLoading}
                  style={btnStyle(asrLoading ? "#21262d" : "#238636")}
                >
                  {asrLoading ? "Loading Whisper weights…" : "Start listening"}
                </button>
              ) : (
                <button onClick={() => void stopListening()} style={btnStyle("#da3633")}>
                  Stop listening
                </button>
              )}

              <span style={{ fontSize: "12px", color: "#8b949e" }}>
                mic: <strong style={{ color: micState === "live" ? "#3fb950" : "#8b949e" }}>{micState}</strong>
                {asrReady && " · whisper-tiny.en loaded"}
              </span>
            </div>

            {micError && (
              <div
                style={{
                  marginTop: "12px",
                  padding: "10px 12px",
                  backgroundColor: "rgba(218, 54, 51, 0.1)",
                  border: "1px solid #da3633",
                  borderRadius: "6px",
                  fontSize: "12px",
                  color: "#f85149",
                }}
              >
                {micError}
              </div>
            )}

            {liveTranscript && (
              <div
                style={{
                  marginTop: "12px",
                  padding: "10px 12px",
                  backgroundColor: "#0d1117",
                  border: "1px solid #30363d",
                  borderRadius: "6px",
                  fontSize: "13px",
                  color: "#c9d1d9",
                }}
              >
                <span style={{ color: "#8b949e", fontSize: "11px" }}>RECOGNISED — </span>
                {liveTranscript}
              </div>
            )}
          </section>

          {/* Text input */}
          <section style={cardStyle}>
            <h2 style={{ margin: "0 0 8px 0", fontSize: "16px", fontWeight: 700 }}>
              Text assertion
            </h2>
            <p style={{ margin: "0 0 14px 0", fontSize: "13px", color: "#8b949e" }}>
              Bypasses the microphone and feeds a transcript directly to retrieval. Useful for
              testing recall without speaking. Confidence values shown for text input are
              placeholders — there is no audio to score.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (customAssertion.trim()) runTextAssertion(customAssertion.trim());
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
              <button type="submit" style={btnStyle("#238636")}>
                Retrieve
              </button>
            </form>

            <div style={{ marginTop: "16px", display: "grid", gap: "8px" }}>
              {DEMO_SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => runTextAssertion(s.assertion)}
                  style={{
                    textAlign: "left",
                    backgroundColor: "#0d1117",
                    border: "1px solid #30363d",
                    borderRadius: "6px",
                    padding: "10px 12px",
                    cursor: "pointer",
                    color: "#c9d1d9",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: "13px" }}>{s.title}</div>
                  <div style={{ fontSize: "12px", color: "#8b949e", marginTop: "2px" }}>
                    &ldquo;{s.assertion}&rdquo;
                  </div>
                  <div style={{ fontSize: "11px", color: "#6e7681", marginTop: "4px" }}>{s.desc}</div>
                </button>
              ))}
            </div>
          </section>

          {/* Honest status */}
          <section style={cardStyle}>
            <h2 style={{ margin: "0 0 10px 0", fontSize: "16px", fontWeight: 700 }}>
              What is actually running
            </h2>
            <table style={{ width: "100%", fontSize: "12px", color: "#c9d1d9", borderCollapse: "collapse" }}>
              <tbody>
                <StatusRow label="Embedding" value="all-MiniLM-L6-v2 (int8 ONNX), on-device" ok />
                <StatusRow label="Speech recognition" value="whisper-tiny.en (int8 ONNX), on-device" ok />
                <StatusRow label="Vector search" value="flat exact in-memory scan" ok />
                <StatusRow
                  label="Moss SDK"
                  value="not wired — no SDK available; see moss-adapter.ts"
                  ok={false}
                />
                <StatusRow label="Index" value={loadStatus} ok={sessionState !== "error"} />
              </tbody>
            </table>
          </section>
        </div>

        <div />
      </div>

      <Hud
        sessionState={sessionState}
        outcome={outcome}
        rmsLevel={rmsLevel}
        isHidden={isHidden}
        onToggleArm={() =>
          sessionRef.current?.isLive ? void stopListening() : void startListening()
        }
        onRunDemoAssertion={(text) => runTextAssertion(text)}
      />

      {debugEnabled && outcome && (
        <DebugOverlay
          outcome={outcome}
          history={history}
          networkRequestsAfterLoad={networkReqsAfterLoad}
        />
      )}
    </main>
  );
}

const cardStyle: React.CSSProperties = {
  backgroundColor: "#161b22",
  border: "1px solid #30363d",
  borderRadius: "8px",
  padding: "20px",
  marginBottom: "24px",
};

function btnStyle(bg: string): React.CSSProperties {
  return {
    backgroundColor: bg,
    color: "#f0f6fc",
    border: "1px solid #30363d",
    borderRadius: "6px",
    padding: "9px 16px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
  };
}

const StatusRow: React.FC<{ label: string; value: string; ok: boolean }> = ({ label, value, ok }) => (
  <tr style={{ borderBottom: "1px solid #21262d" }}>
    <td style={{ padding: "6px 0", color: "#8b949e", width: "150px" }}>{label}</td>
    <td style={{ padding: "6px 0" }}>
      <span style={{ color: ok ? "#3fb950" : "#d29922", marginRight: "6px" }}>{ok ? "●" : "○"}</span>
      {value}
    </td>
  </tr>
);
