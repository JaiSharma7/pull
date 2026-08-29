import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { cachePulls, drainPending, queueMutation, readCachedPulls } from './offline.js';
import type { FeedRow } from './types.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

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
    await queueMutation(USER_A, 'save', 'x');
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, 'unsave', 'x');
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, 'save', 'y');

    const applied: string[] = [];
    const drained = await drainPending(USER_A, async ({ kind, pullId }) => {
      applied.push(`${kind}:${pullId}`);
    });

    expect(drained).toBe(3);
    expect(applied).toEqual(['save:x', 'unsave:x', 'save:y']);
  });

  it('blocks only the failing pull, so one bad write cannot wedge the queue', async () => {
    // 'stuck' is permanently invalid; 'other' is fine. Ordering matters within
    // a pull, not across pulls, so 'other' must still get through.
    await queueMutation(USER_A, 'save', 'stuck');
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, 'unsave', 'stuck');
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, 'save', 'other');

    const applied: string[] = [];
    const drained = await drainPending(USER_A, async ({ kind, pullId }) => {
      applied.push(`${kind}:${pullId}`);
      if (pullId === 'stuck') throw new Error('gone');
    });

    // The failing write is attempted, its follow-up is skipped to preserve
    // order, and the unrelated pull proceeds.
    expect(applied).toEqual(['save:stuck', 'save:other']);
    expect(drained).toBe(1);

    // Both of the stuck pull's writes are still queued, still in order.
    const retried: string[] = [];
    await drainPending(USER_A, async ({ kind, pullId }) => {
      retried.push(`${kind}:${pullId}`);
    });
    expect(retried).toEqual(['save:stuck', 'unsave:stuck']);
  });
});

describe('account scoping', () => {
  it('never drains writes queued by another account', async () => {
    // Pending writes survive sign-out. On a shared browser, replaying A's saves
    // and reads into B's session would contaminate B's history, knowledge model
    // and library with someone else's reading.
    await queueMutation(USER_A, 'save', 'a-only');
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_B, 'save', 'b-only');

    const asB: string[] = [];
    await drainPending(USER_B, async ({ pullId }) => {
      asB.push(pullId);
    });
    expect(asB).toEqual(['b-only']);

    // A's write is untouched and still theirs to drain.
    const asA: string[] = [];
    await drainPending(USER_A, async ({ pullId }) => {
      asA.push(pullId);
    });
    expect(asA).toEqual(['a-only']);
  });
});

describe('drain single-flight', () => {
  it('shares an in-flight drain within an account but not across accounts', async () => {
    await queueMutation(USER_A, 'save', 'a-1');
    await queueMutation(USER_B, 'save', 'b-1');

    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    // Two concurrent drains for A must share one pass; B's must run its own,
    // otherwise B would await A's work — which filters to A's entries — and
    // then never retry its own.
    const a1 = drainPending(USER_A, async ({ pullId }) => {
      seen.push(pullId);
      await gate;
    });
    const a2 = drainPending(USER_A, async ({ pullId }) => {
      seen.push(`dup:${pullId}`);
    });
    const b1 = drainPending(USER_B, async ({ pullId }) => {
      seen.push(pullId);
    });

    release();
    await Promise.all([a1, a2, b1]);

    expect(seen).toContain('a-1');
    expect(seen).toContain('b-1');
    // A's second call reused the first rather than replaying the write.
    expect(seen).not.toContain('dup:a-1');
  });
});
