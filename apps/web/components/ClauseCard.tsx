"use client";

import React, { useState } from "react";
import { RankedResult, Stance } from "@kronos/core";

interface ClauseCardProps {
  result: RankedResult;
  mossMs: number;
  totalMs: number;
  isTopCard?: boolean;
}

const STANCE_CONFIG: Record<
  Stance,
  { label: string; borderColor: string; badgeBg: string; badgeColor: string }
> = {
  supports: {
    label: "SUPPORTS YOU",
    borderColor: "#238636",
    badgeBg: "rgba(35, 134, 54, 0.22)",
    badgeColor: "#3fb950",
  },
  against: {
    label: "CUTS AGAINST YOU",
    borderColor: "#d29922",
    badgeBg: "rgba(210, 153, 34, 0.22)",
    badgeColor: "#e3b341",
  },
  context: {
    label: "CONTEXT",
    borderColor: "#6e7681",
    badgeBg: "rgba(110, 118, 129, 0.22)",
    badgeColor: "#8b949e",
  },
};

function highlightMatchedSpans(text: string, matchedTerms: readonly string[]): React.ReactNode {
  if (!matchedTerms || matchedTerms.length === 0) return text;
  const validTerms = matchedTerms
    .map((t) => t.trim())
    .filter((t) => t.length > 2)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (validTerms.length === 0) return text;

  const regex = new RegExp(`(${validTerms.join("|")})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, idx) =>
    regex.test(part) ? (
      <strong key={idx} style={{ color: "#ffffff", fontWeight: 700, textDecoration: "underline", textDecorationColor: "rgba(88,166,255,0.6)" }}>
        {part}
      </strong>
    ) : (
      part
    )
  );
}

export const ClauseCard: React.FC<ClauseCardProps> = ({
  result,
  mossMs,
  totalMs,
  isTopCard = false,
}) => {
  const [showReasons, setShowReasons] = useState(false);
  const cfg = STANCE_CONFIG[result.stance];

  return (
    <div
      className="kronos-crossfade"
      style={{
        backgroundColor: "#161b22",
        borderLeft: `4px solid ${cfg.borderColor}`,
        borderTop: "1px solid #30363d",
        borderRight: "1px solid #30363d",
        borderBottom: "1px solid #30363d",
        borderRadius: "6px",
        padding: "12px 14px",
        marginBottom: "10px",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "8px",
        }}
      >
        <span
          style={{
            backgroundColor: cfg.badgeBg,
            color: cfg.badgeColor,
            padding: "2px 8px",
            borderRadius: "4px",
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.05em",
          }}
        >
          {cfg.label}
        </span>

        <span
          style={{
            fontFamily: "monospace",
            fontSize: "12px",
            color: "#8b949e",
            fontWeight: 600,
          }}
        >
          {result.chunk.docTitle} · {result.chunk.clauseLabel}
        </span>
      </div>

      {/* Verbatim clause body (>= 16px, line-height 1.5 per SPEC §9.3) */}
      <div
        style={{
          fontSize: "16px",
          lineHeight: 1.5,
          color: "#f0f6fc",
          marginBottom: "8px",
          fontFamily: "Georgia, 'Times New Roman', serif",
        }}
      >
        &ldquo;{highlightMatchedSpans(result.chunk.text, result.matchedTerms)}&rdquo;
      </div>

      {/* Footer row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: "11px",
          color: "#8b949e",
          fontFamily: "monospace",
        }}
      >
        <div>
          conf {result.stanceConfidence.toFixed(2)}
          {isTopCard && ` · ${Math.round(totalMs)} ms · Moss ${mossMs.toFixed(1)} ms`}
        </div>

        <button
          onClick={() => setShowReasons((prev) => !prev)}
          style={{
            background: "transparent",
            border: "none",
            color: "#58a6ff",
            fontSize: "11px",
            cursor: "pointer",
            padding: 0,
            fontFamily: "monospace",
          }}
        >
          why? ⓘ
        </button>
      </div>

      {showReasons && (
        <div
          style={{
            marginTop: "8px",
            paddingTop: "8px",
            borderTop: "1px dashed #30363d",
            fontSize: "11px",
            color: "#c9d1d9",
            fontFamily: "monospace",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "4px", color: "#58a6ff" }}>
            Stance &amp; Retrieval Provenance:
          </div>
          {result.stanceReasons.map((r, idx) => (
            <div key={idx}>• {r}</div>
          ))}
          {result.chunk.headingTrail.length > 0 && (
            <div style={{ marginTop: "4px", color: "#8b949e" }}>
              Trail: {result.chunk.headingTrail.join(" › ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
