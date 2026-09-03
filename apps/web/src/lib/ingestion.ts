/**
 * Pure parsing utilities for external reading history.
 *
 * Microlearning apps treat readers as blank slates. By ingesting Kindle clippings,
 * Readwise exports, and Markdown notes, What a Pull seeds the reader's personal
 * Delta with ideas they already mastered — sparing them hours of redundant reading.
 */

export interface ParsedHighlight {
  bookTitle: string;
  bookAuthor?: string;
  text: string;
  location?: string;
  date?: string;
}

export interface IngestionSummary {
  totalHighlights: number;
  distinctBooks: string[];
  estimatedHoursSaved: number;
  highlights: ParsedHighlight[];
}

/**
 * Parse standard Amazon Kindle `My Clippings.txt` format.
 *
 * Each clipping is delimited by `==========` and contains:
 * Line 1: Title (Author)
 * Line 2: - Your Highlight on page ... | Added on ...
 * Line 3: (blank)
 * Line 4+: Highlight content
 */
export function parseKindleClippings(content: string): ParsedHighlight[] {
  const rawSections = content.split(/={8,12}/);
  const highlights: ParsedHighlight[] = [];

  for (const section of rawSections) {
    const lines = section
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length < 2) continue;

    const header = lines[0] ?? '';
    const meta = lines[1] ?? '';

    // Extract title and author: "Thinking, Fast and Slow (Daniel Kahneman)"
    let bookTitle = header;
    let bookAuthor: string | undefined;
    const authorMatch = header.match(/^(.*?)\s*\(([^()]+)\)$/);
    if (authorMatch && authorMatch[1] && authorMatch[2]) {
      bookTitle = authorMatch[1].trim();
      bookAuthor = authorMatch[2].trim();
    }

    // Skip bookmark entries or note-only markers without content
    if (meta.toLowerCase().includes('bookmark') && lines.length === 2) {
      continue;
    }

    const text = lines.slice(2).join(' ').trim();
    if (text.length === 0) continue;

    highlights.push({
      bookTitle,
      bookAuthor,
      text,
      location: meta,
    });
  }

  return highlights;
}

/**
 * Parse Readwise or generic CSV highlights.
 */
export function parseCsvHighlights(csvContent: string): ParsedHighlight[] {
  const lines = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const highlights: ParsedHighlight[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    // Basic CSV splitting handling simple quotes
    const cols = line
      .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
      .map((c) => c.replace(/^"|"$/g, '').trim());

    if (cols.length >= 2) {
      const text = cols[0] || '';
      const bookTitle = cols[1] || 'Unknown Book';
      const bookAuthor = cols[2] || undefined;

      if (text.length > 5) {
        highlights.push({
          bookTitle,
          bookAuthor,
          text,
        });
      }
    }
  }

  return highlights;
}

/**
 * Summarize parsed highlights into metacognitive value.
 *
 * Each highlight represents ~2 minutes of future redundant reading spared
 * via The Delta across related works.
 */
export function summarizeIngestion(highlights: ParsedHighlight[]): IngestionSummary {
  const books = Array.from(new Set(highlights.map((h) => h.bookTitle.toLowerCase()))).sort();
  // An average highlight saves ~3 minutes of re-reading foundational explanations in future summaries
  const hoursSaved = Math.round(((highlights.length * 3) / 60) * 10) / 10;

  return {
    totalHighlights: highlights.length,
    distinctBooks: books,
    estimatedHoursSaved: hoursSaved,
    highlights,
  };
}
