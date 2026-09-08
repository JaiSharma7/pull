import { describe, expect, it } from 'vitest';
import {
  dedupeConfidentlyWrong,
  formatAttemptDate,
  parseConfidentlyWrongRows,
  type ConfidentlyWrongItem,
} from './confidently-wrong.js';

describe('confidently-wrong', () => {
  describe('parseConfidentlyWrongRows', () => {
    it('returns empty array for invalid inputs', () => {
      expect(parseConfidentlyWrongRows([])).toEqual([]);
      expect(parseConfidentlyWrongRows(null as unknown as unknown[])).toEqual([]);
      expect(parseConfidentlyWrongRows([null, undefined, 123])).toEqual([]);
    });

    it('parses valid raw rows with nested objects', () => {
      const rows = [
        {
          id: 'ev-1',
          pull_id: 'pull-1',
          applied_at: '2026-09-08T00:00:00.000Z',
          pulls: {
            id: 'pull-1',
            headline: 'Some things are up to us and some things are not.',
            summaries: {
              works: {
                id: 'work-1',
                title: 'The Enchiridion',
                slug: 'the-enchiridion',
              },
            },
          },
        },
      ];

      const result = parseConfidentlyWrongRows(rows);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'ev-1',
        pullId: 'pull-1',
        appliedAt: '2026-09-08T00:00:00.000Z',
        headline: 'Some things are up to us and some things are not.',
        workTitle: 'The Enchiridion',
        workSlug: 'the-enchiridion',
      });
    });

    it('handles nested arrays from PostgREST joins', () => {
      const rows = [
        {
          id: 'ev-2',
          pull_id: 'pull-2',
          applied_at: '2026-09-07T12:00:00.000Z',
          pulls: [
            {
              id: 'pull-2',
              headline: 'Waste no more time arguing what a good man should be. Be one.',
              summaries: [
                {
                  works: [
                    {
                      id: 'work-2',
                      title: 'Meditations',
                      slug: 'meditations',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];

      const result = parseConfidentlyWrongRows(rows);
      expect(result).toHaveLength(1);
      expect(result[0]!.workTitle).toBe('Meditations');
      expect(result[0]!.workSlug).toBe('meditations');
    });

    it('falls back gracefully when headline or title is missing', () => {
      const rows = [
        {
          id: 'ev-3',
          pull_id: 'pull-3',
          applied_at: '2026-09-06T00:00:00.000Z',
          pulls: null,
        },
      ];

      const result = parseConfidentlyWrongRows(rows);
      expect(result).toHaveLength(1);
      expect(result[0]!.headline).toBe('Untitled idea');
      expect(result[0]!.workTitle).toBe('Unknown source');
      expect(result[0]!.workSlug).toBeNull();
    });
  });

  describe('dedupeConfidentlyWrong', () => {
    it('deduplicates by pullId preserving the first (latest) occurrence', () => {
      const items: ConfidentlyWrongItem[] = [
        {
          id: 'ev-1',
          pullId: 'pull-A',
          appliedAt: '2026-09-08T00:00:00.000Z',
          headline: 'A headline newer',
          workTitle: 'Work A',
          workSlug: 'work-a',
        },
        {
          id: 'ev-2',
          pullId: 'pull-B',
          appliedAt: '2026-09-07T00:00:00.000Z',
          headline: 'B headline',
          workTitle: 'Work B',
          workSlug: 'work-b',
        },
        {
          id: 'ev-3',
          pullId: 'pull-A',
          appliedAt: '2026-09-05T00:00:00.000Z',
          headline: 'A headline older',
          workTitle: 'Work A',
          workSlug: 'work-a',
        },
      ];

      const deduped = dedupeConfidentlyWrong(items);
      expect(deduped).toHaveLength(2);
      expect(deduped[0]!.id).toBe('ev-1');
      expect(deduped[0]!.pullId).toBe('pull-A');
      expect(deduped[1]!.id).toBe('ev-2');
      expect(deduped[1]!.pullId).toBe('pull-B');
    });
  });

  describe('formatAttemptDate', () => {
    it('formats relative differences correctly', () => {
      const base = new Date('2026-09-08T12:00:00.000Z');

      expect(formatAttemptDate('2026-09-08T11:45:00.000Z', base)).toBe('Just now');
      expect(formatAttemptDate('2026-09-08T09:00:00.000Z', base)).toBe('3h ago');
      expect(formatAttemptDate('2026-09-07T10:00:00.000Z', base)).toBe('Yesterday');
      expect(formatAttemptDate('2026-09-05T12:00:00.000Z', base)).toBe('3d ago');
    });
  });
});
