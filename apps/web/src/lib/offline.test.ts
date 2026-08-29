import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  cachePulls,
  drainPending,
  dropSupersededConvictions,
  hasPending,
  onPendingQueued,
  queueMutation,
  readCachedPulls,
  type PendingWrite,
} from './offline.js';
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
    await queueMutation(USER_A, { kind: 'save', pullId: 'x' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, { kind: 'unsave', pullId: 'x' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, { kind: 'save', pullId: 'y' });

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
    await queueMutation(USER_A, { kind: 'save', pullId: 'stuck' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, { kind: 'unsave', pullId: 'stuck' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, { kind: 'save', pullId: 'other' });

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

describe('queued learning writes', () => {
  it('carries an explanation’s text and mutation id through the queue', async () => {
    // An explanation is several sentences the reader composed. Unlike an
    // impression — which regenerates the moment they scroll past the card again
    // — it exists nowhere else, so the payload has to survive the round trip.
    // The mutation id travels with it so the replay collides with the write it
    // is replaying rather than writing the paragraph twice.
    const text = 'Stoicism separates what I control from what I merely react to.';
    const mutationId = '6f1f4a2c-0b3d-4c5e-8a7b-9d0e1f2a3b4c';
    await queueMutation(USER_A, { kind: 'explain', pullId: 'p1', text, mutationId });

    const applied: PendingWrite[] = [];
    const drained = await drainPending(USER_A, async (m) => {
      applied.push(m);
    });

    expect(drained).toBe(1);
    expect(applied).toEqual([{ kind: 'explain', pullId: 'p1', text, mutationId }]);
  });

  it('carries a stance and its mutation id through the queue', async () => {
    const mutationId = 'b2c3d4e5-1a2b-4c3d-9e8f-7a6b5c4d3e2f';
    await queueMutation(USER_A, {
      kind: 'conviction',
      pullId: 'p2',
      stance: 'disagree',
      mutationId,
      submittedAt: 1_700_000_000_000,
    });

    const applied: PendingWrite[] = [];
    await drainPending(USER_A, async (m) => {
      applied.push(m);
    });

    expect(applied).toEqual([
      {
        kind: 'conviction',
        pullId: 'p2',
        stance: 'disagree',
        mutationId,
        submittedAt: 1_700_000_000_000,
      },
    ]);
  });

  it('drops a stale queued stance once a newer one lands', async () => {
    // A conviction that genuinely failed was never recorded, so nothing
    // server-side can tell it is stale. Replaying it after the reader decided
    // otherwise would overwrite the newer decision with the older one.
    await queueMutation(USER_A, {
      kind: 'conviction',
      pullId: 'p9',
      stance: 'agree',
      mutationId: 'stale',
      submittedAt: 1_000,
    });
    // An unrelated write for the same pull must survive — only a superseded
    // stance is dropped.
    await queueMutation(USER_A, { kind: 'read', pullId: 'p9' });
    // And another pull's stance is none of this one's business.
    await queueMutation(USER_A, {
      kind: 'conviction',
      pullId: 'p10',
      stance: 'unsure',
      mutationId: 'other-pull',
      submittedAt: 1_000,
    });

    await dropSupersededConvictions(USER_A, 'p9', 2_000);

    const applied: PendingWrite[] = [];
    await drainPending(USER_A, async (m) => {
      applied.push(m);
    });

    expect(applied).toEqual([
      { kind: 'read', pullId: 'p9' },
      {
        kind: 'conviction',
        pullId: 'p10',
        stance: 'unsure',
        mutationId: 'other-pull',
        submittedAt: 1_000,
      },
    ]);
  });

  it('keeps a queued stance the reader submitted after the one that landed', async () => {
    // A slow request can succeed *after* a later stance has already failed and
    // queued. Treating everything queued as stale would then discard the
    // reader's newer intent and make the older stance permanent — so the cutoff
    // is when each was submitted, not that it happens to be sitting in the queue.
    const newer: PendingWrite = {
      kind: 'conviction',
      pullId: 'p11',
      stance: 'disagree',
      mutationId: 'newer',
      submittedAt: 5_000,
    };
    await queueMutation(USER_A, newer);

    // The older submission (3_000) finally lands and tries to clear the queue.
    await dropSupersededConvictions(USER_A, 'p11', 3_000);

    const applied: PendingWrite[] = [];
    await drainPending(USER_A, async (m) => {
      applied.push(m);
    });

    expect(applied).toEqual([newer]);
  });

  it('carries no payload for the writes that have none', async () => {
    // The drain callback sees the write, not the row: `id`, `userId` and `at`
    // are this queue's bookkeeping and have no business in a replayed write.
    await queueMutation(USER_A, { kind: 'read', pullId: 'p3' });

    const applied: PendingWrite[] = [];
    await drainPending(USER_A, async (m) => {
      applied.push(m);
    });

    expect(applied).toEqual([{ kind: 'read', pullId: 'p3' }]);
  });
});

describe('retry scheduling', () => {
  it('announces a queued write so a retry can be scheduled without an online event', async () => {
    // A 500 or a timeout queues a write while navigator.onLine stays true, so
    // no `online` event ever fires. Without this notification the entry would
    // wait for a reload.
    let announced = 0;
    const off = onPendingQueued(() => {
      announced += 1;
    });

    await queueMutation(USER_A, { kind: 'read', pullId: 'p4' });
    expect(announced).toBe(1);
    expect(await hasPending(USER_A)).toBe(true);

    off();
    await queueMutation(USER_A, { kind: 'read', pullId: 'p5' });
    expect(announced).toBe(1); // unsubscribed

    await drainPending(USER_A, async () => undefined);
    expect(await hasPending(USER_A)).toBe(false);
  });

  it('reports pending state per account', async () => {
    await queueMutation(USER_B, { kind: 'read', pullId: 'b-pending' });

    expect(await hasPending(USER_B)).toBe(true);
    expect(await hasPending(USER_A)).toBe(false);

    await drainPending(USER_B, async () => undefined);
    expect(await hasPending(USER_B)).toBe(false);
  });
});

describe('account scoping', () => {
  it('never drains writes queued by another account', async () => {
    // Pending writes survive sign-out. On a shared browser, replaying A's saves
    // and reads into B's session would contaminate B's history, knowledge model
    // and library with someone else's reading.
    await queueMutation(USER_A, { kind: 'save', pullId: 'a-only' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_B, { kind: 'save', pullId: 'b-only' });

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
    await queueMutation(USER_A, { kind: 'save', pullId: 'a-1' });
    await queueMutation(USER_B, { kind: 'save', pullId: 'b-1' });

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

describe('identity revalidation', () => {
  it('stops mid-drain when the account changes, leaving the rest queued', async () => {
    await queueMutation(USER_A, { kind: 'read', pullId: 'first' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, { kind: 'read', pullId: 'second' });

    let signedIn = USER_A;
    const applied: string[] = [];

    await drainPending(
      USER_A,
      async ({ pullId }) => {
        applied.push(pullId);
        signedIn = USER_B; // sign-out lands while the first write is in flight
      },
      () => signedIn === USER_A,
    );

    // Only the write that started while A was signed in is applied.
    expect(applied).toEqual(['first']);

    // The remainder is still A's, untouched, and replays when A returns.
    signedIn = USER_A;
    const later: string[] = [];
    await drainPending(USER_A, async ({ pullId }) => {
      later.push(pullId);
    });
    expect(later).toEqual(['second']);
  });
});
