import { describe, expect, it } from 'vitest';
import {
  type Highlight,
  anchor,
  mergeRanges,
  shapeHighlights,
  splitByRanges,
  toMarkdown,
} from './highlights.js';

/**
 * Offsets describe a string that can change underneath them, and `anchor` is
 * the whole defence. A highlight drawn at a stale offset underlines the wrong
 * words silently, which is worse than losing it — so the stored `text` is what
 * survives and the offsets only choose between occurrences.
 */

const h = (over: Partial<Highlight> = {}): Highlight => ({
  id: 'h1',
  pullId: 'p1',
  field: 'body',
  start: 0,
  end: 4,
  text: 'test',
  ...over,
});

describe('anchor', () => {
  const text = 'The cost of a thing is the amount of life exchanged for it.';

  it('uses the offsets when they still point at their own text', () => {
    expect(anchor(text, h({ start: 4, end: 8, text: 'cost' }))).toEqual({ start: 4, end: 8 });
  });

  it('re-finds the text when something was inserted before it', () => {
    const shifted = 'Well, ' + text;
    expect(anchor(shifted, h({ start: 4, end: 8, text: 'cost' }))).toEqual({
      start: 10,
      end: 14,
    });
  });

  it('is null when the text is gone, rather than guessing a position', () => {
    expect(anchor(text, h({ text: 'nowhere in this string' }))).toBeNull();
  });

  it('is null for an empty needle', () => {
    expect(anchor(text, h({ text: '' }))).toBeNull();
  });

  it('picks the occurrence nearest where it used to be', () => {
    // A reader who highlighted the SECOND "of" should keep the second one.
    const first = text.indexOf('of');
    const second = text.indexOf('of', first + 1);
    expect(anchor(text, h({ start: second, end: second + 2, text: 'of' }))).toEqual({
      start: second,
      end: second + 2,
    });
    expect(anchor(text, h({ start: first, end: first + 2, text: 'of' }))).toEqual({
      start: first,
      end: first + 2,
    });
  });
});

describe('mergeRanges', () => {
  it('merges overlapping ranges so marks never nest', () => {
    expect(
      mergeRanges([
        { start: 0, end: 5 },
        { start: 3, end: 9 },
      ]),
    ).toEqual([{ start: 0, end: 9 }]);
  });

  it('merges ranges that merely touch', () => {
    expect(
      mergeRanges([
        { start: 0, end: 5 },
        { start: 5, end: 8 },
      ]),
    ).toEqual([{ start: 0, end: 8 }]);
  });

  it('keeps separate ranges separate, in order', () => {
    expect(
      mergeRanges([
        { start: 10, end: 12 },
        { start: 0, end: 5 },
      ]),
    ).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 12 },
    ]);
  });

  it('swallows a range fully inside another', () => {
    expect(
      mergeRanges([
        { start: 0, end: 20 },
        { start: 5, end: 8 },
      ]),
    ).toEqual([{ start: 0, end: 20 }]);
  });

  it('drops empty and inverted ranges', () => {
    expect(
      mergeRanges([
        { start: 5, end: 5 },
        { start: 9, end: 2 },
      ]),
    ).toEqual([]);
  });
});

describe('splitByRanges', () => {
  const text = 'abcdefghij';

  it('returns one unmarked run when nothing is highlighted', () => {
    expect(splitByRanges(text, [])).toEqual([{ text, marked: false }]);
  });

  it('splits around a highlight in the middle', () => {
    expect(splitByRanges(text, [{ start: 3, end: 6 }])).toEqual([
      { text: 'abc', marked: false },
      { text: 'def', marked: true },
      { text: 'ghij', marked: false },
    ]);
  });

  it('handles a highlight at each edge', () => {
    expect(splitByRanges(text, [{ start: 0, end: 2 }])[0]).toEqual({ text: 'ab', marked: true });
    const tail = splitByRanges(text, [{ start: 8, end: 10 }]);
    expect(tail[tail.length - 1]).toEqual({ text: 'ij', marked: true });
  });

  it('never loses or duplicates a character', () => {
    const out = splitByRanges(text, [
      { start: 1, end: 3 },
      { start: 2, end: 5 },
      { start: 7, end: 9 },
    ]);
    expect(out.map((s) => s.text).join('')).toBe(text);
  });

  it('clamps a range that runs past the end of the text', () => {
    const out = splitByRanges('abc', [{ start: 1, end: 99 }]);
    expect(out.map((s) => s.text).join('')).toBe('abc');
    expect(out).toEqual([
      { text: 'a', marked: false },
      { text: 'bc', marked: true },
    ]);
  });

  it('returns nothing for empty text', () => {
    expect(splitByRanges('', [{ start: 0, end: 3 }])).toEqual([]);
  });
});

describe('shapeHighlights', () => {
  it('drops rows with an unknown field or an inverted range', () => {
    const out = shapeHighlights([
      { id: 'a', field: 'body', start: 0, end: 3, text: 'abc' },
      { id: 'b', field: 'headline', start: 0, end: 3, text: 'abc' },
      { id: 'c', field: 'body', start: 5, end: 5, text: '' },
      { field: 'body', start: 0, end: 2, text: 'ab' },
    ]);
    expect(out.map((x) => x.id)).toEqual(['a']);
  });
});

describe('toMarkdown', () => {
  const when = new Date('2026-09-01T12:00:00Z');

  it('says so plainly when there is nothing to export', () => {
    expect(toMarkdown([], when)).toContain('Nothing highlighted yet.');
  });

  it('omits a source with no highlights and no notes', () => {
    const out = toMarkdown(
      [
        { title: 'Empty', ideas: [{ headline: 'x', highlights: [], note: null }] },
        { title: 'Walden', ideas: [{ headline: 'The cost', highlights: ['a life'], note: null }] },
      ],
      when,
    );
    expect(out).not.toContain('Empty');
    expect(out).toContain('## Walden');
  });

  it("keeps the source's words and the reader's visibly apart", () => {
    // Losing that distinction is how a quotation ends up attributed to whoever
    // saved it rather than to whoever wrote it.
    const out = toMarkdown(
      [
        {
          title: 'On Liberty',
          ideas: [{ headline: 'Silencing', highlights: ['robs'], note: 'mine' }],
        },
      ],
      when,
    );
    expect(out).toContain('> robs');
    expect(out).toContain('**Note:** mine');
  });

  it('dates the export', () => {
    expect(toMarkdown([], when)).toContain('2026-09-01');
  });
});
