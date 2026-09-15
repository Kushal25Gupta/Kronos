"use client";

import React from "react";
import { GateState } from "@kronos/core";

interface TranscriptStripProps {
  transcript: string;
  gateState: GateState;
  totalMs: number;
  vectorSearchMs: number;
}

export const TranscriptStrip: React.FC<TranscriptStripProps> = ({
  transcript,
  gateState,
  totalMs,
  vectorSearchMs,
}) => {
  return (
    <div
      style={{
        padding: "8px 12px",
        backgroundColor: "#090d16",
        borderTop: "1px solid #30363d",
        fontSize: "12px",
        fontFamily: "monospace",
        color: "#8b949e",
        display: "flex",
        flexDirection: "column",
        gap: "3px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span
          style={{
            color: "#c9d1d9",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "280px",
          }}
          title={transcript}
        >
          heard: &ldquo;{transcript || "—"}&rdquo;
        </span>
        <span style={{ color: "#58a6ff", fontWeight: 600 }}>
          {totalMs > 0 ? `${Math.round(totalMs)} ms` : "—"} · search {vectorSearchMs.toFixed(1)} ms
        </span>
      </div>
      <div style={{ fontSize: "10px", color: "#6e7681" }}>
        Metric: t_paint − t_speech_end (end-of-utterance → clause painted) · state: {gateState.toUpperCase()}
      </div>
    </div>
  );
};
