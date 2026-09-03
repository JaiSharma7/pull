import { describe, expect, it } from 'vitest';
import { parseCsvHighlights, parseKindleClippings, summarizeIngestion } from './ingestion.js';

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
