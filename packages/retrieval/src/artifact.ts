/**
 * KRONOSIX Binary Index Artifact serializer and verifier (LLD.md §5)
 *
 * Header layout (128 bytes fixed, little-endian):
 * 0x00  magic            8B   "KRONOSIX"
 * 0x08  formatVersion    4B   uint32 = 1
 * 0x0C  dimensions       4B   uint32 = 384
 * 0x10  chunkCount       4B   uint32
 * 0x14  vectorOffset     4B   uint32  byte offset (128)
 * 0x18  vectorLength     4B   uint32  bytes (chunkCount * 384 * 4)
 * 0x1C  metaOffset       4B   uint32
 * 0x20  metaLength       4B   uint32
 * 0x24  modelFingerprint 32B  sha256 hex prefix / ASCII bytes
 * 0x44  contentHash      32B  sha256 hex prefix / ASCII bytes of vector+meta blocks
 * 0x64  builtAtUnixMs    8B   uint64
 * 0x6C  flags            4B   uint32
 * 0x70  reserved         16B
 */

import {
  Chunk,
  CONFIG,
  EMBEDDING_FINGERPRINT,
  ErrorCode,
  IndexArtifactMeta,
  KronosError,
  ModelMismatchError,
} from "@kronos/core";
import { sha256Hex } from "./utils.js";

export interface LoadedIndexArtifact {
  readonly meta: IndexArtifactMeta;
  readonly vectors: Float32Array; // packed chunkCount * 384
  readonly chunks: readonly Chunk[];
}

const HEADER_SIZE = 128;
const MAGIC = "KRONOSIX";

function writeFixedAscii(view: Uint8Array, offset: number, length: number, text: string): void {
  const encoded = new TextEncoder().encode(text);
  for (let i = 0; i < length; i++) {
    view[offset + i] = i < encoded.length ? encoded[i] : 0;
  }
}

function readFixedAscii(view: Uint8Array, offset: number, length: number): string {
  let end = offset + length;
  for (let i = offset; i < offset + length; i++) {
    if (view[i] === 0) {
      end = i;
      break;
    }
  }
  return new TextDecoder().decode(view.subarray(offset, end));
}

export async function packIndexArtifact(
  meta: IndexArtifactMeta,
  vectors: Float32Array
): Promise<Uint8Array> {
  const vectorBytes = new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength);
  const metaJsonBytes = new TextEncoder().encode(JSON.stringify(meta));

  // Pad vectorLength to 4-byte boundary (Float32Array is always 4-byte aligned)
  const vectorOffset = HEADER_SIZE;
  const vectorLength = vectorBytes.byteLength;
  const metaOffset = vectorOffset + vectorLength;
  const metaLength = metaJsonBytes.byteLength;
  const totalSize = metaOffset + metaLength;

  // Compute contentHash over vector + meta blocks
  const combinedPayload = new Uint8Array(vectorLength + metaLength);
  combinedPayload.set(vectorBytes, 0);
  combinedPayload.set(metaJsonBytes, vectorLength);
  const fullContentHash = await sha256Hex(combinedPayload);
  const contentHash32 = fullContentHash.slice(0, 32);

  const output = new Uint8Array(totalSize);
  const dataView = new DataView(output.buffer);

  // 0x00 magic (8B)
  writeFixedAscii(output, 0x00, 8, MAGIC);
  // 0x08 formatVersion (4B)
  dataView.setUint32(0x08, meta.version, true);
  // 0x0C dimensions (4B)
  dataView.setUint32(0x0c, meta.dimensions, true);
  // 0x10 chunkCount (4B)
  dataView.setUint32(0x10, meta.chunkCount, true);
  // 0x14 vectorOffset (4B)
  dataView.setUint32(0x14, vectorOffset, true);
  // 0x18 vectorLength (4B)
  dataView.setUint32(0x18, vectorLength, true);
  // 0x1C metaOffset (4B)
  dataView.setUint32(0x1c, metaOffset, true);
  // 0x20 metaLength (4B)
  dataView.setUint32(0x20, metaLength, true);
  // 0x24 modelFingerprint (32B)
  writeFixedAscii(output, 0x24, 32, meta.modelFingerprint.slice(0, 32));
  // 0x44 contentHash (32B)
  writeFixedAscii(output, 0x44, 32, contentHash32);
  // 0x64 builtAtUnixMs (8B)
  const builtMs = BigInt(Date.parse(meta.builtAt) || Date.now());
  dataView.setBigUint64(0x64, builtMs, true);
  // 0x6C flags (4B)
  dataView.setUint32(0x6c, 0, true);

  // Copy vector block and meta block
  output.set(vectorBytes, vectorOffset);
  output.set(metaJsonBytes, metaOffset);

  return output;
}

export async function unpackAndVerifyIndexArtifact(
  buffer: ArrayBuffer | Uint8Array,
  expectedModelFingerprint = EMBEDDING_FINGERPRINT
): Promise<LoadedIndexArtifact> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < HEADER_SIZE) {
    throw new KronosError(
      ErrorCode.InvalidArtifact,
      `Artifact buffer too small (${bytes.byteLength} bytes < ${HEADER_SIZE} header bytes).`
    );
  }

  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. magic === "KRONOSIX"
  const magic = readFixedAscii(bytes, 0x00, 8);
  if (magic !== MAGIC) {
    throw new KronosError(
      ErrorCode.InvalidArtifact,
      `Invalid artifact magic header: expected "${MAGIC}", got "${magic}".`
    );
  }

  // 2. formatVersion supported
  const formatVersion = dataView.getUint32(0x08, true);
  if (formatVersion !== 1) {
    throw new KronosError(
      ErrorCode.UnsupportedVersion,
      `Unsupported KRONOSIX artifact format version: ${formatVersion}.`
    );
  }

  const dimensions = dataView.getUint32(0x0c, true);
  const chunkCount = dataView.getUint32(0x10, true);
  const vectorOffset = dataView.getUint32(0x14, true);
  const vectorLength = dataView.getUint32(0x18, true);
  const metaOffset = dataView.getUint32(0x1c, true);
  const metaLength = dataView.getUint32(0x20, true);
  const headerFingerprint = readFixedAscii(bytes, 0x24, 32);
  const headerContentHash = readFixedAscii(bytes, 0x44, 32);

  // 3. contentHash matches recomputed hash
  if (metaOffset + metaLength > bytes.byteLength) {
    throw new KronosError(
      ErrorCode.CorruptArtifact,
      `Artifact payload extends past buffer bounds (${metaOffset + metaLength} > ${bytes.byteLength}).`
    );
  }
  const combinedPayload = bytes.subarray(vectorOffset, metaOffset + metaLength);
  const computedHash = (await sha256Hex(combinedPayload)).slice(0, 32);
  if (computedHash !== headerContentHash) {
    throw new KronosError(
      ErrorCode.CorruptArtifact,
      `Artifact contentHash mismatch: expected "${headerContentHash}", computed "${computedHash}".`
    );
  }

  // 4. modelFingerprint matches the loaded embedder
  const expectedFpPrefix = expectedModelFingerprint.slice(0, 32);
  if (headerFingerprint !== expectedFpPrefix) {
    throw new ModelMismatchError(expectedFpPrefix, headerFingerprint);
  }

  // 5. dimensions matches embedder
  if (dimensions !== CONFIG.embedding.DIMENSIONS) {
    throw new KronosError(
      ErrorCode.DimensionMismatch,
      `Index dimensions (${dimensions}) do not match embedder (${CONFIG.embedding.DIMENSIONS}).`
    );
  }

  // 6. vectorLength === chunkCount * dimensions * 4
  const expectedVectorBytes = chunkCount * dimensions * 4;
  if (vectorLength !== expectedVectorBytes) {
    throw new KronosError(
      ErrorCode.CorruptArtifact,
      `Vector block byte length (${vectorLength}) does not match chunkCount * dimensions * 4 (${expectedVectorBytes}).`
    );
  }

  // Extract vectors
  const vectorSlice = bytes.slice(vectorOffset, vectorOffset + vectorLength);
  const vectors = new Float32Array(
    vectorSlice.buffer,
    vectorSlice.byteOffset,
    chunkCount * dimensions
  );

  // Extract meta JSON
  const metaSlice = bytes.subarray(metaOffset, metaOffset + metaLength);
  const metaJsonStr = new TextDecoder().decode(metaSlice);
  const meta = JSON.parse(metaJsonStr) as IndexArtifactMeta;

  return {
    meta,
    vectors,
    chunks: meta.chunks,
  };
}
