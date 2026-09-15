/**
 * Reciprocal Rank Fusion (RRF), Cross-Reference Expansion, and Stance Labelling (LLD.md §10.2–10.4)
 */

import {
  Chunk,
  CONFIG,
  ExpansionKind,
  ParsedAssertion,
  RankedResult,
  SearchHit,
  Stance,
} from "@kronos/core";

export interface FusedCandidate {
  readonly chunk: Chunk;
  readonly fusedScore: number;
  readonly bestCosine: number;
  readonly perExpansion: Record<ExpansionKind, number | null>;
  readonly bestExpansion: ExpansionKind;
  readonly isXrefFrom?: string;
}

export class RankFusion {
  private readonly k = CONFIG.retrieval.RRF_K;
  private readonly xrefDiscount = CONFIG.retrieval.XREF_DISCOUNT;

  fuse(
    hitSets: ReadonlyMap<ExpansionKind, readonly SearchHit[]>,
    weights: Readonly<Record<ExpansionKind, number>>,
    chunkLookup: (id: string) => Chunk | undefined
  ): { candidates: FusedCandidate[]; rank1Margin: number } {
    const scoreMap = new Map<
      string,
      {
        fusedScore: number;
        bestCosine: number;
        perExpansion: Record<ExpansionKind, number | null>;
        bestExpansion: ExpansionKind;
        bestExpScore: number;
      }
    >();

    for (const [kind, hits] of hitSets.entries()) {
      const weight = weights[kind];
      for (const hit of hits) {
        const rrfIncrement = weight / (this.k + hit.rank);
        const existing = scoreMap.get(hit.chunkId);
        if (!existing) {
          scoreMap.set(hit.chunkId, {
            fusedScore: rrfIncrement,
            bestCosine: hit.score,
            perExpansion: {
              obligation: kind === "obligation" ? hit.score : null,
              exception: kind === "exception" ? hit.score : null,
              definition: kind === "definition" ? hit.score : null,
              remedy: kind === "remedy" ? hit.score : null,
            },
            bestExpansion: kind,
            bestExpScore: rrfIncrement,
          });
        } else {
          existing.fusedScore += rrfIncrement;
          if (hit.score > existing.bestCosine) {
            existing.bestCosine = hit.score;
          }
          existing.perExpansion[kind] = hit.score;
          if (rrfIncrement > existing.bestExpScore) {
            existing.bestExpScore = rrfIncrement;
            existing.bestExpansion = kind;
          }
        }
      }
    }

    const candidates: FusedCandidate[] = [];
    for (const [chunkId, entry] of scoreMap.entries()) {
      const chunk = chunkLookup(chunkId);
      if (!chunk) continue;
      candidates.push({
        chunk,
        fusedScore: entry.fusedScore,
        bestCosine: entry.bestCosine,
        perExpansion: entry.perExpansion,
        bestExpansion: entry.bestExpansion,
      });
    }

    candidates.sort((a, b) => b.fusedScore - a.fusedScore);

    const rank1Margin =
      candidates.length >= 2
        ? Math.max(0, candidates[0].bestCosine - candidates[1].bestCosine)
        : candidates.length === 1
          ? candidates[0].bestCosine
          : 0;

    return { candidates, rank1Margin };
  }

  expandCrossRefs(
    candidates: readonly FusedCandidate[],
    allChunks: readonly Chunk[]
  ): FusedCandidate[] {
    const out = [...candidates];
    const presentIds = new Set(candidates.map((c) => c.chunk.id));
    const byLabel = new Map<string, Chunk>();
    for (const c of allChunks) {
      byLabel.set(c.clauseLabel.toLowerCase(), c);
      // Also index normalized label e.g. "4.2" from "§4.2"
      const bare = c.clauseLabel.replace(/^§\s*/, "").toLowerCase();
      byLabel.set(bare, c);
    }

    const topPool = candidates.slice(0, 2);
    for (const item of topPool) {
      const itemBareLabel = item.chunk.clauseLabel.replace(/^§\s*/, "").toLowerCase();

      // 1. Forward cross-reference resolution: pull clauses cited BY this chunk
      for (const ref of item.chunk.crossRefs) {
        const cleanRef = ref.replace(/^§\s*/, "").toLowerCase();
        const cited = byLabel.get(cleanRef) ?? byLabel.get(`§${cleanRef}`);
        if (cited && !presentIds.has(cited.id)) {
          presentIds.add(cited.id);
          out.push({
            chunk: cited,
            fusedScore: item.fusedScore * this.xrefDiscount,
            bestCosine: item.bestCosine * this.xrefDiscount,
            perExpansion: { ...item.perExpansion },
            bestExpansion: item.bestExpansion,
            isXrefFrom: item.chunk.clauseLabel,
          });
        }
      }

      // 2. Reverse cross-reference resolution (PRD.md §7.2): pull carve-outs/exceptions that cite THIS obligation clause
      for (const other of allChunks) {
        if (presentIds.has(other.id)) continue;
        const citesThis =
          other.crossRefs.some((r) => {
            const cleanR = r.replace(/^§\s*/, "").toLowerCase();
            return cleanR === itemBareLabel || cleanR.startsWith(`${itemBareLabel}(`);
          }) ||
          other.clauseLabel.toLowerCase().startsWith(`${item.chunk.clauseLabel.toLowerCase()}.`) ||
          other.clauseLabel.toLowerCase().startsWith(`${item.chunk.clauseLabel.toLowerCase()}(`);

        if (citesThis && other.signals.hasExceptionMarker) {
          presentIds.add(other.id);
          out.push({
            chunk: other,
            // Carve-outs that directly modify the top retrieved obligation are promoted alongside it
            fusedScore: item.fusedScore * 1.03,
            bestCosine: item.bestCosine,
            perExpansion: { ...item.perExpansion },
            bestExpansion: "exception",
            isXrefFrom: item.chunk.clauseLabel,
          });
        }
      }
    }

    out.sort((a, b) => b.fusedScore - a.fusedScore);
    return out;
  }
}

export class StanceLabeller {
  label(
    candidate: FusedCandidate,
    assertion: ParsedAssertion,
    rank1Margin: number
  ): RankedResult {
    const { chunk, bestExpansion, isXrefFrom } = candidate;
    const { signals } = chunk;

    let supportsScore = 0;
    let againstScore = 0;
    const reasons: string[] = [];

    // 1. Structural signals (precomputed at ingest)
    if (signals.hasExceptionMarker) {
      supportsScore += 2.0;
      const marker = signals.matchedMarkers[0] ?? "exception language";
      reasons.push(`exception marker: '${marker}'`);
    }

    if (signals.hasObligationMarker) {
      againstScore += 1.5;
      reasons.push("contains obligation language ('shall / must / not exceed')");
    }

    if (signals.hasDefinitionMarker && !signals.hasExceptionMarker) {
      return {
        chunk,
        fusedScore: candidate.fusedScore,
        perExpansion: candidate.perExpansion,
        rank1Margin,
        stance: "context",
        stanceConfidence: 0.88,
        stanceReasons: ["definitional clause"],
        matchedTerms: this.findMatchedTerms(chunk.text, assertion),
      };
    }

    // 2. Retrieval provenance
    if (bestExpansion === "exception") {
      supportsScore += 1.5;
      reasons.push("matched hypothetical exception/carve-out expansion");
    } else if (bestExpansion === "obligation") {
      againstScore += 1.0;
      reasons.push("matched hypothetical obligation expansion");
    }

    // 3. Cross-reference direction
    if (isXrefFrom && signals.hasExceptionMarker) {
      supportsScore += 1.0;
      reasons.push(`modifies/carves out ${isXrefFrom}`);
    } else if (chunk.crossRefs.length > 0 && signals.hasExceptionMarker) {
      supportsScore += 1.0;
      reasons.push(`xref → §${chunk.crossRefs[0]}`);
    }

    // 4. Negation / exemption scope near asserted subject
    const lowerText = chunk.text.toLowerCase();
    const hasExemptNearSubject =
      (lowerText.includes("exempt") ||
        lowerText.includes("notwithstanding") ||
        lowerText.includes("shall not apply") ||
        lowerText.includes("carve-out") ||
        lowerText.includes("provided that")) &&
      assertion.subject.some((s) => lowerText.includes(s.toLowerCase()));

    if (hasExemptNearSubject) {
      supportsScore += 1.2;
      reasons.push("subject appears within exempting/carve-out scope");
    }

    const total = supportsScore + againstScore + 1e-6;
    const conf = Math.abs(supportsScore - againstScore) / total;

    let stance: Stance = "context";
    if (conf >= CONFIG.confidence.STANCE_MIN_CONFIDENCE) {
      stance = supportsScore >= againstScore ? "supports" : "against";
    }

    if (reasons.length === 0) {
      reasons.push("topical relevance");
    }

    return {
      chunk,
      fusedScore: candidate.fusedScore,
      perExpansion: candidate.perExpansion,
      rank1Margin,
      stance,
      stanceConfidence: Number(Math.min(0.99, Math.max(0.5, conf)).toFixed(2)),
      stanceReasons: reasons,
      matchedTerms: this.findMatchedTerms(chunk.text, assertion),
    };
  }

  private findMatchedTerms(text: string, assertion: ParsedAssertion): string[] {
    const lower = text.toLowerCase();
    const terms = [
      ...assertion.subject,
      ...assertion.qualifiers,
      "notwithstanding",
      "exempt",
      "provided that",
      "shall not exceed",
    ];
    return Array.from(new Set(terms.filter((t) => t.length > 1 && lower.includes(t.toLowerCase()))));
  }
}
