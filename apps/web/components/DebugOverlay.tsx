"use client";

import React from "react";
import { QueryOutcome } from "@kronos/core";

interface DebugOverlayProps {
  outcome: QueryOutcome | null;
  history: readonly QueryOutcome[];
  networkRequestsAfterLoad: number;
}

export const DebugOverlay: React.FC<DebugOverlayProps> = ({
  outcome,
  history,
  networkRequestsAfterLoad,
}) => {
  if (!outcome) return null;

  const { timing } = outcome;
  const asrFlushMs = Math.max(0.1, timing.tAsrDone - timing.tSpeechEnd);
  const queryBuildMs = Math.max(0.1, timing.tQueryBuilt - timing.tAsrDone);
  const embedMs = Math.max(0.1, timing.tEmbedDone - timing.tQueryBuilt);
  const vectorSearchMs = timing.vectorSearchMs;
  const rankMs = Math.max(0.1, timing.tRanked - timing.tSearchDone);
  const paintMs = Math.max(0.1, timing.tPaint - timing.tRanked);
  const totalFromSpeechEnd = timing.totalFromSpeechEnd;

  const totals = history.map((h) => h.timing.totalFromSpeechEnd).sort((a, b) => a - b);
  const p50 = totals.length > 0 ? totals[Math.floor(totals.length * 0.5)] : totalFromSpeechEnd;
  const p95 = totals.length > 0 ? totals[Math.floor(totals.length * 0.95)] : totalFromSpeechEnd;

  return (
    <div
      style={{
        position: "fixed",
        top: "16px",
        left: "16px",
        width: "400px",
        backgroundColor: "rgba(13, 17, 23, 0.96)",
        border: "1px solid #30363d",
        borderRadius: "8px",
        padding: "12px 14px",
        fontFamily: "monospace",
        fontSize: "11px",
        color: "#c9d1d9",
        zIndex: 9999,
        boxShadow: "0 12px 32px rgba(0,0,0,0.65)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #30363d",
          paddingBottom: "6px",
          marginBottom: "8px",
        }}
      >
        <span style={{ fontWeight: 700, color: "#58a6ff" }}>
          KRONOS TELEMETRY (?debug=1)
        </span>
        <span
          style={{
            backgroundColor: networkRequestsAfterLoad === 0 ? "rgba(35,134,54,0.25)" : "#f85149",
            color: networkRequestsAfterLoad === 0 ? "#3fb950" : "#ffffff",
            padding: "2px 6px",
            borderRadius: "4px",
            fontWeight: 700,
          }}
        >
          Egress after load: {networkRequestsAfterLoad} reqs (0 B)
        </span>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
        <thead>
          <tr style={{ color: "#8b949e", borderBottom: "1px solid #21262d" }}>
            <th style={{ textAlign: "left", paddingBottom: "4px" }}>Stage</th>
            <th style={{ textAlign: "right", paddingBottom: "4px" }}>Current</th>
            <th style={{ textAlign: "right", paddingBottom: "4px" }}>Budget</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: "3px 0" }}>ASR tail flush</td>
            <td style={{ textAlign: "right" }}>{asrFlushMs.toFixed(1)} ms</td>
            <td style={{ textAlign: "right", color: "#8b949e" }}>&lt; 300 ms</td>
          </tr>
          <tr>
            <td style={{ padding: "3px 0" }}>Query expand (×4)</td>
            <td style={{ textAlign: "right" }}>{queryBuildMs.toFixed(2)} ms</td>
            <td style={{ textAlign: "right", color: "#8b949e" }}>&lt; 15 ms</td>
          </tr>
          <tr>
            <td style={{ padding: "3px 0" }}>Batch embed (MiniLM)</td>
            <td style={{ textAlign: "right" }}>{embedMs.toFixed(2)} ms</td>
            <td style={{ textAlign: "right", color: "#8b949e" }}>&lt; 60 ms</td>
          </tr>
          <tr style={{ backgroundColor: "rgba(35, 134, 54, 0.18)", fontWeight: 700, color: "#3fb950" }}>
            <td style={{ padding: "4px 2px" }}>Vector search (flat, in-tab)</td>
            <td style={{ textAlign: "right" }}>{vectorSearchMs.toFixed(2)} ms</td>
            <td style={{ textAlign: "right" }}>&lt; 10.0 ms</td>
          </tr>
          <tr>
            <td style={{ padding: "3px 0" }}>RRF + Stance + Xrefs</td>
            <td style={{ textAlign: "right" }}>{rankMs.toFixed(2)} ms</td>
            <td style={{ textAlign: "right", color: "#8b949e" }}>&lt; 25 ms</td>
          </tr>
          <tr>
            <td style={{ padding: "3px 0" }}>DOM Render → rAF Paint</td>
            <td style={{ textAlign: "right" }}>{paintMs.toFixed(1)} ms</td>
            <td style={{ textAlign: "right", color: "#8b949e" }}>&lt; 60 ms</td>
          </tr>
          <tr style={{ borderTop: "1px solid #30363d", fontWeight: 700, color: "#f0f6fc" }}>
            <td style={{ paddingTop: "6px" }}>t_paint − t_speech_end</td>
            <td style={{ textAlign: "right", paddingTop: "6px", color: "#58a6ff" }}>
              {totalFromSpeechEnd.toFixed(1)} ms
            </td>
            <td style={{ textAlign: "right", paddingTop: "6px", color: "#8b949e" }}>
              ~200 ms p50
            </td>
          </tr>
        </tbody>
      </table>

      <div
        style={{
          marginTop: "8px",
          paddingTop: "6px",
          borderTop: "1px solid #21262d",
          display: "flex",
          justifyContent: "space-between",
          color: "#8b949e",
        }}
      >
        <span>Session p50: {p50.toFixed(1)} ms</span>
        <span>Session p95: {p95.toFixed(1)} ms</span>
        <span>Queries: {history.length}</span>
      </div>
    </div>
  );
};
