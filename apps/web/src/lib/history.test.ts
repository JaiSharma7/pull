import { describe, expect, it } from 'vitest';
import { cursorFrom, formatHistoryDay, groupByDay, type HistoryEntry } from './history.js';

/**
 * Grouping is the one piece of logic on the History screen, and getting it wrong is
 * invisible: a day rendered twice, or entries rebucketed into the wrong date, both
 * look like plausible history. Mutation-checked — each test was confirmed red against
 * the fault it describes.
 */

const entry = (id: number, occurredOn: string): HistoryEntry =>
  ({
    id,
    occurredOn,
    createdAt: `${occurredOn}T12:00:00+00:00`,
    headline: `h${id}`,
    kind: 'read',
  }) as unknown as HistoryEntry;

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

describe('formatHistoryDay', () => {
  // A reader in UTC+10, just after their local midnight. Their local date is the 31st
  // while UTC is still the 30th — the case that made the first version wrong.
  const justAfterLocalMidnightInUtcPlus10 = new Date('2026-08-30T14:05:00Z');

  it('calls the current UTC day Today, whatever the reader local date is', () => {
    // The bug Codex found: compared against *local* midnight, a row filed under the
    // current UTC day was labelled "Yesterday" for every reader ahead of UTC.
    expect(formatHistoryDay('2026-08-30', justAfterLocalMidnightInUtcPlus10)).toBe('Today');
  });

  it('calls the previous UTC day Yesterday', () => {
    expect(formatHistoryDay('2026-08-29', justAfterLocalMidnightInUtcPlus10)).toBe('Yesterday');
  });

  it('does not call a future-looking local date Today', () => {
    // 2026-08-31 is the reader's local date here, but no row is filed under it yet.
    expect(formatHistoryDay('2026-08-31', justAfterLocalMidnightInUtcPlus10)).not.toBe('Today');
  });

  it('writes out an older day rather than labelling it', () => {
    const out = formatHistoryDay('2026-08-01', new Date('2026-08-31T12:00:00Z'));
    expect(out).toContain('1');
    expect(out).not.toMatch(/Today|Yesterday/);
  });

  it('names the day the row is filed under, not the local one', () => {
    // Rendered with timeZone UTC, so a date never slips by one for a western reader.
    expect(formatHistoryDay('2026-08-01', new Date('2026-08-31T12:00:00Z'))).toContain('August');
  });

  it('returns an unparseable day unchanged rather than inventing one', () => {
    expect(formatHistoryDay('not-a-date', new Date('2026-08-31T12:00:00Z'))).toBe('not-a-date');
  });
});

describe('cursorFrom', () => {
  it('is null for an empty page, so paging cannot resume from nowhere', () => {
    expect(cursorFrom([])).toBeNull();
  });

  it('takes the last entry, which is where the next page begins', () => {
    const out = cursorFrom([entry(9, '2026-08-31'), entry(4, '2026-08-30')]);
    expect(out).toMatchObject({ id: 4, occurredOn: '2026-08-30' });
  });

  it('carries all three ordering columns', () => {
    // Fewer than three cannot express the sort, and a cursor that compares on
    // different columns than the ORDER BY is an intermittent wrong answer.
    expect(Object.keys(cursorFrom([entry(1, '2026-08-31')])!).sort()).toEqual([
      'createdAt',
      'id',
      'occurredOn',
    ]);
  });
});
