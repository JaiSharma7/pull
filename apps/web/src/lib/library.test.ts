import { describe, expect, it } from 'vitest';
import { groupByWork } from './library.js';
import type { LibraryItem } from './types.js';

/**
 * Grouping the library, and the orphan case that broke it.
 *
 * `fetchLibrary` substitutes `{ id: '', title: 'Unknown source' }` when a Pull's work
 * has been deleted. Grouping keyed on `work.id || work.title`, so every orphan
 * produced the same key — the literal string "Unknown source" — which the Library
 * then handed to `get_source_delta(p_work_id uuid)`. Postgres raised 22P02 and the
 * caller swallowed it.
 *
 * Both halves are asserted here: that orphans do not collide, and that `workId` stays
 * empty so a caller can tell there is nothing to ask for.
 */

const item = (id: string, workId: string, workTitle: string): LibraryItem => ({
  id,
  headline: `headline ${id}`,
  body: `body ${id}`,
  whyItMatters: null,
  explanation: null,
  example: null,
  savedAt: '2026-08-30T00:00:00Z',
  work: { id: workId, title: workTitle, kind: 'book' },
  saveId: `save-${id}`,
  stashId: null,
  note: null,
  archived: false,
  readLater: false,
});

describe('groupByWork', () => {
  it('returns nothing for an empty library', () => {
    expect(groupByWork([])).toEqual([]);
  });

  it('gathers Pulls from one source into one group', () => {
    const groups = groupByWork([
      item('p1', 'w1', 'On Liberty'),
      item('p2', 'w1', 'On Liberty'),
      item('p3', 'w2', 'Walden'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['p1', 'p2']);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['p3']);
  });

  it('carries the real work id, so it can reach a uuid parameter', () => {
    const [group] = groupByWork([item('p1', 'w1', 'On Liberty')]);
    expect(group?.workId).toBe('w1');
    expect(group?.key).toBe('w1');
  });

  it('preserves the order sources first appear in', () => {
    // The rows arrive ordered by `created_at desc`, so the group order is
    // most-recently-saved first. Re-sorting would silently discard that.
    const groups = groupByWork([
      item('p1', 'w2', 'Walden'),
      item('p2', 'w1', 'On Liberty'),
      item('p3', 'w2', 'Walden'),
    ]);
    expect(groups.map((g) => g.title)).toEqual(['Walden', 'On Liberty']);
  });

  describe('a Pull whose source has been deleted', () => {
    it('leaves workId empty rather than inventing one', () => {
      const [group] = groupByWork([item('p1', '', 'Unknown source')]);
      // The caller tests this before spending a request. An empty string is the
      // signal; anything truthy here would be sent to Postgres as a uuid.
      expect(group?.workId).toBe('');
    });

    it('never lets an orphan key be mistaken for a work id', () => {
      const [group] = groupByWork([item('p1', '', 'Unknown source')]);
      expect(group?.key).not.toBe('Unknown source');
      expect(group?.key).toContain('p1');
    });

    it('keeps two orphans apart instead of merging them', () => {
      // This is the regression that mattered: both had key "Unknown source", so two
      // Pulls from two different deleted works collapsed into one group.
      const groups = groupByWork([
        item('p1', '', 'Unknown source'),
        item('p2', '', 'Unknown source'),
      ]);

      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.items.length)).toEqual([1, 1]);
    });

    it('does not merge an orphan into a real source that shares its title', () => {
      const groups = groupByWork([item('p1', 'w1', 'Walden'), item('p2', '', 'Walden')]);
      expect(groups).toHaveLength(2);
      expect(groups[0]?.workId).toBe('w1');
      expect(groups[1]?.workId).toBe('');
    });
  });
});
