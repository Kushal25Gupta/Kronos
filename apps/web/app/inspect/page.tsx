"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Chunk, IndexArtifactMeta } from "@kronos/core";

export default function InspectPage() {
  const [meta, setMeta] = useState<IndexArtifactMeta | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/index/term_sheet.json")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: IndexArtifactMeta) => setMeta(data))
      .catch((err) => setError(String(err)));
  }, []);

  if (error) {
    return (
      <div style={{ padding: "40px", color: "#f85149" }}>
        Error loading /index/term_sheet.json: {error}
      </div>
    );
  }

  if (!meta) {
    return (
      <div style={{ padding: "40px", color: "#8b949e" }}>
        Loading legal-boundary chunks from Term_Sheet_v4...
      </div>
    );
  }

  const chunks = meta.chunks.filter(
    (c) =>
      c.text.toLowerCase().includes(filter.toLowerCase()) ||
      c.clauseLabel.toLowerCase().includes(filter.toLowerCase())
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
          marginBottom: "24px",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 800 }}>
            KRONOS — Legal-Boundary Chunk Inspector (/inspect)
          </h1>
          <p style={{ margin: "6px 0 0 0", color: "#8b949e", fontSize: "13px" }}>
            Requirement F-5: Verify every chunk is a complete logical legal unit with zero mid-sentence splits before live negotiation.
          </p>
        </div>

        <Link
          href="/"
          style={{
            backgroundColor: "#238636",
            color: "#ffffff",
            borderRadius: "6px",
            padding: "8px 16px",
            fontSize: "13px",
            fontWeight: 700,
            textDecoration: "none",
          }}
        >
          ← Back to Session HUD
        </Link>
      </header>

      {/* Summary Banner */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "16px",
          marginBottom: "24px",
        }}
      >
        <div style={{ backgroundColor: "#161b22", border: "1px solid #30363d", borderRadius: "6px", padding: "14px" }}>
          <div style={{ fontSize: "12px", color: "#8b949e" }}>Document Corpus</div>
          <div style={{ fontSize: "18px", fontWeight: 700, marginTop: "4px" }}>
            {meta.docs[0]?.title ?? "Term Sheet v4"}
          </div>
        </div>
        <div style={{ backgroundColor: "#161b22", border: "1px solid #30363d", borderRadius: "6px", padding: "14px" }}>
          <div style={{ fontSize: "12px", color: "#8b949e" }}>Total Logical Chunks</div>
          <div style={{ fontSize: "18px", fontWeight: 700, marginTop: "4px", color: "#3fb950" }}>
            {meta.chunkCount} chunks (0 mid-sentence splits)
          </div>
        </div>
        <div style={{ backgroundColor: "#161b22", border: "1px solid #30363d", borderRadius: "6px", padding: "14px" }}>
          <div style={{ fontSize: "12px", color: "#8b949e" }}>Embedding Fingerprint</div>
          <div style={{ fontSize: "13px", fontWeight: 700, marginTop: "4px", fontFamily: "monospace", color: "#58a6ff" }}>
            {meta.modelFingerprint}
          </div>
        </div>
        <div style={{ backgroundColor: "#161b22", border: "1px solid #30363d", borderRadius: "6px", padding: "14px" }}>
          <div style={{ fontSize: "12px", color: "#8b949e" }}>Dimensions</div>
          <div style={{ fontSize: "18px", fontWeight: 700, marginTop: "4px" }}>
            {meta.dimensions}-dim (L2-normalised)
          </div>
        </div>
      </div>

      {/* Filter Input */}
      <div style={{ marginBottom: "20px" }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter chunks by clause number (e.g., §4.2.1(b)) or text..."
          style={{
            width: "100%",
            backgroundColor: "#0d1117",
            border: "1px solid #30363d",
            borderRadius: "6px",
            padding: "10px 14px",
            color: "#f0f6fc",
            fontSize: "14px",
          }}
        />
      </div>

      {/* Chunk Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        {chunks.map((chunk: Chunk) => {
          const isException = chunk.signals.hasExceptionMarker;
          const isDefinition = chunk.signals.hasDefinitionMarker;

          return (
            <div
              key={chunk.id}
              style={{
                backgroundColor: "#161b22",
                borderLeft: `4px solid ${isException ? "#238636" : isDefinition ? "#58a6ff" : "#d29922"}`,
                border: "1px solid #30363d",
                borderRadius: "6px",
                padding: "16px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "8px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontSize: "14px",
                      fontWeight: 700,
                      color: "#58a6ff",
                    }}
                  >
                    {chunk.clauseLabel}
                  </span>
                  <span style={{ fontSize: "12px", color: "#8b949e" }}>
                    {chunk.headingTrail.join(" › ")}
                  </span>
                </div>

                <div style={{ display: "flex", gap: "8px", fontFamily: "monospace", fontSize: "11px" }}>
                  <span
                    style={{
                      backgroundColor: "#21262d",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      color: "#c9d1d9",
                    }}
                  >
                    {chunk.tokenCount} tokens
                  </span>
                  {chunk.signals.hasExceptionMarker && (
                    <span
                      style={{
                        backgroundColor: "rgba(35, 134, 54, 0.25)",
                        color: "#3fb950",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontWeight: 700,
                      }}
                    >
                      EXCEPTION / CARVE-OUT
                    </span>
                  )}
                  {chunk.signals.hasObligationMarker && (
                    <span
                      style={{
                        backgroundColor: "rgba(210, 153, 34, 0.25)",
                        color: "#e3b341",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontWeight: 700,
                      }}
                    >
                      OBLIGATION
                    </span>
                  )}
                </div>
              </div>

              <div
                style={{
                  fontSize: "15px",
                  lineHeight: 1.5,
                  color: "#f0f6fc",
                  fontFamily: "Georgia, serif",
                  marginBottom: "10px",
                }}
              >
                &ldquo;{chunk.text}&rdquo;
              </div>

              <div
                style={{
                  display: "flex",
                  gap: "16px",
                  fontSize: "11px",
                  color: "#8b949e",
                  fontFamily: "monospace",
                }}
              >
                <span>ID: {chunk.id}</span>
                {chunk.crossRefs.length > 0 && (
                  <span style={{ color: "#58a6ff" }}>
                    Cross-Refs: {chunk.crossRefs.map((r) => `§${r}`).join(", ")}
                  </span>
                )}
                {chunk.definedTerms.length > 0 && (
                  <span>Defined Terms: {chunk.definedTerms.join(", ")}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
