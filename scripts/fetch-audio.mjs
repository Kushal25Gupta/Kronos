#!/usr/bin/env node
/**
 * Fetches the reference speech recording used by the ASR benchmark and tests.
 *
 * A real recording is required rather than synthetic noise: Whisper decode time
 * scales with the number of tokens emitted, and silence decodes to nothing
 * almost instantly. Benchmarking against synthetic audio would understate real
 * decode cost by roughly an order of magnitude.
 *
 * Usage: node scripts/fetch-audio.mjs
 */

import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  {
    // ~11s of clear natural English speech. Widely used as a transformers.js
    // reference sample, so results here are comparable with other projects.
    url: "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
    dest: join(ROOT, "samples", "audio", "jfk.wav"),
  },
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

for (const file of FILES) {
  if (await exists(file.dest)) {
    console.log(`cached  ${file.dest}`);
    continue;
  }

  const res = await fetch(file.url);
  if (!res.ok) {
    console.error(`Failed to fetch ${file.url} — HTTP ${res.status}`);
    process.exit(1);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(file.dest), { recursive: true });
  await writeFile(file.dest, buf);
  console.log(`fetched ${file.dest} (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)`);
}
