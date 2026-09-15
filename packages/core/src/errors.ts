/**
 * Error taxonomy and custom typed exceptions for KRONOS (LLD.md §11)
 */

export enum ErrorCode {
  // Ingest — fail loud
  ScannedDocument      = "scanned_document",
  UnsupportedFormat    = "unsupported_format",
  ParseFailure         = "parse_failure",
  MidSentenceSplit     = "mid_sentence_split",
  OversizedAtomicChunk = "oversized_atomic_chunk",

  // Artifact — fail loud
  InvalidArtifact      = "invalid_artifact",
  UnsupportedVersion   = "unsupported_version",
  CorruptArtifact      = "corrupt_artifact",
  ModelMismatch        = "model_mismatch",
  DimensionMismatch    = "dimension_mismatch",

  // Runtime — fail soft
  MicPermissionDenied  = "mic_permission_denied",
  AsrInitFailure       = "asr_init_failure",
  AsrDecodeFailure     = "asr_decode_failure",
  IndexUnavailable     = "index_unavailable",
  QueryCancelled       = "query_cancelled",

  // Control plane
  MatterAccessRevoked  = "matter_access_revoked",
  ArtifactNotReady     = "artifact_not_ready",
  GrantExpired         = "grant_expired",
  GrantAlreadyConsumed = "grant_already_consumed",
  DeviceNotAttested    = "device_not_attested",
  AuditUnavailable     = "audit_unavailable",
}

export class KronosError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "KronosError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class ScannedDocumentError extends KronosError {
  constructor(filename: string, message = `Document "${filename}" appears to be a scanned/image PDF (<100 chars/page on >30% of pages). OCR is out of scope.`) {
    super(ErrorCode.ScannedDocument, message, false);
    this.name = "ScannedDocumentError";
  }
}

export class MidSentenceSplitError extends KronosError {
  constructor(clauseLabel: string, snippet: string) {
    super(ErrorCode.MidSentenceSplit, `Mid-sentence split invariant violated in clause ${clauseLabel}: "${snippet}"`, false);
    this.name = "MidSentenceSplitError";
  }
}

export class ModelMismatchError extends KronosError {
  constructor(expected: string, actual: string) {
    super(ErrorCode.ModelMismatch, `Index model fingerprint mismatch. Expected "${expected}", got "${actual}".`, false);
    this.name = "ModelMismatchError";
  }
}
