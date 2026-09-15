import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@kronos/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@kronos/retrieval": path.resolve(__dirname, "packages/retrieval/src/index.ts"),
      "@kronos/ingest": path.resolve(__dirname, "packages/ingest/src/index.ts"),
      "@kronos/audio": path.resolve(__dirname, "packages/audio/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // These tests load real ONNX models (MiniLM ~22 MB, Whisper ~39 MB). Model
    // initialisation alone is seconds, so the default 5s timeout is far too low.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Run in a single fork: parallel workers would each load their own copy of
    // the models and contend for CPU, making every test slower and flakier.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
