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

  it('makes a whitespace-only highlight empty, which is what the server checks', () => {
    // NOT an assertion about the ORDER of the collapse and the trim, which an earlier
    // name and comment here claimed: `String.prototype.trim` strips tabs and newlines,
    // so both orders give the same answer for every input and the mutation that swaps
    // them passes. The order matters in the MIGRATION, where one-argument `btrim` strips
    // spaces only -- that is the SQL's reason, and it was borrowed here for JavaScript
    // that does not need it.
    //
    // What this does assert is the property that has to agree with the server:
    // `commit_import` refuses an item whose normalised text is empty (`:835`), so the
    // client must call the same thing empty or it sends a chunk the RPC will reject
    // whole.
    expect(normaliseHighlight('\t\n  \r\n')).toBe('');
  });

  it('strips NUL, which the server cannot even be asked about', () => {
    // Everything else in this module mirrors a bound `commit_import` checks. `U+0000` is
    // different in kind: Postgres cannot hold it in `text`, so `p_items` fails at the
    // jsonb cast with `22P05` before validation runs at all -- and the cost is the whole
    // chunk, 499 good highlights for one stray byte from a UTF-16 export.
    expect(normaliseHighlight('a\u0000b')).toBe('ab');
    expect(normaliseHighlight('\u0000')).toBe('');
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
    // The RPC applies `left(..., 200)` itself, so a long title is a real book rather than
    // a bad item. Truncating here is so the reader's screen and the stored row agree
    // about what was kept -- NOT, as this comment used to claim, so a hash matches "what
    // this client would predict". Nothing here predicts a hash: the server computes
    // `content_hash` from what it receives, after its own `left(..., 200)`.
    const { items, skipped } = toImportItems([
      h({ bookTitle: 'T'.repeat(300), bookAuthor: 'A'.repeat(300), location: 'L'.repeat(300) }),
    ]);
    expect(skipped).toBe(0);
    expect(items[0]?.title).toHaveLength(200);
    expect(items[0]?.author).toHaveLength(200);
    expect(items[0]?.locator).toHaveLength(200);
  });

  it('strips NUL from the title, author and locator, not only from the text', () => {
    /*
     * Postgres cannot hold `U+0000` in `text`, so `p_items` fails at the jsonb CAST with
     * `22P05` before `commit_import` validates anything -- costing the whole 500-item
     * chunk. The strip lived inside `normaliseHighlight`, which only the text goes
     * through, so three of the four keys still carried it. `String.prototype.trim` does
     * not remove NUL, so the old `.trim().slice()` path left it on the wire.
     *
     * A UTF-16 clippings file read without a BOM interleaves NULs through every field,
     * which is why the title is at least as likely a carrier as the text.
     */
    const nul = String.fromCharCode(0);
    const { items } = toImportItems([
      h({
        bookTitle: `Medi${nul}tations`,
        bookAuthor: `Mar${nul}cus`,
        location: `loc${nul} 1`,
        text: `a hi${nul}ghlight`,
      }),
    ]);
    expect(JSON.stringify(items)).not.toContain('\\u0000');
    expect(items[0]?.title).toBe('Meditations');
    expect(items[0]?.author).toBe('Marcus');
  });

  it.each([
    // The 200th unit is the LEADING half of a pair, so it must go. `0xD800` and `0xDBFF`
    // are the ends of the high-surrogate range and were both unpinned: the only fixture
    // used `0xD83D`, comfortably inside it, so `>= 0xd800` -> `> 0xd800` and
    // `<= 0xdbff` -> `< 0xdbff` both survived while leaving a lone surrogate behind.
    ['the low end of the range', 0x10000, 199],
    ['the high end of the range', 0x10fc00, 199],
    ['an ordinary emoji', 0x1f600, 199],
    // And the pair that ENDS exactly at 200 must be kept whole. This is the case that
    // matters most: widening the upper bound to `0xdfff` strips a valid LOW surrogate and
    // so CREATES the lone high surrogate the guard exists to remove -- a mutant that made
    // the defect rather than missing it, one boundary over from the fixture above.
    ['a pair ending exactly at the bound', 0x1f600, 198],
  ])('truncates around %s without leaving half a character', (_name, codePoint, xs) => {
    const title = 'x'.repeat(xs) + String.fromCodePoint(codePoint) + 'tail';
    const { items } = toImportItems([h({ bookTitle: title })]);
    const kept = items[0]?.title ?? '';
    expect(kept).toHaveLength(xs === 198 ? 200 : 199);
    // No unpaired surrogate of either kind survives.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(kept),
    ).toBe(false);
    expect(JSON.stringify(items)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it('does not cut a surrogate pair in half when it truncates', () => {
    /*
     * `left` counts CHARACTERS; `slice` counts UTF-16 CODE UNITS. A title whose 200th
     * unit fell between the halves of an astral character was cut into a lone high
     * surrogate, which `JSON.stringify` emits as a bare `\ud83d` -- not encodable as
     * UTF-8, refused by Postgres's JSON parser, and so the same whole-chunk loss as a
     * NUL, introduced by this module's own truncation.
     *
     * `toHaveLength(200)` alone cannot see this: a split pair is still 200 units.
     */
    const title = 'x'.repeat(199) + String.fromCodePoint(0x1f600) + 'tail';
    const { items } = toImportItems([h({ bookTitle: title })]);
    const kept = items[0]?.title ?? '';
    expect(kept).toHaveLength(199);
    expect(/[\uD800-\uDBFF]/.test(kept)).toBe(false);
    expect(JSON.stringify(items)).not.toContain('\\ud83d');
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
