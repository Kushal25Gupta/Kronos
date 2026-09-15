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
  },
});
