"use client";

import React from "react";
import { CONFIG, QueryOutcome, SessionState } from "@kronos/core";
import { ClauseCard } from "./ClauseCard.js";
import { MicIndicator } from "./MicIndicator.js";
import { TranscriptStrip } from "./TranscriptStrip.js";

interface HudProps {
  sessionState: SessionState;
  outcome: QueryOutcome | null;
  rmsLevel: number;
  isHidden: boolean;
  onToggleArm: () => void;
  onRunDemoAssertion: (text: string, isAmberDemo?: boolean, isRedDemo?: boolean) => void;
}

export const Hud: React.FC<HudProps> = ({
  sessionState,
  outcome,
  rmsLevel,
  isHidden,
  onToggleArm,
  onRunDemoAssertion,
}) => {
  if (isHidden) {
    return null;
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        width: `${CONFIG.ui.PANEL_WIDTH_PX}px`,
        backgroundColor: "#0d1117",
        border: "1px solid #30363d",
        borderRadius: "10px",
        boxShadow: "0 16px 48px rgba(0, 0, 0, 0.75)",
        overflow: "hidden",
        zIndex: 9000,
      }}
    >
      {/* 1. Always-visible Microphone Indicator (CR-2) */}
      <MicIndicator
        sessionState={sessionState}
        rmsLevel={rmsLevel}
        onToggleArm={onToggleArm}
      />

      {/* 2. Main card display area (Green / Amber / Red states) */}
      <div style={{ padding: "12px 12px 4px 12px" }}>
        {!outcome && (
          <div
            style={{
              padding: "20px 14px",
              textAlign: "center",
              color: "#8b949e",
              fontSize: "13px",
            }}
          >
            <div style={{ fontWeight: 600, color: "#c9d1d9", marginBottom: "6px" }}>
              KRONOS Armed · Term_Sheet_v4.moss Loaded
            </div>
            <div>
              Speak an assertion or click a bundled Demo Mode clip below to test live in-tab retrieval.
            </div>
          </div>
        )}

        {outcome && outcome.state === "green" && (
          <div>
            {outcome.results.map((res, idx) => (
              <ClauseCard
                key={res.chunk.id}
                result={res}
                vectorSearchMs={outcome.timing.vectorSearchMs}
                totalMs={outcome.timing.totalFromSpeechEnd}
                isTopCard={idx === 0}
              />
            ))}
          </div>
        )}

        {outcome && outcome.state === "amber" && (
          <div
            style={{
              backgroundColor: "rgba(210, 153, 34, 0.12)",
              borderLeft: "4px solid #d29922",
              border: "1px solid #d29922",
              borderRadius: "6px",
              padding: "14px",
              marginBottom: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "6px",
              }}
            >
              <span
                style={{
                  backgroundColor: "rgba(210, 153, 34, 0.25)",
                  color: "#e3b341",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  fontSize: "11px",
                  fontWeight: 700,
                }}
              >
                🟠 AMBER — NO CONFIDENT MATCH
              </span>
              <span style={{ fontFamily: "monospace", fontSize: "11px", color: "#8b949e" }}>
                composite {outcome.composite.toFixed(2)} &lt; C_AMBER (0.55)
              </span>
            </div>

            <div style={{ fontSize: "14px", color: "#f0f6fc", marginBottom: "6px" }}>
              KRONOS declined to guess to prevent false-confident boardroom claims.
              {outcome.results.length > 0 && (
                <span>
                  {" "}
                  Closest candidate:{" "}
                  <strong style={{ color: "#e3b341" }}>
                    {outcome.results[0].chunk.clauseLabel}
                  </strong>
                </span>
              )}
            </div>

            {outcome.results.length > 0 && (
              <details style={{ fontSize: "12px", color: "#c9d1d9", cursor: "pointer" }}>
                <summary style={{ color: "#58a6ff" }}>
                  Expand closest candidate ({outcome.results[0].chunk.clauseLabel})
                </summary>
                <div
                  style={{
                    marginTop: "6px",
                    padding: "8px",
                    backgroundColor: "#161b22",
                    borderRadius: "4px",
                    fontStyle: "italic",
                  }}
                >
                  &ldquo;{outcome.results[0].chunk.text}&rdquo;
                </div>
              </details>
            )}
          </div>
        )}

        {outcome && outcome.state === "red" && (
          <div
            style={{
              backgroundColor: "rgba(248, 81, 73, 0.12)",
              borderLeft: "4px solid #f85149",
              border: "1px solid #f85149",
              borderRadius: "6px",
              padding: "14px",
              marginBottom: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "6px",
              }}
            >
              <span
                style={{
                  backgroundColor: "rgba(248, 81, 73, 0.25)",
                  color: "#ff7b72",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  fontSize: "11px",
                  fontWeight: 700,
                }}
              >
                🔴 RED — DIDN&apos;T CATCH THAT
              </span>
              <span style={{ fontFamily: "monospace", fontSize: "11px", color: "#8b949e" }}>
                ASR floor gate
              </span>
            </div>
            <div style={{ fontSize: "13px", color: "#f0f6fc" }}>
              Input SNR or speech probability was below floor ({outcome.gateReason}). Retrieval was not attempted.
            </div>
          </div>
        )}
      </div>

      {/* 3. Always-visible Recognised Transcript Strip (R-8) */}
      <TranscriptStrip
        transcript={outcome?.transcript ?? ""}
        gateState={outcome?.state ?? "green"}
        totalMs={outcome?.timing.totalFromSpeechEnd ?? 0}
        vectorSearchMs={outcome?.timing.vectorSearchMs ?? 0}
      />
    </div>
  );
};
