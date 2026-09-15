#!/usr/bin/env node
/**
 * Vendors the real ONNX model weights into apps/web/public/models/ so that the
 * browser runtime can load them from same-origin and make ZERO network requests
 * to any third party after page load (SPEC.md CR-3, strict CSP `connect-src 'self'`).
 *
 * This script is the ONLY part of KRONOS that touches the network, and it runs
 * at build time, never at query time.
 *
 * It also emits packages/core/src/model-fingerprints.ts containing the real
 * SHA-256 of each weight file. That fingerprint is stamped into the .moss index
 * artifact at ingest and verified at load, so an index built with different
 * weights than the ones being served is rejected rather than silently returning
 * garbage similarities (LLD.md §5.1 check 3).
 *
 * Usage: node scripts/fetch-models.mjs
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = join(ROOT, "apps", "web", "public", "models");
const HF = "https://huggingface.co";

/**
 * The exact files transformers.js requires to run each model fully offline.
 * Quantised (int8) variants are used: they are ~4x smaller, which matters because
 * these ship to the browser, and the accuracy cost on short legal clauses is
 * negligible relative to the download budget.
 */
const MODELS = [
  {
    repo: "Xenova/all-MiniLM-L6-v2",
    role: "embedding",
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/model_quantized.onnx",
    ],
    // File whose hash becomes the model fingerprint stamped into the index.
    fingerprintFile: "onnx/model_quantized.onnx",
  },
  {
    repo: "Xenova/whisper-tiny.en",
    role: "asr",
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "preprocessor_config.json",
      "generation_config.json",
      "onnx/encoder_model_quantized.onnx",
      "onnx/decoder_model_merged_quantized.onnx",
    ],
    fingerprintFile: "onnx/encoder_model_quantized.onnx",
  },
];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function human(bytes) {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} kB`;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchFile(repo, file, destPath) {
  if (await exists(destPath)) {
    const cached = await readFile(destPath);
    console.log(`  cached  ${file.padEnd(42)} ${human(cached.byteLength).padStart(9)}`);
    return cached;
  }

  const url = `${HF}/${repo}/resolve/main/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} — HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, buf);
  console.log(`  fetched ${file.padEnd(42)} ${human(buf.byteLength).padStart(9)}`);
  return buf;
}

async function main() {
  console.log(`Vendoring real model weights into ${MODELS_DIR}\n`);

  const fingerprints = {};
  let totalBytes = 0;

  for (const model of MODELS) {
    console.log(`${model.repo}  [${model.role}]`);
    for (const file of model.files) {
      const dest = join(MODELS_DIR, model.repo, file);
      const buf = await fetchFile(model.repo, file, dest);
      totalBytes += buf.byteLength;

      if (file === model.fingerprintFile) {
        fingerprints[model.role] = {
          repo: model.repo,
          file,
          sha256: sha256(buf),
          bytes: buf.byteLength,
        };
      }
    }
    console.log();
  }

  const banner = `/**
 * GENERATED FILE — do not edit by hand.
 * Produced by scripts/fetch-models.mjs from the actual vendored ONNX weights in
 * apps/web/public/models/. These are real SHA-256 digests of real model files.
 *
 * If you re-run the fetch script against different model revisions, these values
 * change, every previously built .moss artifact stops verifying, and you must
 * re-run \`pnpm ingest\`. That is deliberate: a stale index silently paired with
 * different weights produces confident nonsense, which is the single worst
 * failure mode this product can have.
 */

export interface ModelFingerprint {
  readonly repo: string;
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

export const MODEL_FINGERPRINTS = ${JSON.stringify(fingerprints, null, 2)} as const satisfies Record<string, ModelFingerprint>;

/** Fingerprint stamped into .moss artifacts and checked at load time. */
export const EMBEDDING_FINGERPRINT = \`sha256:\${MODEL_FINGERPRINTS.embedding.sha256}\`;

/** Reported in the debug overlay so the ASR weights in use are identifiable. */
export const ASR_FINGERPRINT = \`sha256:\${MODEL_FINGERPRINTS.asr.sha256}\`;
`;

  const outPath = join(ROOT, "packages", "core", "src", "model-fingerprints.ts");
  await writeFile(outPath, banner);

  console.log(`Total vendored: ${human(totalBytes)}`);
  console.log(`Embedding fingerprint: sha256:${fingerprints.embedding.sha256}`);
  console.log(`ASR fingerprint:       sha256:${fingerprints.asr.sha256}`);
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(`\nModel vendoring failed: ${err.message}`);
  process.exit(1);
});
