/**
 * Legal Structure Detection and Legal-Boundary Chunker (SPEC.md §5.2–5.3, LLD.md §10.1)
 *
 * Enforces the hard invariant: never split mid-sentence, never split on a fixed token count.
 * A retrieved chunk is always a complete, readable logical legal unit.
 */

import { Chunk, CONFIG, MidSentenceSplitError, StructuralSignals } from "@kronos/core";
import { ParsedDocument, TextBlock } from "./parse.js";

export interface RawLegalUnit {
  readonly clausePath: readonly string[];
  readonly clauseLabel: string;
  readonly headingTrail: readonly string[];
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly text: string;
  readonly isDefinition: boolean;
}

const EXCEPTION_MARKERS = [
  "notwithstanding",
  "except as",
  "except that",
  "except for",
  "provided that",
  "provided, however, that",
  "shall not apply",
  "exempt",
  "exemption",
  "carve-out",
  "carveout",
  "unless",
];

const OBLIGATION_MARKERS = [
  "shall not exceed",
  "shall",
  "must",
  "no less than",
  "at a minimum",
  "covenants and agrees",
  "obligated to",
  "required to",
];

const DEFINITION_MARKERS = [" means ", " shall mean ", " has the meaning "];
const REMEDY_MARKERS = ["sole remedy", "remedy", "cure period", "in the event", "liquidated damages"];

export class LegalChunker {
  private readonly minTokens = CONFIG.chunking.MIN_TOKENS;
  private readonly maxTokens = CONFIG.chunking.MAX_TOKENS;

  chunkDocument(doc: ParsedDocument): Chunk[] {
    const rawUnits = this.extractLegalUnits(doc.blocks);
    const mergedUnits = this.mergeAndSplitUnits(rawUnits);

    const definedTermsInDoc = this.collectDefinedTerms(mergedUnits);
    const chunks: Chunk[] = mergedUnits.map((unit, idx) => {
      const tokenCount = this.countTokens(unit.text);
      const crossRefs = this.extractCrossRefs(unit.text, unit.clauseLabel);
      const definedTerms = this.matchDefinedTerms(unit.text, definedTermsInDoc);
      const signals = this.computeSignals(unit.text);

      return {
        id: `${doc.docId}::${unit.clausePath.join(".")}`,
        docId: doc.docId,
        docTitle: doc.title,
        clausePath: unit.clausePath,
        clauseLabel: unit.clauseLabel,
        headingTrail: unit.headingTrail,
        pageStart: unit.pageStart,
        pageEnd: unit.pageEnd,
        text: unit.text,
        charCount: unit.text.length,
        tokenCount,
        crossRefs,
        definedTerms,
        signals,
        vectorOffset: idx,
      };
    });

    this.assertNoMidSentenceSplit(chunks);
    return chunks;
  }

  private extractLegalUnits(blocks: readonly TextBlock[]): RawLegalUnit[] {
    const units: RawLegalUnit[] = [];
    let currentArticle = "ARTICLE I — GENERAL";
    let currentSectionHeading = "General Provisions";
    let currentSectionNum = "1";

    for (const block of blocks) {
      const text = block.text.trim();

      // Article heading e.g. "ARTICLE IV — COVENANTS"
      const artMatch = text.match(/^ARTICLE\s+([IVXLC]+)(?:\s*[—–-]\s*(.+))?$/i);
      if (artMatch) {
        currentArticle = text;
        continue;
      }

      // Section heading e.g. "SECTION 4.2 Quarterly Churn Minimums"
      const secHeadingMatch = text.match(/^SECTION\s+([\d.]+)\s*(.*)$/i);
      if (secHeadingMatch && text.split(/\s+/).length <= 12 && !text.endsWith(".")) {
        currentSectionNum = secHeadingMatch[1];
        currentSectionHeading = text;
        continue;
      }

      // Defined term block e.g. `"Churn" means...`
      const defMatch = text.match(/^"([A-Z][\w\s-]+)"\s+(?:means|shall mean)/);
      if (defMatch) {
        const termSlug = defMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "_");
        units.push({
          clausePath: ["def", termSlug],
          clauseLabel: `§1.1 ("${defMatch[1]}")`,
          headingTrail: [currentArticle, "Definitions"],
          pageStart: block.page,
          pageEnd: block.page,
          text,
          isDefinition: true,
        });
        continue;
      }

      // Multi-level decimal with optional alpha e.g. "4.2.1(b) Notwithstanding..." or "§4.2.1(b) ..."
      const decSubMatch = text.match(/^(?:§\s*)?(\d+(?:\.\d+)+)\s*\(([a-z0-9]+)\)\s+(.+)$/i);
      if (decSubMatch) {
        const pathParts = [...decSubMatch[1].split("."), decSubMatch[2]];
        units.push({
          clausePath: pathParts,
          clauseLabel: `§${decSubMatch[1]}(${decSubMatch[2]})`,
          headingTrail: [currentArticle, currentSectionHeading],
          pageStart: block.page,
          pageEnd: block.page,
          text,
          isDefinition: false,
        });
        continue;
      }

      // Multi-level decimal e.g. "4.2 Quarterly churn..." or "4.2.1 ..."
      const decMatch = text.match(/^(?:§\s*)?(\d+(?:\.\d+)+)\s+(.+)$/);
      if (decMatch) {
        const pathParts = decMatch[1].split(".");
        currentSectionNum = decMatch[1];
        units.push({
          clausePath: pathParts,
          clauseLabel: `§${decMatch[1]}`,
          headingTrail: [currentArticle, currentSectionHeading],
          pageStart: block.page,
          pageEnd: block.page,
          text,
          isDefinition: false,
        });
        continue;
      }

      // Alpha sub-clause e.g. "(b) Notwithstanding §4.2..."
      const alphaMatch = text.match(/^\(([a-z])\)\s+(.+)$/i);
      if (alphaMatch) {
        const pathParts = [...currentSectionNum.split("."), alphaMatch[1].toLowerCase()];
        units.push({
          clausePath: pathParts,
          clauseLabel: `§${currentSectionNum}(${alphaMatch[1].toLowerCase()})`,
          headingTrail: [currentArticle, currentSectionHeading],
          pageStart: block.page,
          pageEnd: block.page,
          text,
          isDefinition: false,
        });
        continue;
      }

      // Skip top-level document title blocks
      if (/^TERM SHEET/i.test(text) && !text.endsWith(".")) {
        continue;
      }

      // Append to previous unit if it's a continuation paragraph
      if (units.length > 0) {
        const prev = units[units.length - 1];
        units[units.length - 1] = {
          ...prev,
          pageEnd: block.page,
          text: `${prev.text} ${text}`,
        };
      }
    }

    return units;
  }

  private mergeAndSplitUnits(unitsInput: readonly RawLegalUnit[]): RawLegalUnit[] {
    const units = [...unitsInput];
    const out: RawLegalUnit[] = [];

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const tokens = this.countTokens(unit.text);

      // Definitions always remain standalone (SPEC.md §5.3)
      if (unit.isDefinition) {
        out.push(unit);
        continue;
      }

      // If < 12 tokens (e.g. "(c) Reserved.") and not a numbered clause, merge with sibling
      if (tokens < 12 && i + 1 < units.length && !units[i + 1].isDefinition) {
        const next = units[i + 1];
        const combinedTokens = tokens + this.countTokens(next.text);
        if (combinedTokens <= this.maxTokens) {
          units[i + 1] = {
            ...next,
            pageStart: Math.min(unit.pageStart, next.pageStart),
            text: `${unit.text} ${next.text}`,
          };
          continue;
        }
      }

      out.push(unit);
    }

    return out;
  }

  assertNoMidSentenceSplit(chunks: readonly Chunk[]): void {
    for (const chunk of chunks) {
      const trimmed = chunk.text.trim();
      const lastChar = trimmed[trimmed.length - 1];
      if (![".", ";", ":", '"', "'", ")"].includes(lastChar)) {
        throw new MidSentenceSplitError(chunk.clauseLabel, trimmed.slice(-50));
      }
    }
  }

  private countTokens(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  private extractCrossRefs(text: string, ownLabel: string): string[] {
    const refs = new Set<string>();
    const regex = /(?:§+|Section\s+)(\d+(?:\.\d+)*(?:\([a-z0-9]+\))*)/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const refNum = m[1];
      if (`§${refNum}`.toLowerCase() !== ownLabel.toLowerCase()) {
        refs.add(refNum);
      }
    }
    return Array.from(refs);
  }

  private collectDefinedTerms(units: readonly RawLegalUnit[]): string[] {
    const terms = new Set<string>();
    for (const u of units) {
      const matches = u.text.match(/"([A-Z][A-Za-z0-9\s-]{1,35})"/g) ?? [];
      for (const m of matches) {
        terms.add(m.replace(/"/g, ""));
      }
    }
    return Array.from(terms);
  }

  private matchDefinedTerms(text: string, corpusTerms: readonly string[]): string[] {
    const lower = text.toLowerCase();
    return corpusTerms.filter((t) => lower.includes(t.toLowerCase()));
  }

  private computeSignals(text: string): StructuralSignals {
    const lower = text.toLowerCase();
    const matchedMarkers: string[] = [];

    let hasExceptionMarker = false;
    for (const marker of EXCEPTION_MARKERS) {
      if (lower.includes(marker)) {
        hasExceptionMarker = true;
        matchedMarkers.push(marker);
      }
    }

    let hasObligationMarker = false;
    for (const marker of OBLIGATION_MARKERS) {
      if (lower.includes(marker)) {
        hasObligationMarker = true;
      }
    }

    let hasDefinitionMarker = false;
    for (const marker of DEFINITION_MARKERS) {
      if (lower.includes(marker)) {
        hasDefinitionMarker = true;
      }
    }

    let hasRemedyMarker = false;
    for (const marker of REMEDY_MARKERS) {
      if (lower.includes(marker)) {
        hasRemedyMarker = true;
      }
    }

    return {
      hasExceptionMarker,
      hasObligationMarker,
      hasDefinitionMarker,
      hasRemedyMarker,
      matchedMarkers,
    };
  }
}
