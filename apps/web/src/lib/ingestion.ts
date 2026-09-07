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
 * the `left(..., 200)` the RPC applies to a title, an author and a locator (`:819`,
 * `:820`, `:822` -- `:821` is the text itself and is not truncated); 20,000 is the bound
 * at `:838`, whose message at `:839-840` reads `commit_import: a highlight of %
 * characters exceeds 20000`. Mirroring rather than
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
 * The RPC computes `btrim(regexp_replace(v_raw, '\s+', ' ', 'g'))` (`:830`) and hashes
 * the result, so a highlight that survives a copy through three apps arrives with
 * different line breaks and is the same highlight.
 *
 * NUL IS REMOVED FIRST, and it is the one character that does not merely fail
 * validation. Postgres cannot represent `U+0000` in `text` at all, so `p_items` fails at
 * the jsonb CAST -- `22P05 unsupported Unicode escape sequence` -- before
 * `commit_import` looks at anything. That is earlier than every bound this module
 * mirrors, and the cost is the same: the whole chunk, so 499 good highlights for one
 * stray byte. Reachable from a UTF-16 clippings file read as text without a BOM.
 *
 * The `\s+` collapse and the trim are written in that order, and the order does not
 * matter in JavaScript: `String.prototype.trim` strips tabs and newlines, unlike the
 * one-argument `btrim` the SQL comment is about. An earlier version of this doc claimed
 * the ordering was load-bearing here; it is load-bearing in the migration, not in this
 * function, and the mutation that swaps them passes.
 */
export function normaliseHighlight(text: string): string {
  /*
   * `\s` IS NOT THE SAME SET IN JAVASCRIPT AND IN POSTGRES, and the difference is five
   * codepoints that cost a reader a whole chunk.
   *
   * Review finding, found by scanning every codepoint in Unicode against both rules
   * rather than by reading either. Postgres's `\s` matches U+001C, U+001D, U+001E,
   * U+001F and U+0085; JavaScript's does not. So a highlight made only of those is
   * non-empty here and empty to `commit_import`, which raises `22023` for the whole
   * 500-item chunk -- the exact failure `toImportItems` exists to prevent, since a
   * reader whose 400th highlight is empty should lose that highlight and not the other
   * 399.
   *
   * The second half was worse: `batchIsGone` reads any `22023` as the tombstone and the
   * screen then clears `result`, so the reader loses the only handle this PR ships on
   * rows that DID land. Reproduced end to end through the real parsers -- a
   * `My Clippings.txt` whose second body line is U+0085 reaches the RPC, and a Readwise
   * CSV with U+001E does too.
   *
   * Listed explicitly rather than widened to `\p{White_Space}`: that adds U+180E and the
   * Mongolian vowel separator, which Postgres does NOT strip, and a client that calls
   * something empty when the server would keep it drops a highlight the reader wrote.
   * The rule here has to be a superset of the server's and nothing more.
   */
  let t = stripNul(text);
  // `replaceAll` with strings rather than a character class, for the reason `stripNul`
  // below gives: `no-control-regex` rejects a control character in a pattern, and these
  // need no pattern. Mapped to a plain space first, so the existing collapse then folds a
  // run of them into one exactly as it folds tabs and newlines.
  for (const ch of POSTGRES_ONLY_WHITESPACE) t = t.replaceAll(ch, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * The five codepoints Postgres calls whitespace and JavaScript does not.
 *
 * Found by scanning every codepoint in Unicode against both rules, not by reading either.
 * Named as a constant because the set is the whole of the agreement with `commit_import`:
 * if the migration's `\s` ever means something else, this is the line that has to move.
 */
const POSTGRES_ONLY_WHITESPACE = ['\u001c', '\u001d', '\u001e', '\u001f', '\u0085'];

/**
 * Remove the one character Postgres cannot carry through the jsonb cast.
 *
 * `replaceAll` with a string rather than a regex: `no-control-regex` rejects a control
 * character in a pattern, and this needs no pattern.
 *
 * SHARED BY ALL FOUR FIELDS rather than living inside `normaliseHighlight`, which is
 * where it was -- and which is why it only ever protected the text. `title`, `author`
 * and `locator` do not want the `\s+` collapse, since they are neither hashed nor
 * compared for duplicates, but they want this: the cast that raises `22P05` does not
 * care which key the NUL was under, and a UTF-16 clippings file read without a BOM
 * interleaves them through every field rather than only the text.
 */
function stripNul(value: string): string {
  return value.replaceAll('\u0000', '');
}

/**
 * Trim, drop what the cast would refuse, and truncate WITHOUT SPLITTING A CHARACTER.
 *
 * The three short fields, which the RPC truncates with `left(..., 200)` (`:819`,
 * `:820`, `:822`). Doing it here keeps the reader's screen and the stored row saying
 * the same thing; doing it with a bare `slice` introduced a second way to lose a chunk.
 *
 * `left` counts CHARACTERS and `String.prototype.slice` counts UTF-16 CODE UNITS, so a
 * title whose 200th unit fell between the halves of an astral character -- an emoji, a
 * rarer CJK ideograph -- was cut into a LONE HIGH SURROGATE. `JSON.stringify` emits that
 * as a bare `\ud83d`, which is not encodable as UTF-8 and which Postgres's JSON parser
 * refuses, so the whole 500-item chunk dies before validation -- the same failure and the
 * same cost as the NUL above, reached by this module's own truncation rather than by
 * anything that was in the file.
 *
 * Only a lone HIGH surrogate is reachable: the input is well-formed, so cutting it can
 * orphan the leading half of a pair and never the trailing half. `charCodeAt` of an
 * empty string is `NaN`, which fails the comparison, so the empty case needs no guard.
 */
function shapeField(value: string | undefined): string {
  const clipped = stripNul(value ?? '')
    .trim()
    .slice(0, MAX_FIELD);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
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
 * the RPC truncates it to 200 anyway (`:819-822`). Doing it here is so the reader's
 * screen and the stored row agree about what was kept -- not, as an earlier version of
 * this said, so a hash matches "what this client would predict". Nothing here predicts a
 * hash: `content_hash` is computed by the server from the values it receives, after its
 * own `left(..., 200)`, so client-side truncation cannot change it either way.
 *
 * All four fields go through a sanitiser, and that is the correction rather than the
 * design. Only the text did, because the NUL strip was written inside
 * `normaliseHighlight`, so a NUL in a title still cost the whole chunk -- the exact
 * failure the strip was added to prevent, left reachable on three of the four keys it
 * had to cover. See `shapeField`.
 */
export function toImportItems(highlights: readonly ParsedHighlight[]): {
  items: ImportItem[];
  skipped: number;
} {
  const items: ImportItem[] = [];
  let skipped = 0;

  for (const h of highlights) {
    const title = shapeField(h.bookTitle);
    const text = normaliseHighlight(h.text ?? '');

    // The two the RPC raises on. A highlight with no title has nothing to file it
    // under; one with no text is not a highlight.
    if (!title || !text || text.length > MAX_TEXT) {
      skipped += 1;
      continue;
    }

    const author = shapeField(h.bookAuthor);
    const locator = shapeField(h.location);

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
