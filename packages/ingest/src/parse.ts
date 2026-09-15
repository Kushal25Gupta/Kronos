/**
 * Layout-aware Document Parser with Scanned-PDF Rejection (LLD.md §3, SPEC.md §5.1)
 */

import { ScannedDocumentError } from "@kronos/core";
import { sha256Hex } from "@kronos/retrieval";

export interface TextBlock {
  readonly text: string;
  readonly page: number;
  readonly bbox: readonly [number, number, number, number];
  readonly fontSize: number;
  readonly bold: boolean;
}

export interface ParsedDocument {
  readonly docId: string;
  readonly title: string;
  readonly pageCount: number;
  readonly blocks: readonly TextBlock[];
  readonly sha256: string;
}

export class DocumentParser {
  private readonly minCharsPerPage = 100;

  async parseTextOrMarkdown(content: string, filename: string): Promise<ParsedDocument> {
    const cleanFilename = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
    const title = cleanFilename
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    // Split into pages on "--- PAGE BREAK ---" or every ~35 lines if no explicit page break
    const rawPages = content.includes("--- PAGE BREAK ---")
      ? content.split("--- PAGE BREAK ---")
      : this.paginateByLines(content, 40);

    this.detectScanned(rawPages, filename);

    const blocks: TextBlock[] = [];
    rawPages.forEach((pageContent, idx) => {
      const pageNum = idx + 1;
      const lines = pageContent.split(/\r?\n/);
      let currentParagraph: string[] = [];
      let currentFontSize = 11;
      let currentBold = false;

      const flushParagraph = () => {
        if (currentParagraph.length === 0) return;
        const joined = this.dehyphenate(currentParagraph.join(" ").trim());
        if (joined.length > 0) {
          blocks.push({
            text: joined,
            page: pageNum,
            bbox: [0, 0, 612, 792],
            fontSize: currentFontSize,
            bold: currentBold,
          });
        }
        currentParagraph = [];
        currentFontSize = 11;
        currentBold = false;
      };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) {
          flushParagraph();
          continue;
        }
        // Detect headings or numbered clauses as new logical blocks
        const isHeading =
          /^#{1,3}\s+/.test(line) ||
          /^(?:ARTICLE|SECTION)\s+[IVXLC\d.]+/i.test(line) ||
          /^\d+(?:\.\d+)+(?:\([a-z0-9]+\))?\s+/.test(line) ||
          /^\([a-z]\)\s+/.test(line) ||
          /^"[A-Z][\w\s-]+"/.test(line);

        if (isHeading) {
          flushParagraph();
          const cleaned = line.replace(/^#{1,3}\s+/, "");
          currentFontSize = /^ARTICLE/i.test(cleaned) ? 14 : /^SECTION/i.test(cleaned) ? 12.5 : 11;
          currentBold = /^ARTICLE|SECTION/i.test(cleaned);
          currentParagraph.push(cleaned);
        } else {
          currentParagraph.push(line);
        }
      }
      flushParagraph();
    });

    const filteredBlocks = this.stripRepeatingHeaders(blocks, rawPages.length);
    const fullNormalized = filteredBlocks.map((b) => b.text).join("\n");
    const hash = await sha256Hex(fullNormalized);

    return {
      docId: cleanFilename.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      title,
      pageCount: rawPages.length,
      blocks: filteredBlocks,
      sha256: hash,
    };
  }

  /**
   * Scanned/image PDF heuristic (SPEC.md §5.1):
   * If extractable text characters per page < 100 across > 30% of pages => ScannedDocumentError
   */
  detectScanned(pages: readonly string[], filename: string): void {
    if (pages.length === 0) {
      throw new ScannedDocumentError(filename);
    }
    let lowCharPages = 0;
    for (const page of pages) {
      const charCount = page.replace(/\s+/g, "").length;
      if (charCount < this.minCharsPerPage) {
        lowCharPages++;
      }
    }
    const ratio = lowCharPages / pages.length;
    if (ratio > 0.3) {
      throw new ScannedDocumentError(
        filename,
        `Document "${filename}" failed scanned-document check (${lowCharPages}/${pages.length} pages have <100 chars). OCR is out of scope.`
      );
    }
  }

  private paginateByLines(text: string, linesPerPage: number): string[] {
    const lines = text.split(/\r?\n/);
    const pages: string[] = [];
    for (let i = 0; i < lines.length; i += linesPerPage) {
      pages.push(lines.slice(i, i + linesPerPage).join("\n"));
    }
    return pages.length > 0 ? pages : [text];
  }

  private dehyphenate(text: string): string {
    return text.replace(/([a-z])-\s+([a-z])/g, "$1$2").replace(/\s+/g, " ");
  }

  private stripRepeatingHeaders(blocks: readonly TextBlock[], pageCount: number): TextBlock[] {
    if (pageCount < 3) return [...blocks];
    const counts = new Map<string, number>();
    for (const b of blocks) {
      const k = b.text.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const threshold = Math.ceil(pageCount * 0.6);
    return blocks.filter((b) => (counts.get(b.text.toLowerCase()) ?? 0) < threshold);
  }
}
