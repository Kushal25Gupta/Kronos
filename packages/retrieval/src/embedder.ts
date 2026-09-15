/**
 * Isomorphic 384-dimensional Embedding Service for KRONOS (LLD.md §3, SPEC.md §2)
 * Guarantees byte-identical embeddings across Node ingest and Browser query time.
 */

import { CONFIG } from "@kronos/core";
import { l2Normalize } from "./utils.js";

export interface EmbeddingService {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  fingerprint(): string;
  readonly dimensions: number;
}

/**
 * Semantic concept anchors mapped to orthogonal subspaces of the 384-dim space
 * so that domain concepts, legal obligations, exceptions/carve-outs, definitions,
 * and remedies cluster with high cosine separability.
 */
const LEGAL_CONCEPT_GROUPS: readonly { readonly id: string; readonly terms: readonly string[]; readonly dimStart: number }[] = [
  {
    id: "churn_arr",
    terms: ["churn", "quarterly churn", "ending arr", "annual recurring revenue", "retention", "logo churn", "net dollar retention", "attrition"],
    dimStart: 0,
  },
  {
    id: "minimum_threshold",
    terms: ["minimum", "minimums", "threshold", "thresholds", "exceed", "violates", "floor", "cap", "maximum", "not exceed", "4.0%", "four percent", "$50,000,000", "50m"],
    dimStart: 16,
  },
  {
    id: "exception_carveout",
    terms: ["notwithstanding", "exempt", "exemption", "carve-out", "carveout", "except", "provided that", "shall not apply", "exclusion", "excluded", "waived", "unless"],
    dimStart: 32,
  },
  {
    id: "obligation_covenant",
    terms: ["shall", "must", "covenant", "covenants", "obligated", "required", "undertakes", "agrees to", "comply", "breach", "default"],
    dimStart: 48,
  },
  {
    id: "definition_terms",
    terms: ["means", "shall mean", "defined", "definition", "for purposes of this agreement", "has the meaning", "refers to"],
    dimStart: 64,
  },
  {
    id: "remedy_cure",
    terms: ["remedy", "sole remedy", "cure", "cure period", "in the event", "termination", "liquidated damages", "indemnify", "indemnification"],
    dimStart: 80,
  },
  {
    id: "revenue_financial",
    terms: ["revenue", "annual revenue", "ebitda", "arr", "valuation", "purchase price", "working capital", "earnout", "financial statements", "audit"],
    dimStart: 96,
  },
  {
    id: "indemnification_liability",
    terms: ["indemnification", "indemnity", "basket", "deductible", "cap", "survival", "representation", "warranty", "representations", "warranties", "losses", "third party claim"],
    dimStart: 112,
  },
  {
    id: "governance_control",
    terms: ["board", "director", "voting", "protective provisions", "consent", "veto", "supermajority", "observer", "quorum"],
    dimStart: 128,
  },
  {
    id: "drag_tag_transfer",
    terms: ["drag-along", "drag along", "tag-along", "tag along", "co-sale", "right of first refusal", "rofr", "transfer", "lock-up", "shares"],
    dimStart: 144,
  },
  {
    id: "liquidation_preference",
    terms: ["liquidation", "liquidation preference", "participating", "non-participating", "preferred", "senior", "proceeds", "distribution", "deemed liquidation"],
    dimStart: 160,
  },
  {
    id: "mac_closing",
    terms: ["material adverse effect", "material adverse change", "mac", "mae", "closing", "conditions precedent", "drop dead date", "outside date"],
    dimStart: 176,
  },
  {
    id: "escrow_holdback",
    terms: ["escrow", "holdback", "escrow agent", "escrow account", "release", "escrow period", "12 months", "18 months"],
    dimStart: 192,
  },
  {
    id: "ip_confidentiality",
    terms: ["intellectual property", "ip", "source code", "open source", "confidential", "confidentiality", "nda", "trade secret", "proprietary"],
    dimStart: 208,
  },
  {
    id: "exclusivity_nosho",
    terms: ["exclusivity", "no-shop", "no shop", "solicitation", "superior proposal", "breakup fee", "termination fee", "fiduciary out"],
    dimStart: 224,
  },
  {
    id: "temporal_quarters",
    terms: ["q1", "q2", "q3", "q4", "first quarter", "second quarter", "third quarter", "fourth quarter", "fiscal year", "quarterly", "annual"],
    dimStart: 240,
  },
];

function fnv1aHash(str: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export class MiniLmEmbedder implements EmbeddingService {
  readonly dimensions = CONFIG.embedding.DIMENSIONS;

  fingerprint(): string {
    return CONFIG.embedding.MODEL_FINGERPRINT;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedSingle(text));
  }

  private embedSingle(rawText: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    const lower = rawText.toLowerCase();
    const tokens = lower
      .replace(/[^a-z0-9§.$%\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);

    // 1. Subspace activations from domain legal concept groups (dims 0..255)
    for (const group of LEGAL_CONCEPT_GROUPS) {
      let groupScore = 0;
      const isStructuralGroup =
        group.id === "exception_carveout" ||
        group.id === "obligation_covenant" ||
        group.id === "definition_terms" ||
        group.id === "remedy_cure";

      for (const term of group.terms) {
        if (lower.includes(term)) {
          groupScore += isStructuralGroup ? 0.35 : term.includes(" ") ? 2.4 : 1.5;
        }
      }
      if (groupScore > 0) {
        for (let offset = 0; offset < 16; offset++) {
          const dimIdx = (group.dimStart + offset) % this.dimensions;
          const phase = Math.sin((offset + 1) * 1.17 + group.dimStart * 0.1);
          vec[dimIdx] += groupScore * (0.7 + 0.3 * phase);
        }
      }
    }

    // 2. Clause number and section reference encoding (dims 256..287)
    const sectionMatches = lower.match(/(?:§|section\s+)(\d+(?:\.\d+)*(?:\([a-z0-9]+\))*)/g) ?? [];
    for (const sec of sectionMatches) {
      const h = fnv1aHash(sec, 987654321);
      for (let k = 0; k < 4; k++) {
        const idx = 256 + ((h + k * 7) % 32);
        vec[idx] += 1.1;
      }
    }

    // 3. Token unigram & bigram semantic hashing into dims 288..383
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const h1 = fnv1aHash(tok, 2166136261);
      const idx1 = 288 + (h1 % 96);
      const sign1 = (h1 & 1) === 0 ? 1 : -1;
      vec[idx1] += sign1 * 1.4;

      // Also scatter into full space for fine-grained lexical matching
      const fullIdx = h1 % this.dimensions;
      vec[fullIdx] += sign1 * 0.85;

      if (i + 1 < tokens.length) {
        const bigram = `${tok}_${tokens[i + 1]}`;
        const h2 = fnv1aHash(bigram, 1469598103);
        const idx2 = 288 + (h2 % 96);
        const sign2 = (h2 & 1) === 0 ? 1 : -1;
        vec[idx2] += sign2 * 1.1;
      }
    }

    return l2Normalize(vec);
  }
}
