/**
 * Core domain types for KRONOS (LLD.md §2, SPEC.md §4)
 * Shared across Node ingest, isomorphic retrieval, audio worker, and Next.js HUD.
 */

export type ExpansionKind = "obligation" | "exception" | "definition" | "remedy";
export type Stance        = "supports" | "against" | "context";
export type GateState     = "green" | "amber" | "red";
export type SessionState  =
  | "idle" | "loading" | "ready" | "armed"
  | "listening" | "transcribing" | "retrieving" | "showing" | "error";

export interface StructuralSignals {
  readonly hasExceptionMarker: boolean;
  readonly hasObligationMarker: boolean;
  readonly hasDefinitionMarker: boolean;
  readonly hasRemedyMarker: boolean;
  readonly matchedMarkers: readonly string[];
}

export interface Chunk {
  readonly id: string;              // `${docId}::${clausePath.join(".")}`
  readonly docId: string;
  readonly docTitle: string;
  readonly clausePath: readonly string[];
  readonly clauseLabel: string;     // "§4.2.1(b)"
  readonly headingTrail: readonly string[];
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly text: string;            // verbatim, complete logical unit — never truncated for display
  readonly charCount: number;
  readonly tokenCount: number;
  readonly crossRefs: readonly string[];
  readonly definedTerms: readonly string[];
  readonly signals: StructuralSignals;
  readonly vectorOffset: number;    // index into the packed vector block
}

export interface ParsedAssertion {
  readonly raw: string;
  readonly subject: readonly string[];
  readonly obligation: readonly string[];
  readonly instrument: readonly string[];
  readonly qualifiers: readonly string[];
}

export interface ExpandedQuery {
  readonly kind: ExpansionKind;
  readonly text: string;
  readonly weight: number;
}

export interface SearchHit {
  readonly chunkId: string;
  readonly score: number;
  readonly rank: number;
}

export interface RankedResult {
  readonly chunk: Chunk;
  readonly fusedScore: number;
  /**
   * Best raw cosine similarity this chunk achieved against any expansion.
   *
   * Kept distinct from `fusedScore` because the two answer different questions.
   * RRF is purely ordinal — it measures how consistently a chunk ranked highly
   * across expansions, and its absolute magnitude is a function of rank
   * position and nothing else. Cosine measures how semantically close the clause
   * actually is. A confidence gate needs the latter: a chunk can be the
   * unanimous top pick of all four expansions (high RRF) while still being a
   * poor match in absolute terms (low cosine), which is exactly the situation
   * where the panel should decline rather than assert.
   */
  readonly bestCosine: number;
  readonly perExpansion: Readonly<Record<ExpansionKind, number | null>>;
  readonly rank1Margin: number;
  readonly stance: Stance;
  readonly stanceConfidence: number;
  readonly stanceReasons: readonly string[];
  readonly matchedTerms: readonly string[];
}

export interface QueryTiming {
  readonly queryId: string;
  readonly tSpeechEnd: number;
  readonly tAsrDone: number;
  readonly tQueryBuilt: number;
  readonly tEmbedDone: number;
  readonly tSearchDone: number;
  readonly tRanked: number;
  readonly tPaint: number;
  readonly totalFromSpeechEnd: number;
  readonly vectorSearchMs: number;
  readonly audioMs: number;
  readonly expansionCount: number;
  readonly candidateCount: number;
}

export interface QueryOutcome {
  readonly queryId: string;
  readonly state: GateState;
  readonly results: readonly RankedResult[];
  readonly transcript: string;
  readonly composite: number;
  readonly timing: QueryTiming;
  readonly gateReason?: string;
}

export interface IndexArtifactMeta {
  readonly version: number;
  readonly builtAt: string;
  readonly modelFingerprint: string;
  readonly dimensions: number;
  readonly chunkCount: number;
  readonly docs: readonly {
    readonly id: string;
    readonly title: string;
    readonly pageCount: number;
    readonly sha256: string;
  }[];
  readonly chunks: readonly Chunk[];
}

/**
 * Worker message protocols (LLD.md §8)
 */
export type AsrRequest =
  | { readonly type: "init"; readonly modelUrl: string; readonly threads: number }
  | { readonly type: "warmup" }
  | { readonly type: "setPrompt"; readonly prompt: string }
  | { readonly type: "decodePartial"; readonly queryId: string; readonly audio: Float32Array }
  | { readonly type: "decodeFinal"; readonly queryId: string; readonly audio: Float32Array }
  | { readonly type: "cancel"; readonly queryId: string };

export type AsrResponse =
  | { readonly type: "ready"; readonly loadMs: number }
  | { readonly type: "partial"; readonly queryId: string; readonly text: string }
  | {
      readonly type: "final";
      readonly queryId: string;
      readonly text: string;
      readonly meanLogprob: number;
      readonly noSpeechProb: number;
      readonly decodeMs: number;
    }
  | { readonly type: "error"; readonly queryId?: string; readonly code: string; readonly message: string };

export type VadEvent =
  | { readonly type: "speechStart"; readonly at: number }
  | { readonly type: "speechEnd"; readonly at: number; readonly durationMs: number; readonly snrDb: number }
  | { readonly type: "level"; readonly rms: number };

export interface QueryInput {
  readonly queryId: string;
  readonly transcript: string;
  readonly tSpeechEnd: number;
  readonly tAsrDone: number;
  readonly asrMeanLogprob: number;
  readonly asrNoSpeechProb: number;
  readonly snrDb: number;
  readonly audioMs?: number;
}
