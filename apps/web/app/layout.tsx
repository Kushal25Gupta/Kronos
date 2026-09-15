import React from "react";
import "./globals.css";

export const metadata = {
  title: "KRONOS — Local-First Recall Copilot",
  description:
    "Speech → clause, in the browser tab, with zero network egress and sub-10ms Moss vector search.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
