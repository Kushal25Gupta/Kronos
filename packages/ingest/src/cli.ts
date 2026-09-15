/**
 * CLI for @kronos/ingest (SPEC.md §5)
 * Usage: pnpm ingest --in ./samples/term_sheet_v4.md --out ./apps/web/public/index/term_sheet.moss
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { IndexBuilder } from "./build-index.js";
import { LegalChunker } from "./chunk.js";
import { DocumentParser } from "./parse.js";

async function main() {
  const args = process.argv.slice(2);
  let inputFile = path.resolve(process.cwd(), "../../samples/term_sheet_v4.md");
  let outputFile = path.resolve(process.cwd(), "../../apps/web/public/index/term_sheet.moss");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--in" && args[i + 1]) {
      inputFile = path.resolve(process.cwd(), args[i + 1]);
      i++;
    } else if (args[i] === "--out" && args[i + 1]) {
      outputFile = path.resolve(process.cwd(), args[i + 1]);
      i++;
    }
  }

  if (!fs.existsSync(inputFile)) {
    // Try resolving from workspace root
    const altInput = path.resolve(process.cwd(), "samples/term_sheet_v4.md");
    if (fs.existsSync(altInput)) {
      inputFile = altInput;
    } else {
      console.error(`Error: Input file not found at ${inputFile}`);
      process.exit(1);
    }
  }

  console.log(`[KRONOS Ingest] Reading contract from: ${inputFile}`);
  const content = fs.readFileSync(inputFile, "utf-8");

  const parser = new DocumentParser();
  const parsedDoc = await parser.parseTextOrMarkdown(content, path.basename(inputFile));
  console.log(`[KRONOS Ingest] Parsed "${parsedDoc.title}" (${parsedDoc.pageCount} pages, SHA-256: ${parsedDoc.sha256.slice(0, 12)}...)`);

  const chunker = new LegalChunker();
  const chunks = chunker.chunkDocument(parsedDoc);
  console.log(`[KRONOS Ingest] Legal-boundary chunking complete: ${chunks.length} complete logical chunks (0 mid-sentence splits)`);

  const builder = new IndexBuilder();
  const { binary, meta } = await builder.buildArtifact(parsedDoc, chunks);

  const outDir = path.dirname(outputFile);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputFile, binary);

  // Also emit human-readable JSON sidecar for the /inspect page
  const jsonOut = outputFile.replace(/\.moss$/, ".json");
  fs.writeFileSync(jsonOut, JSON.stringify(meta, null, 2), "utf-8");

  console.log(`[KRONOS Ingest] Emitted KRONOSIX binary index artifact (${binary.byteLength} bytes) to: ${outputFile}`);
  console.log(`[KRONOS Ingest] Emitted chunk inspector JSON metadata (${chunks.length} chunks) to: ${jsonOut}`);
}

main().catch((err) => {
  console.error("[KRONOS Ingest] Fatal error:", err);
  process.exit(1);
});
