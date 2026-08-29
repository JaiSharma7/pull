import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { cachePulls, drainPending, queueMutation, readCachedPulls } from './offline.js';
import type { FeedRow } from './types.js';

const row = (id: string): FeedRow => ({
  id,
  summaryId: 's',
  ordinal: 1,
  headline: `Headline ${id}`,
  body: 'Body',
  explanation: null,
  example: null,
  whyItMatters: null,
  estimatedReadSeconds: 20,
  summaryTitle: 'Summary',
  work: { id: 'w', title: 'Work', slug: 'work', kind: 'book', year: 2020 },
  score: 0.5,
});

describe('offline cache', () => {
  it('round-trips cached pulls so a dropped connection still has something to read', async () => {
    await cachePulls([row('a'), row('b')]);
    const cached = await readCachedPulls();
    expect(cached.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('returns the most recently cached first', async () => {
    await cachePulls([row('old')]);
    await new Promise((r) => setTimeout(r, 5));
    await cachePulls([row('new')]);
    const [first] = await readCachedPulls();
    expect(first?.id).toBe('new');
  });
});

describe('pending mutation queue', () => {
  it('drains in the order the writes were made', async () => {
    // Ordering is not cosmetic here: replaying a save after a later unsave
    // would resurrect something the reader deliberately removed.
    await queueMutation('save', 'x');
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation('unsave', 'x');
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation('save', 'y');

    const applied: string[] = [];
    const drained = await drainPending(async ({ kind, pullId }) => {
      applied.push(`${kind}:${pullId}`);
    });

    expect(drained).toBe(3);
    expect(applied).toEqual(['save:x', 'unsave:x', 'save:y']);
  });

  it('blocks only the failing pull, so one bad write cannot wedge the queue', async () => {
    // 'stuck' is permanently invalid; 'other' is fine. Ordering matters within
    // a pull, not across pulls, so 'other' must still get through.
    await queueMutation('save', 'stuck');
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation('unsave', 'stuck');
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation('save', 'other');

    const applied: string[] = [];
    const drained = await drainPending(async ({ kind, pullId }) => {
      applied.push(`${kind}:${pullId}`);
      if (pullId === 'stuck') throw new Error('gone');
    });

    // The failing write is attempted, its follow-up is skipped to preserve
    // order, and the unrelated pull proceeds.
    expect(applied).toEqual(['save:stuck', 'save:other']);
    expect(drained).toBe(1);

    // Both of the stuck pull's writes are still queued, still in order.
    const retried: string[] = [];
    await drainPending(async ({ kind, pullId }) => {
      retried.push(`${kind}:${pullId}`);
    });
    expect(retried).toEqual(['save:stuck', 'unsave:stuck']);
  });
});
