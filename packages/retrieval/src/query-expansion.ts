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

/**
 * Expands one spoken assertion into four hypothetical clause forms.
 *
 * This is HyDE (Hypothetical Document Embeddings) specialised for contracts. The
 * insight is that a spoken accusation and the clause that governs it are written
 * in completely different registers. Nobody says "notwithstanding the foregoing";
 * they say "your Q3 churn blows the minimums." Embedding the spoken sentence and
 * searching directly means comparing conversational English against legal prose,
 * and the nearest neighbour is frequently the wrong clause.
 *
 * So instead we write, for each of four legal functions, the clause we would
 * expect to exist if the assertion were true, and search with THAT. The text is
 * deliberately fluent legal prose rather than appended keywords: a sentence
 * transformer places "Notwithstanding the foregoing, X shall be exempt..." very
 * near a real carve-out, whereas a bag of keywords like "notwithstanding exempt
 * carve-out unless" lands in a vague region near nothing in particular.
 *
 * The exception form carries the highest weight (CONFIG.retrieval.WEIGHTS) because
 * it is the one that changes the outcome of the conversation. The obligation the
 * other side is invoking is usually the clause they have already quoted at you;
 * the carve-out is the one you need and cannot find by scrolling.
 */
export class QueryExpander {
  expand(assertion: ParsedAssertion): ExpandedQuery[] {
    const subject =
      assertion.subject.length > 0 ? assertion.subject.join(" ") : assertion.raw;

    // Qualifiers (Q3, 4.0%, $50,000,000) are the hooks that discriminate between
    // otherwise near-identical clauses, so they are carried into every form.
    const qualifiers =
      assertion.qualifiers.length > 0 ? ` ${assertion.qualifiers.join(" ")}` : "";

    const instrument =
      assertion.instrument.length > 0 ? assertion.instrument[0] : "this Agreement";

    return [
      {
        kind: "obligation",
        // The rule being invoked against you.
        text:
          `${assertion.raw} ` +
          `Under ${instrument}, ${subject}${qualifiers} shall not exceed the ` +
          `applicable minimum thresholds, and the Company shall comply with such ` +
          `covenants at all times.`,
        weight: CONFIG.retrieval.WEIGHTS.obligation,
      },
      {
        kind: "exception",
        // The carve-out that rebuts it. Highest weight — this is the money card.
        text:
          `${assertion.raw} ` +
          `Notwithstanding the foregoing, ${subject}${qualifiers} shall be exempt ` +
          `from such thresholds, and this provision shall not apply, provided that ` +
          `the applicable conditions are satisfied.`,
        weight: CONFIG.retrieval.WEIGHTS.exception,
      },
      {
        kind: "definition",
        // How the disputed term is actually defined, which often decides the point.
        text:
          `${assertion.raw} ` +
          `For purposes of ${instrument}, "${subject}" means the amount so ` +
          `calculated and shall have the meaning set forth in this Section.`,
        weight: CONFIG.retrieval.WEIGHTS.definition,
      },
      {
        kind: "remedy",
        // What actually happens if the accusation is true — usually less than claimed.
        text:
          `${assertion.raw} ` +
          `In the event of any breach with respect to ${subject}${qualifiers}, the ` +
          `sole and exclusive remedy shall be as set forth herein, subject to the ` +
          `applicable cure period.`,
        weight: CONFIG.retrieval.WEIGHTS.remedy,
      },
    ];
  }
}

