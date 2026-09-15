import { describe, expect, it } from 'vitest';
import {
  PACK_STALE_AFTER_MS,
  isStale,
  mergePack,
  packLabel,
  practisingLabel,
  syncedLabel,
} from './review-pack.js';
import type { DueReview } from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-14T12:00:00Z');

function card(pullId: string, retrievability: number): DueReview {
  return {
    pullId,
    headline: `Headline ${pullId}`,
    question: `Question ${pullId}`,
    retrievability,
  } as DueReview;
}

describe('isStale', () => {
  it('is false for a copy taken today', () => {
    expect(isStale(NOW - 3 * HOUR, NOW)).toBe(false);
  });

  it('is true once the schedule has had a day to move on', () => {
    expect(isStale(NOW - PACK_STALE_AFTER_MS, NOW)).toBe(true);
    expect(isStale(NOW - 3 * DAY, NOW)).toBe(true);
  });

  it('does not treat a clock that ran backwards as ancient', () => {
    expect(isStale(NOW + HOUR, NOW)).toBe(false);
  });
});

describe('mergePack', () => {
  const pack = [card('a', 0.1), card('b', 0.4), card('c', 0.8)];

  it('keeps everything when nothing has been answered', () => {
    expect(mergePack(pack, new Set()).map((c) => c.pullId)).toEqual(['a', 'b', 'c']);
  });

  it('drops what this device already has an answer for', () => {
    expect(mergePack(pack, new Set(['b'])).map((c) => c.pullId)).toEqual(['a', 'c']);
  });

  it('keeps the pack’s own weakest-first order rather than re-sorting', () => {
    const shuffled = [card('c', 0.8), card('a', 0.1), card('b', 0.4)];
    expect(mergePack(shuffled, new Set()).map((c) => c.pullId)).toEqual(['c', 'a', 'b']);
  });

  it('can empty the pack, which is a finished session rather than an error', () => {
    expect(mergePack(pack, new Set(['a', 'b', 'c']))).toEqual([]);
  });
});

describe('syncedLabel', () => {
  it('rounds down, so a copy is never described as fresher than it is', () => {
    expect(syncedLabel(NOW - 119 * MINUTE, NOW)).toBe('1 hour ago');
    expect(syncedLabel(NOW - 61 * MINUTE, NOW)).toBe('1 hour ago');
    expect(syncedLabel(NOW - 47 * HOUR, NOW)).toBe('1 day ago');
  });

  it('says just now inside the first minute', () => {
    expect(syncedLabel(NOW, NOW)).toBe('just now');
    expect(syncedLabel(NOW - 59_000, NOW)).toBe('just now');
  });

  it('singularises one of each unit', () => {
    expect(syncedLabel(NOW - MINUTE, NOW)).toBe('1 minute ago');
    expect(syncedLabel(NOW - 2 * MINUTE, NOW)).toBe('2 minutes ago');
    expect(syncedLabel(NOW - 2 * HOUR, NOW)).toBe('2 hours ago');
    expect(syncedLabel(NOW - 2 * DAY, NOW)).toBe('2 days ago');
  });

  it('does not produce a negative age from a clock that ran backwards', () => {
    expect(syncedLabel(NOW + HOUR, NOW)).toBe('just now');
  });
});

describe('packLabel', () => {
  it('offers the download when there is nothing on the device', () => {
    expect(packLabel(0, null, NOW)).toContain('Nothing downloaded yet');
    expect(packLabel(0, NOW - HOUR, NOW)).toContain('Nothing downloaded yet');
  });

  it('counts what is ready and says how old it is', () => {
    expect(packLabel(7, NOW - 2 * HOUR, NOW)).toBe('7 ideas ready offline · synced 2 hours ago');
  });

  it('singularises one idea', () => {
    expect(packLabel(1, NOW - MINUTE, NOW)).toBe('1 idea ready offline · synced 1 minute ago');
  });

  it('says so when the copy has outlived the schedule it describes', () => {
    expect(packLabel(3, NOW - 2 * DAY, NOW)).toContain('this copy is over a day old');
    expect(packLabel(3, NOW - HOUR, NOW)).not.toContain('over a day old');
  });
});

describe('practisingLabel', () => {
  it('names the copy and its age, so the reader knows what they are answering', () => {
    expect(practisingLabel(NOW - 2 * HOUR, NOW)).toBe(
      'Practising from your downloaded copy · last synced 2 hours ago',
    );
  });
});
