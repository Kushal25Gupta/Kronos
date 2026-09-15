/**
 * Assertion Parser and Multi-Query Expander for KRONOS (PRD.md §7.2, SPEC.md §7.1–7.2)
 *
 * Parses an assertion into {subject, obligation, instrument, qualifiers} and expands it
 * into 4 hypothetical clause forms (obligation, exception, definition, remedy) so that
 * nearest-neighbour search retrieves both the obligation invoked and the carve-out that rebuts it.
 */

import { CONFIG, ExpandedQuery, ParsedAssertion } from "@kronos/core";

const OBLIGATION_LEXICON = [
  "violates",
  "violate",
  "violation",
  "exceeds",
  "exceed",
  "minimum",
  "minimums",
  "threshold",
  "thresholds",
  "cap",
  "breach",
  "breaches",
  "default",
  "prohibited",
  "restricted",
  "mandatory",
  "required",
  "must",
  "shall",
  "covenant",
  "indemnify",
  "liability",
  "consent",
  "notice",
];

const INSTRUMENT_LEXICON = [
  "term sheet",
  "agreement",
  "merger agreement",
  "spa",
  "purchase agreement",
  "side letter",
  "schedule",
  "exhibit",
  "charter",
  "bylaws",
];

const QUALIFIER_PATTERNS = /\b(q1|q2|q3|q4|first quarter|second quarter|third quarter|fourth quarter|annual|quarterly|monthly|prior|closing|post-closing|\d+%|\$\d+(?:,\d{3})*(?:\s*million|\s*m)?)\b/gi;

export class AssertionParser {
  private definedTerms: Set<string>;

  constructor(definedTerms: readonly string[] = []) {
    this.definedTerms = new Set(definedTerms.map((t) => t.toLowerCase()));
  }

  setDefinedTerms(terms: readonly string[]): void {
    this.definedTerms = new Set(terms.map((t) => t.toLowerCase()));
  }

  parse(rawText: string): ParsedAssertion {
    const cleaned = rawText.trim();
    const lower = cleaned.toLowerCase();

    const matchedSubjects: string[] = [];
    const matchedObligations: string[] = [];
    const matchedInstruments: string[] = [];
    const matchedQualifiers: string[] = [];

    // 1. Match against corpus defined terms first (highest signal)
    for (const term of this.definedTerms) {
      if (lower.includes(term)) {
        matchedSubjects.push(term);
      }
    }

    // 2. Match against obligation lexicon
    for (const ob of OBLIGATION_LEXICON) {
      if (lower.includes(ob)) {
        matchedObligations.push(ob);
      }
    }

    // 3. Match against instrument lexicon
    for (const inst of INSTRUMENT_LEXICON) {
      if (lower.includes(inst)) {
        matchedInstruments.push(inst);
      }
    }

    // 4. Match qualifiers (Q3, $50M, percentages, temporal markers)
    const quals = cleaned.match(QUALIFIER_PATTERNS) ?? [];
    for (const q of quals) {
      matchedQualifiers.push(q);
    }

    // Fallback subject extraction if no defined term was explicitly matched
    if (matchedSubjects.length === 0) {
      const stopWords = new Set([
        "your", "the", "our", "their", "this", "that", "in", "on", "of", "to", "for", "and", "or",
        "is", "are", "was", "were", "under", "with", "by", "from", "as", "at", "be", "have", "has",
        ...OBLIGATION_LEXICON,
      ]);
      const words = lower
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stopWords.has(w));
      matchedSubjects.push(...words.slice(0, 4));
    }

    return {
      raw: cleaned,
      subject: Array.from(new Set(matchedSubjects)),
      obligation: Array.from(new Set(matchedObligations)),
      instrument: Array.from(new Set(matchedInstruments)),
      qualifiers: Array.from(new Set(matchedQualifiers)),
    };
  }
}

export class QueryExpander {
  expand(assertion: ParsedAssertion): ExpandedQuery[] {
    const subjStr = assertion.subject.length > 0 ? assertion.subject.join(" ") : assertion.raw;
    const obStr =
      assertion.obligation.length > 0 ? assertion.obligation.join(" ") : "minimum thresholds and covenants";
    const qualStr = assertion.qualifiers.length > 0 ? `${assertion.qualifiers.join(" ")} ` : "";

    return [
      {
        kind: "obligation",
        text: `${assertion.raw} ${subjStr} shall must covenant obligation threshold`,
        weight: CONFIG.retrieval.WEIGHTS.obligation,
      },
      {
        kind: "exception",
        text: `${assertion.raw} ${subjStr} notwithstanding exempt carve-out provided that excluded unless`,
        weight: CONFIG.retrieval.WEIGHTS.exception,
      },
      {
        kind: "definition",
        text: `${assertion.raw} ${subjStr} means shall mean definition`,
        weight: CONFIG.retrieval.WEIGHTS.definition,
      },
      {
        kind: "remedy",
        text: `${assertion.raw} ${subjStr} sole remedy cure period breakup fee`,
        weight: CONFIG.retrieval.WEIGHTS.remedy,
      },
    ];
  }
}
