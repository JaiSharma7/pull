import { describe, expect, it } from 'vitest';
import {
  EMPTY_CATALOGUE,
  TOPIC_MAX,
  TOPIC_PAGE,
  catalogueSummary,
  expandLimit,
  shapeCatalogue,
  shapeTopicPage,
  topicCountLine,
  topicTerminalLine,
  type TopicPage,
} from './explore.js';

/**
 * The pure half of Explore.
 *
 * `expandLimit` is the law-7 guarantee expressed as a function: it returns null
 * rather than a bigger number, so no sequence of presses produces an unbounded
 * list. And the two terminal sentences must not collapse into one — a complete
 * list and a truncated one read differently because only one of them is
 * something a reader can do anything about.
 */

const page = (over: Partial<TopicPage> = {}): TopicPage => ({
  topic: { slug: 'ethics', label: 'Ethics', parentSlug: 'philosophy', parentLabel: 'Philosophy' },
  sources: [],
  ...over,
  counts: { sources: 0, ideas: 0, known: 0, shown: 0, ...(over.counts ?? {}) },
});

describe('shapeCatalogue', () => {
  it('returns the empty catalogue for anything that is not an object', () => {
    for (const junk of [null, undefined, [], 'x', 3]) {
      expect(shapeCatalogue(junk)).toEqual(EMPTY_CATALOGUE);
    }
  });

  it('keeps a well-formed tree intact', () => {
    const c = shapeCatalogue({
      totals: { sources: 42, ideas: 156, topics: 28 },
      parents: [
        {
          slug: 'philosophy',
          label: 'Philosophy',
          sources: 27,
          ideas: 99,
          children: [{ slug: 'ethics', label: 'Ethics', sources: 11, ideas: 40 }],
        },
      ],
    });
    expect(c.totals).toEqual({ sources: 42, ideas: 156, topics: 28 });
    expect(c.parents[0]?.children[0]?.label).toBe('Ethics');
  });

  it('drops a topic with no slug, because nothing could open it', () => {
    const c = shapeCatalogue({
      parents: [
        { label: 'No slug', sources: 3 },
        { slug: 'ok', label: 'Fine', children: [{ label: 'also no slug' }, { slug: 'c' }] },
      ],
    });
    expect(c.parents.map((p) => p.slug)).toEqual(['ok']);
    expect(c.parents[0]?.children.map((x) => x.slug)).toEqual(['c']);
  });

  it('gives a parent an empty child list rather than undefined', () => {
    const c = shapeCatalogue({ parents: [{ slug: 'a', label: 'A' }] });
    expect(c.parents[0]?.children).toEqual([]);
  });

  it('survives counts that are not numbers', () => {
    const c = shapeCatalogue({ totals: { sources: 'many', ideas: null, topics: Number.NaN } });
    expect(c.totals).toEqual({ sources: 0, ideas: 0, topics: 0 });
  });
});

describe('shapeTopicPage', () => {
  it('is null for the SQL null a missing or empty topic returns', () => {
    expect(shapeTopicPage(null)).toBeNull();
    expect(shapeTopicPage(undefined)).toBeNull();
    expect(shapeTopicPage({})).toBeNull();
    expect(shapeTopicPage({ topic: { label: 'no slug' } })).toBeNull();
  });

  it('keeps a null parent distinct, since a root topic has none', () => {
    const p = shapeTopicPage({
      topic: { slug: 'philosophy', label: 'Philosophy', parentSlug: null, parentLabel: null },
      counts: { sources: 1, ideas: 4, known: 0, shown: 1 },
      sources: [{ id: 'w1', title: 'A work' }],
    });
    expect(p?.topic.parentSlug).toBeNull();
    expect(p?.sources[0]?.title).toBe('A work');
  });

  it('drops a source with no id', () => {
    const p = shapeTopicPage({
      topic: { slug: 'ethics' },
      sources: [{ title: 'no id' }, { id: 'w2', title: 'kept' }],
    });
    expect(p?.sources.map((s) => s.id)).toEqual(['w2']);
  });
});

describe('expandLimit', () => {
  it('offers exactly one expansion and then stops', () => {
    const next = expandLimit(TOPIC_PAGE);
    expect(next).toBe(TOPIC_MAX);
    // The terminal step is the law-7 guarantee: no sequence of presses grows
    // the list without end.
    expect(expandLimit(next!)).toBeNull();
  });

  it('is terminal at and beyond the maximum', () => {
    expect(expandLimit(TOPIC_MAX)).toBeNull();
    expect(expandLimit(TOPIC_MAX + 1)).toBeNull();
  });
});

describe('catalogueSummary', () => {
  it('leads with the size of the whole library', () => {
    expect(catalogueSummary({ totals: { sources: 42, ideas: 156, topics: 28 }, parents: [] })).toBe(
      '42 sources · 156 ideas · 28 topics',
    );
  });

  it('singularises each part independently', () => {
    expect(catalogueSummary({ totals: { sources: 1, ideas: 1, topics: 1 }, parents: [] })).toBe(
      '1 source · 1 idea · 1 topic',
    );
  });
});

describe('topicCountLine', () => {
  it('omits the known count when there is nothing known', () => {
    expect(topicCountLine(page({ counts: { sources: 23, ideas: 190, known: 0, shown: 23 } }))).toBe(
      '23 sources · 190 ideas',
    );
  });

  it('adds it when there is', () => {
    expect(
      topicCountLine(page({ counts: { sources: 23, ideas: 190, known: 47, shown: 23 } })),
    ).toBe('23 sources · 190 ideas · 47 you know');
  });
});

describe('topicTerminalLine', () => {
  it('says nothing when there was nothing to end', () => {
    expect(topicTerminalLine(page())).toBe('');
  });

  it('closes a complete list without asking for anything', () => {
    const line = topicTerminalLine(page({ counts: { sources: 9, ideas: 40, known: 0, shown: 9 } }));
    expect(line).toBe('That is every source we hold on Ethics.');
    expect(line).not.toContain('Showing');
  });

  it('distinguishes a truncated one, and says how much is missing', () => {
    expect(
      topicTerminalLine(page({ counts: { sources: 57, ideas: 300, known: 0, shown: 40 } })),
    ).toBe('Showing 40 of 57.');
  });
});
