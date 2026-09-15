"use client";

import React from "react";
import { SessionState } from "@kronos/core";

interface MicIndicatorProps {
  sessionState: SessionState;
  rmsLevel: number;
  onToggleArm: () => void;
}

export const MicIndicator: React.FC<MicIndicatorProps> = ({
  sessionState,
  rmsLevel,
  onToggleArm,
}) => {
  const isArmed =
    sessionState === "armed" ||
    sessionState === "listening" ||
    sessionState === "transcribing" ||
    sessionState === "retrieving" ||
    sessionState === "showing";

  const dotColor = isArmed ? "#238636" : "#6e7681";
  const levelWidth = Math.min(100, Math.round(rmsLevel * 850));

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        backgroundColor: "#161b22",
        borderBottom: "1px solid #30363d",
        fontSize: "12px",
        fontWeight: 600,
        letterSpacing: "0.04em",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          style={{
            display: "inline-block",
            width: "9px",
            height: "9px",
            borderRadius: "50%",
            backgroundColor: dotColor,
            boxShadow: isArmed ? "0 0 8px #238636" : "none",
          }}
        />
        <span style={{ color: isArmed ? "#3fb950" : "#8b949e" }}>
          {isArmed ? "LISTENING · ARMED" : "STANDBY · DISARMED"}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        {isArmed && (
          <div
            title="Live microphone input level (ring buffer)"
            style={{
              width: "48px",
              height: "6px",
              backgroundColor: "#21262d",
              borderRadius: "3px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${levelWidth}%`,
                height: "100%",
                backgroundColor: "#3fb950",
                transition: "width 80ms linear",
              }}
            />
          </div>
        )}
        <button
          onClick={onToggleArm}
          style={{
            background: isArmed ? "#21262d" : "#238636",
            color: "#f0f6fc",
            border: "1px solid #30363d",
            borderRadius: "4px",
            padding: "3px 8px",
            fontSize: "11px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          {isArmed ? "Disarm (Esc)" : "Arm (2× Alt)"}
        </button>
      </div>
    </div>
  );
};
