import { describe, expect, it } from 'vitest';
import {
  EMPTY_RESULT,
  MIN_QUERY_LENGTH,
  classifyQuery,
  countLine,
  isEmptyResult,
  normaliseQuery,
  shapeSearchResult,
  terminalLine,
  type SearchResult,
} from './search.js';

/**
 * The pure half of search.
 *
 * Two things here are worth more than they look. The shaper is the only thing
 * standing between a jsonb blob supabase-js types as `Json` and a component that
 * assumes every field is a string — and this repo has already lost a pipeline
 * run to values TypeScript accepted and Postgres rejected, so narrowing at the
 * boundary is a habit rather than a nicety. And the two terminal sentences are a
 * law-7 requirement: a truncated list and a complete one must not read the same,
 * because only one of them is something the reader can act on.
 */

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  ...EMPTY_RESULT,
  ...over,
  counts: { ...EMPTY_RESULT.counts, ...(over.counts ?? {}) },
});

describe('normaliseQuery', () => {
  it('collapses the whitespace a paste brings with it', () => {
    expect(normaliseQuery('  spaced   out \n text  ')).toBe('spaced out text');
  });

  it('does not lower-case, because the raw text is echoed back to the reader', () => {
    expect(normaliseQuery('On Liberty')).toBe('On Liberty');
  });
});

describe('classifyQuery', () => {
  it('treats whitespace as empty rather than as a short query', () => {
    expect(classifyQuery('   ')).toBe('empty');
  });

  it('reports a single character as too short, matching the SQL guard', () => {
    expect(classifyQuery('a')).toBe('too-short');
    expect(MIN_QUERY_LENGTH).toBe(2);
  });

  it('is ready at the minimum length, not one past it', () => {
    expect(classifyQuery('ab')).toBe('ready');
  });
});

describe('shapeSearchResult', () => {
  it('returns the empty result for anything that is not an object', () => {
    for (const junk of [null, undefined, 'x', 42, []]) {
      expect(shapeSearchResult(junk)).toEqual(EMPTY_RESULT);
    }
  });

  it('keeps a well-formed payload intact', () => {
    const shaped = shapeSearchResult({
      query: 'habit',
      tooShort: false,
      ideas: [
        {
          id: 'p1',
          summaryId: 's1',
          workId: 'w1',
          headline: 'A headline',
          body: 'A body',
          workTitle: 'A work',
          workKind: 'book',
          workYear: 1859,
          estimatedReadSeconds: 30,
          alreadyKnown: true,
        },
      ],
      sources: [
        {
          id: 'w1',
          title: 'A work',
          subtitle: null,
          slug: 'a-work',
          kind: 'book',
          year: 1859,
          matchingIdeas: 3,
        },
      ],
      alsoClose: [
        { id: 'p9', summaryId: 's9', workId: 'w9', headline: 'Close', workTitle: 'Other' },
      ],
      counts: { ideas: 11, sources: 4, capped: true },
    });

    expect(shaped.ideas[0]?.alreadyKnown).toBe(true);
    expect(shaped.ideas[0]?.workYear).toBe(1859);
    expect(shaped.sources[0]?.matchingIdeas).toBe(3);
    expect(shaped.alsoClose[0]?.workTitle).toBe('Other');
    expect(shaped.counts).toEqual({ ideas: 11, sources: 4, capped: true });
  });

  it('drops a row with no id rather than rendering a dead entry', () => {
    const shaped = shapeSearchResult({
      ideas: [{ headline: 'no id' }, { id: 'p1', headline: 'kept' }],
      sources: [{ title: 'no id' }],
      alsoClose: [{ headline: 'no id' }],
    });
    expect(shaped.ideas.map((i) => i.id)).toEqual(['p1']);
    expect(shaped.sources).toEqual([]);
    expect(shaped.alsoClose).toEqual([]);
  });

  it('never lets a missing field become the string "undefined"', () => {
    const shaped = shapeSearchResult({ ideas: [{ id: 'p1' }] });
    expect(shaped.ideas[0]?.headline).toBe('');
    expect(shaped.ideas[0]?.workYear).toBeNull();
    expect(shaped.ideas[0]?.estimatedReadSeconds).toBeNull();
  });

  it('treats alreadyKnown as true only when it is exactly true', () => {
    // A truthy string would otherwise mark every result as known and the Delta
    // annotation would say the reader has read the entire library.
    const shaped = shapeSearchResult({
      ideas: [
        { id: 'a', alreadyKnown: 'yes' },
        { id: 'b', alreadyKnown: 1 },
        { id: 'c', alreadyKnown: true },
      ],
    });
    expect(shaped.ideas.map((i) => i.alreadyKnown)).toEqual([false, false, true]);
  });

  it('survives counts arriving as something other than numbers', () => {
    const shaped = shapeSearchResult({ counts: { ideas: 'lots', sources: null, capped: 'yes' } });
    expect(shaped.counts).toEqual({ ideas: 0, sources: 0, capped: false });
  });
});

describe('countLine', () => {
  it('singularises one of each', () => {
    expect(countLine(result({ counts: { ideas: 1, sources: 1, capped: false } }))).toBe(
      '1 idea in 1 source',
    );
  });

  it('pluralises the rest', () => {
    expect(countLine(result({ counts: { ideas: 17, sources: 6, capped: false } }))).toBe(
      '17 ideas in 6 sources',
    );
  });

  it('does not claim ideas when only a source title matched', () => {
    expect(countLine(result({ counts: { ideas: 0, sources: 2, capped: false } }))).toBe(
      '2 sources',
    );
  });

  it('says so plainly when nothing matched', () => {
    expect(countLine(EMPTY_RESULT)).toBe('Nothing matches');
  });
});

describe('terminalLine', () => {
  it('says nothing when nothing matched at all', () => {
    expect(terminalLine(EMPTY_RESULT)).toBe('');
  });

  it('closes a complete list without inviting a narrower search', () => {
    const line = terminalLine(
      result({
        query: 'liberty',
        ideas: [{ id: 'p1' }] as never,
        sources: [{ id: 'w1' }] as never,
        counts: { ideas: 1, sources: 1, capped: false },
      }),
    );
    expect(line).toBe('That is everything matching \u201Cliberty\u201D.');
    expect(line).not.toContain('Narrow');
  });

  it('reports a truncated idea list, counting what is on screen', () => {
    expect(
      terminalLine(
        result({
          query: 'habit',
          ideas: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never,
          sources: [{ id: 'w1' }] as never,
          counts: { ideas: 40, sources: 1, capped: true },
        }),
      ),
    ).toBe('Showing 3 of 40 ideas. Narrow the search to see others.');
  });

  it('reports a truncated source list too, which `capped` never described', () => {
    expect(
      terminalLine(
        result({
          query: 'liberty',
          ideas: [{ id: 'a' }] as never,
          sources: [{ id: 'w1' }, { id: 'w2' }] as never,
          counts: { ideas: 1, sources: 12, capped: false },
        }),
      ),
    ).toBe('Showing 2 of 12 sources. Narrow the search to see others.');
  });

  it('reports both when both are cut', () => {
    expect(
      terminalLine(
        result({
          query: 'x',
          ideas: [{ id: 'a' }] as never,
          sources: [{ id: 'w1' }] as never,
          counts: { ideas: 40, sources: 12, capped: true },
        }),
      ),
    ).toBe('Showing 1 of 40 ideas and 1 of 12 sources. Narrow the search to see others.');
  });

  it('never goes blank when a query matched a source but no idea', () => {
    // "Walden" is in a work title and in no pull's text. The page must still end
    // on a sentence rather than on a rule and an empty paragraph.
    const line = terminalLine(
      result({
        query: 'Walden',
        ideas: [],
        sources: [{ id: 'w1' }] as never,
        counts: { ideas: 0, sources: 1, capped: false },
      }),
    );
    expect(line).not.toBe('');
    expect(line).toBe('That is everything matching \u201CWalden\u201D.');
  });
});

describe('isEmptyResult', () => {
  it('is empty only when neither ideas nor sources came back', () => {
    expect(isEmptyResult(EMPTY_RESULT)).toBe(true);
    expect(isEmptyResult(result({ sources: [{ id: 'w1' } as never] }))).toBe(false);
    expect(isEmptyResult(result({ ideas: [{ id: 'p1' } as never] }))).toBe(false);
  });
});
