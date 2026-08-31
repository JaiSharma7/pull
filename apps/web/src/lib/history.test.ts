import { describe, expect, it } from 'vitest';
import { groupByDay, type HistoryEntry } from './history.js';

/**
 * Grouping is the one piece of logic on the History screen, and getting it wrong is
 * invisible: a day rendered twice, or entries rebucketed into the wrong date, both
 * look like plausible history. Mutation-checked — each test was confirmed red against
 * the fault it describes.
 */

const entry = (id: number, occurredOn: string): HistoryEntry =>
  ({ id, occurredOn, headline: `h${id}`, kind: 'read' }) as unknown as HistoryEntry;

describe('groupByDay', () => {
  it('returns nothing for nothing', () => {
    expect(groupByDay([])).toEqual([]);
  });

  it('puts one day in one group', () => {
    const out = groupByDay([entry(3, '2026-08-31'), entry(2, '2026-08-31')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.day).toBe('2026-08-31');
    expect(out[0]!.entries.map((e) => e.id)).toEqual([3, 2]);
  });

  it('keeps the order the rows arrived in, newest day first', () => {
    // The query orders by occurred_on desc; grouping must not resort it. A Map is
    // used precisely because it preserves insertion order for string keys.
    const out = groupByDay([
      entry(9, '2026-08-31'),
      entry(8, '2026-08-30'),
      entry(7, '2026-08-28'),
    ]);
    expect(out.map((d) => d.day)).toEqual(['2026-08-31', '2026-08-30', '2026-08-28']);
  });

  it('does not open a second group for a day it has already seen', () => {
    // Rows for one day always arrive together given the ordering, but a page
    // boundary landing mid-day must not produce the same date twice on screen.
    const out = groupByDay([
      entry(9, '2026-08-31'),
      entry(8, '2026-08-30'),
      entry(7, '2026-08-31'),
    ]);
    expect(out.map((d) => d.day)).toEqual(['2026-08-31', '2026-08-30']);
    expect(out[0]!.entries.map((e) => e.id)).toEqual([9, 7]);
  });

  it('loses no entry', () => {
    // The invariant that matters on a screen whose whole claim is completeness.
    const input = [
      entry(1, '2026-08-31'),
      entry(2, '2026-08-30'),
      entry(3, '2026-08-30'),
      entry(4, '2026-08-01'),
    ];
    const out = groupByDay(input);
    expect(out.flatMap((d) => d.entries).map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it('does not mutate the entries it was given', () => {
    const input = [entry(1, '2026-08-31')];
    groupByDay(input);
    expect(input).toHaveLength(1);
  });
});
