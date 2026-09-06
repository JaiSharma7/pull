import { describe, expect, it } from 'vitest';
import {
  chunkItems,
  normaliseHighlight,
  type ParsedHighlight,
  parseCsvHighlights,
  parseKindleClippings,
  summarizeIngestion,
  toImportItems,
} from './ingestion.js';

/*
 * Every fixture here quotes a public-domain work.
 *
 * The fixtures this replaces carried verbatim lines from *Thinking, Fast and Slow*,
 * *Antifragile* and *Being and Nothingness*. A reader's own clippings file legitimately
 * contains such quotes — that is the whole point of the parser — but a fixture is
 * committed, and law 4 is about what is in this repository rather than what passes
 * through the browser. Public-domain text exercises the parser identically.
 */
describe('Universal Ingestion Bridge', () => {
  const sampleClippings = `Meditations (Marcus Aurelius)
- Your Highlight on page 42 | location 642-643 | Added on Monday, October 14, 2024 8:20:15 PM

You have power over your mind - not outside events. Realize this, and you will find strength.
==========
Walden (Henry David Thoreau)
- Your Highlight on page 19 | location 280-281 | Added on Tuesday, October 15, 2024 10:14:02 AM

The cost of a thing is the amount of what I will call life which is required to be exchanged for it.
==========
`;

  it('parses Kindle clippings with author, title, and quote', () => {
    const highlights = parseKindleClippings(sampleClippings);
    expect(highlights.length).toBe(2);

    expect(highlights[0]?.bookTitle).toBe('Meditations');
    expect(highlights[0]?.bookAuthor).toBe('Marcus Aurelius');
    expect(highlights[0]?.text).toContain('power over your mind');

    expect(highlights[1]?.bookTitle).toBe('Walden');
    expect(highlights[1]?.bookAuthor).toBe('Henry David Thoreau');
  });

  it('parses CSV highlights cleanly', () => {
    const csv = `Highlight,Book Title,Book Author
"We suffer more often in imagination than in reality.",Letters from a Stoic,Seneca
"It is not that we have a short time to live, but that we waste a lot of it.",On the Shortness of Life,Seneca
`;
    const highlights = parseCsvHighlights(csv);
    expect(highlights.length).toBe(2);
    expect(highlights[0]?.bookTitle).toBe('Letters from a Stoic');
    expect(highlights[1]?.bookTitle).toBe('On the Shortness of Life');
  });

  /*
   * The bug this guards: the parser split on physical lines before it looked at quotes,
   * so a quoted highlight containing a newline — which most long highlights do — became
   * several records. The fragment that failed the column count was dropped and the rest
   * were imported carrying whatever fields happened to fall in them, so the import came
   * out wrong rather than empty.
   */
  it('keeps a quoted highlight that spans lines as one record', () => {
    const csv = `Highlight,Book Title,Book Author
"You have power over your mind - not outside events.
Realize this, and you will find strength.",Meditations,Marcus Aurelius
"A second one, on its own line.",Walden,Henry David Thoreau
`;
    const highlights = parseCsvHighlights(csv);
    expect(highlights.length).toBe(2);
    expect(highlights[0]?.text).toContain('power over your mind');
    expect(highlights[0]?.text).toContain('you will find strength');
    expect(highlights[0]?.bookTitle).toBe('Meditations');
    expect(highlights[1]?.bookTitle).toBe('Walden');
  });

  it('unescapes a doubled quote inside a field', () => {
    const csv = `Highlight,Book Title,Book Author
"He said ""the obstacle is the way"" and meant it.",Meditations,Marcus Aurelius
`;
    const highlights = parseCsvHighlights(csv);
    expect(highlights[0]?.text).toBe('He said "the obstacle is the way" and meant it.');
  });

  it('handles CRLF line endings without inventing blank records', () => {
    const csv =
      'Highlight,Book Title,Book Author\r\n"We suffer more often in imagination than in reality.",Letters from a Stoic,Seneca\r\n';
    expect(parseCsvHighlights(csv).length).toBe(1);
  });

  it('counts books and authors separately', () => {
    // Two books, one author: the count that used to report "Identified Authors" was
    // `distinctBooks.length`, so this case read 2.
    const highlights = parseCsvHighlights(
      `Highlight,Book Title,Book Author
"We suffer more often in imagination than in reality.",Letters from a Stoic,Seneca
"It is not that we have a short time to live.",On the Shortness of Life,Seneca
`,
    );
    const summary = summarizeIngestion(highlights);
    expect(summary.distinctBooks.length).toBe(2);
    expect(summary.distinctAuthors.length).toBe(1);
  });

  it('summarizes distinct books', () => {
    const summary = summarizeIngestion(parseKindleClippings(sampleClippings));
    expect(summary.totalHighlights).toBe(2);
    expect(summary.distinctBooks.length).toBe(2);
  });
});

/*
 * The regression that made the scanner worse than what it replaced.
 *
 * An inch mark, or any other bare `"` inside an unquoted field, used to open quote mode
 * mid-field and then swallow commas and newlines until the next `"` — so one stray
 * character took an entire import to zero records, rendered as a blank screen. The
 * line-splitting parser it replaced corrupted only the line it was on.
 */
describe('CSV quoting is only special at the start of a field', () => {
  const csv = `Highlight,Book Title,Book Author
We got 6" of snow that winter and it mattered,Walden,Thoreau
"A perfectly normal highlight number two.",Meditations,Marcus Aurelius
"A perfectly normal highlight number three.",The Enchiridion,Epictetus
`;

  it('keeps every record when a field contains a bare quote', () => {
    const highlights = parseCsvHighlights(csv);
    expect(highlights.length).toBe(3);
    expect(highlights.map((h) => h.bookTitle)).toEqual([
      'Walden',
      'Meditations',
      'The Enchiridion',
    ]);
  });

  it('keeps the bare quote in the text rather than eating it', () => {
    expect(parseCsvHighlights(csv)[0]?.text).toBe('We got 6" of snow that winter and it mattered');
  });

  it('still treats a leading quote as a quoted field', () => {
    const quoted = `Highlight,Book Title,Book Author
"One, with a comma inside",Walden,Thoreau
`;
    const h = parseCsvHighlights(quoted);
    expect(h.length).toBe(1);
    expect(h[0]?.text).toBe('One, with a comma inside');
    expect(h[0]?.bookTitle).toBe('Walden');
  });
});

describe('normaliseHighlight', () => {
  it('collapses every run of whitespace to one space, then trims', () => {
    // The RPC computes `btrim(regexp_replace(text, '\s+', ' ', 'g'))` and hashes the
    // result, so this has to agree with it exactly or the client's idea of a duplicate
    // and the server's differ.
    expect(normaliseHighlight('  the   obstacle\n\nis the   way \t')).toBe(
      'the obstacle is the way',
    );
  });

  it('collapses before trimming, so whitespace-only is empty', () => {
    // `btrim` with one argument removes spaces only. Trimming first would leave a tab
    // or a newline standing and store a pull whose body is a single space.
    expect(normaliseHighlight('\t\n  \r\n')).toBe('');
  });
});

describe('toImportItems', () => {
  const h = (over: Partial<ParsedHighlight> = {}): ParsedHighlight => ({
    bookTitle: 'Meditations',
    bookAuthor: 'Marcus Aurelius',
    text: 'The obstacle is the way.',
    location: 'loc 101',
    ...over,
  });

  it('shapes a highlight into what commit_import accepts', () => {
    expect(toImportItems([h()])).toEqual({
      items: [
        {
          title: 'Meditations',
          author: 'Marcus Aurelius',
          text: 'The obstacle is the way.',
          locator: 'loc 101',
        },
      ],
      skipped: 0,
    });
  });

  it('omits an absent author and locator rather than sending empty strings', () => {
    // `commit_import` refuses a non-string for either, and `nullif(btrim(...), '')` means
    // an empty string is a null to it anyway. Omitting keeps the payload honest.
    const { items } = toImportItems([h({ bookAuthor: '   ', location: undefined })]);
    expect(items[0]).not.toHaveProperty('author');
    expect(items[0]).not.toHaveProperty('locator');
  });

  it('drops what the RPC would raise on, and counts it', () => {
    // Dropping rather than sending is the whole point: `commit_import` validates per item
    // and raises on the first bad one, which aborts the chunk — so one empty highlight
    // would cost the reader the other 499.
    const { items, skipped } = toImportItems([
      h(),
      h({ bookTitle: '  ' }),
      h({ text: '   \n ' }),
      h({ text: 'x'.repeat(20001) }),
      h({ text: 'kept' }),
    ]);
    expect(items).toHaveLength(2);
    expect(skipped).toBe(3);
  });

  it('keeps a highlight of exactly the maximum length', () => {
    // The bound is `> 20000` in the RPC. An off-by-one here would silently drop a
    // legitimate highlight and report it as unkeepable.
    const { items, skipped } = toImportItems([h({ text: 'x'.repeat(20000) })]);
    expect(items).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  it('truncates rather than drops an over-long title, author or locator', () => {
    // The RPC applies `left(..., 200)` itself, so truncating here makes the content hash
    // this client would predict match the one the server computes.
    const { items, skipped } = toImportItems([
      h({ bookTitle: 'T'.repeat(300), bookAuthor: 'A'.repeat(300), location: 'L'.repeat(300) }),
    ]);
    expect(skipped).toBe(0);
    expect(items[0]?.title).toHaveLength(200);
    expect(items[0]?.author).toHaveLength(200);
    expect(items[0]?.locator).toHaveLength(200);
  });

  it('normalises the text it keeps', () => {
    const { items } = toImportItems([h({ text: 'two\n\nlines' })]);
    expect(items[0]?.text).toBe('two lines');
  });
});

describe('chunkItems', () => {
  it('splits at the RPC ceiling and keeps every item exactly once', () => {
    const items = Array.from({ length: 1201 }, (_, i) => i);
    const chunks = chunkItems(items);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201]);
    expect(chunks.flat()).toEqual(items);
  });

  it('returns no chunks for no items, so no call is made', () => {
    expect(chunkItems([])).toEqual([]);
  });

  it('does not split what already fits', () => {
    expect(chunkItems([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it('refuses a size that would loop forever', () => {
    expect(() => chunkItems([1], 0)).toThrow(RangeError);
  });
});
