/**
 * Pure parsing utilities for external reading history, and the shaping that turns what
 * they parse into what `commit_import` accepts.
 *
 * Still pure: these read a Kindle `My Clippings.txt` or a Readwise CSV into structured
 * highlights, and shape those into import items. Nothing here reaches a network or a
 * database — `lib/import-api.ts` does that, and it is the only thing that does.
 *
 * ONE OF THE TWO DECISIONS HAS NOW BEEN MADE, and this header used to say neither had.
 *
 * **Storing them: decided, and built.** `20260905110000_your_highlights_are_yours_to_keep`
 * is the answer to law 4. A highlight is stored verbatim, which is defensible only
 * because it is the reader's own copy of something they own: the work is
 * `rights_status = 'user_owned'`, the summary is `visibility = 'private'`, `get_feed`
 * pools on published AND public so an imported pull can never enter anybody's feed, and
 * `og/index.ts` unfurls with the anon key so it can never be unfurled. It is never fed to
 * canonical generation, and it goes with the account.
 *
 * **Matching them to canonical ideas: still open.** Bringing an imported highlight into
 * the Delta means embedding it, which is a model call over the reader's own verbatim
 * text — a per-reader cost with no amortisation, and a privacy promise that has to be
 * revisited before it is spent rather than after. That is package 9, and it is not this.
 *
 * So an import lands as the reader's own private Pulls, scheduled and saved, and the
 * Delta does not know about them. Two mechanics still do not reach them, and the
 * migration's own header says so: search filters `visibility = 'public'` in all three
 * branches, and nothing writes `pulls.embedding` outside the pipeline.
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
  /*
   * A quote only opens a quoted field at the *start* of a field.
   *
   * Treating `"` as an opener anywhere is how a lenient-looking scanner becomes far more
   * destructive than the line-splitter it replaced. A highlight containing an inch mark
   * — `We got 6" of snow` — would open quote mode mid-field, then swallow every comma and
   * newline after it until the next `"` somewhere later in the file. One stray character
   * took the whole import to zero records, and `Ingestion.tsx` renders that as a blank
   * screen with no error. Excel and Papa Parse both honour the quote only at field start;
   * anywhere else it is just a character in the text.
   */
  let atFieldStart = true;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          // Closing quote. Anything before the next delimiter is appended literally,
          // which is what a spreadsheet does with `"a"b`.
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (ch === ',') {
      record.push(field);
      field = '';
      atFieldStart = true;
    } else if (ch === '\n' || ch === '\r') {
      // A bare CR, or the CR of a CRLF: end the record once, not twice.
      if (ch === '\r' && input[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      atFieldStart = true;
    } else {
      field += ch;
      atFieldStart = false;
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

// --------------------------------------------------------------- for commit_import

/** One highlight in the shape `commit_import` accepts. */
export interface ImportItem {
  title: string;
  author?: string;
  text: string;
  locator?: string;
}

/**
 * What `commit_import` refuses, mirrored here so a reader is not told about it by a 500.
 *
 * Every number is the migration's own. 500 items a call is `max_items_per_call`; 200 is
 * the `left(..., 200)` the RPC applies to a title, an author and a locator; 20,000 is
 * `commit_import: a highlight of % characters exceeds 20000`. Mirroring rather than
 * trusting, because the RPC raises `22023` for the whole chunk when one item is wrong,
 * and a reader whose 400th highlight is empty should lose that highlight rather than the
 * other 399.
 */
export const MAX_ITEMS_PER_CALL = 500;
const MAX_FIELD = 200;
const MAX_TEXT = 20000;

/**
 * Collapse whitespace the way `commit_import` does, so the client and the server agree
 * about what is empty and about what is a duplicate.
 *
 * The RPC computes `btrim(regexp_replace(text, '\s+', ' ', 'g'))` and hashes the result,
 * so a highlight that survives a copy through three apps arrives with different line
 * breaks and is the same highlight. Collapse first, then trim: `btrim` with one argument
 * removes spaces only, so tabs and newlines alone would otherwise survive as " ".
 */
export function normaliseHighlight(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Shape parsed highlights into import items, dropping the ones the RPC would refuse.
 *
 * DROPPED RATHER THAN SENT, and that asymmetry is the point. `commit_import` validates
 * per item and raises on the first bad one, which aborts the whole chunk — so one
 * highlight with no text would cost the reader the other 499. Anything this function
 * cannot make acceptable is left out, and the caller can say how many.
 *
 * Truncation is not a drop: a 300-character title is a real book with a long title, and
 * the RPC would truncate it to 200 anyway. Doing it here means the `content_hash` the
 * server computes matches what this client would predict.
 */
export function toImportItems(highlights: readonly ParsedHighlight[]): {
  items: ImportItem[];
  skipped: number;
} {
  const items: ImportItem[] = [];
  let skipped = 0;

  for (const h of highlights) {
    const title = h.bookTitle?.trim().slice(0, MAX_FIELD) ?? '';
    const text = normaliseHighlight(h.text ?? '');

    // The two the RPC raises on. A highlight with no title has nothing to file it
    // under; one with no text is not a highlight.
    if (!title || !text || text.length > MAX_TEXT) {
      skipped += 1;
      continue;
    }

    const author = h.bookAuthor?.trim().slice(0, MAX_FIELD);
    const locator = h.location?.trim().slice(0, MAX_FIELD);

    items.push({
      title,
      text,
      ...(author ? { author } : {}),
      ...(locator ? { locator } : {}),
    });
  }

  return { items, skipped };
}

/**
 * Split items into chunks the RPC will accept.
 *
 * 500 is `max_items_per_call`, and the reason the batch survives being split is
 * `p_import_id`: `commit_import` returns an `importId` and a client chunking one upload
 * passes it back for chunks two onward, so all of them land in one batch and one Undo
 * takes the whole file. Without that they would be separate batches and an Undo would
 * remove a fifth of a library.
 */
export function chunkItems<T>(items: readonly T[], size = MAX_ITEMS_PER_CALL): T[][] {
  if (size < 1) throw new RangeError('chunkItems: size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
