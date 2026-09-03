/**
 * Pure parsing utilities for external reading history.
 *
 * These read a Kindle `My Clippings.txt` or a Readwise CSV into structured highlights,
 * in the browser, and that is all they do. Nothing here reaches a network or a database.
 *
 * That boundary is deliberate and worth stating where the code is, because the screen
 * above it originally claimed otherwise. Turning a highlight into a *known idea* means
 * matching it to a Pull, which is an embedding or a model call: under law 2 that belongs
 * at import time and metered through `cost_ledger`, and it is a per-reader cost with no
 * amortisation, so it needs a bound before it is built. Storing the highlights instead
 * runs at law 4 — a Kindle highlight is a verbatim excerpt of an in-copyright book — and
 * would have to be the reader's own data under `user_owned`, never surfaced to anyone
 * else and never fed into a canonical summary. Neither decision has been made, so
 * neither is implemented, and the parser stays local until they are.
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
  /**
   * Authors, counted as authors.
   *
   * The screen had a tile headed "Identified Authors" reading `distinctBooks.length`, so
   * two books by one author counted two, and a file with no author column counted every
   * book as an author. Separate field, separate number.
   */
  distinctAuthors: string[];
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
 * Split CSV text into records of fields, honouring quotes.
 *
 * A single scan over the characters, because the two things that make CSV awkward — a
 * newline inside a quoted field, and a `""` escaped quote — are both invisible to
 * anything that splits on lines first. The previous parser did split on lines first, so
 * a highlight containing a line break (which is most of a long one) was torn into
 * several records: the first fragment failed the column count and was dropped, and the
 * rest were imported as separate highlights carrying whichever fields happened to land
 * in them. A reader's imported history came out quietly wrong rather than visibly
 * broken, which is the worse of the two.
 */
function parseCsvRecords(input: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // A bare CR, or the CR of a CRLF: end the record once, not twice.
      if (ch === '\r' && input[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records.filter((r) => r.some((f) => f.trim().length > 0));
}

/**
 * Parse Readwise or generic CSV highlights.
 *
 * Column order is Readwise's export: text, title, author.
 */
export function parseCsvHighlights(csvContent: string): ParsedHighlight[] {
  const records = parseCsvRecords(csvContent);
  if (records.length <= 1) return [];

  const highlights: ParsedHighlight[] = [];

  // From 1: the first record is the header row.
  for (let i = 1; i < records.length; i++) {
    const cols = (records[i] ?? []).map((c) => c.trim());
    if (cols.length < 2) continue;

    const text = cols[0] || '';
    const bookTitle = cols[1] || 'Unknown Book';
    const bookAuthor = cols[2] || undefined;

    if (text.length > 5) {
      highlights.push({ bookTitle, bookAuthor, text });
    }
  }

  return highlights;
}

/**
 * Count what was parsed.
 *
 * Counts only. There used to be an `estimatedHoursSaved` here, `highlights.length * 3`
 * minutes, presented on screen as "Future Time Spared" beside the real counts — a
 * constant wearing the same typeface as a measurement. Nothing in this file knows what a
 * highlight spares anyone, because nothing here has matched one to an idea yet.
 */
export function summarizeIngestion(highlights: ParsedHighlight[]): IngestionSummary {
  const books = Array.from(new Set(highlights.map((h) => h.bookTitle.toLowerCase()))).sort();
  const authors = Array.from(
    new Set(
      highlights
        .map((h) => h.bookAuthor?.trim().toLowerCase())
        .filter((a): a is string => Boolean(a)),
    ),
  ).sort();

  return {
    totalHighlights: highlights.length,
    distinctBooks: books,
    distinctAuthors: authors,
    highlights,
  };
}
