/**
 * Isomorphic SHA-256 and binary helpers for KRONOS artifact verification (LLD.md §5)
 * Works identically in Node.js and Web Workers / Browsers without external dependencies.
 */

export async function sha256Hex(buffer: Uint8Array | ArrayBuffer | string): Promise<string> {
  const bytes =
    typeof buffer === "string"
      ? new TextEncoder().encode(buffer)
      : buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : buffer;

  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export function l2Normalize(vec: Float32Array): Float32Array {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i] / norm;
  }
  return out;
}
