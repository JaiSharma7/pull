import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  cachePulls,
  drainPending,
  hasPending,
  isOfflineFailure,
  onPendingQueued,
  pendingRecallPullIds,
  queueIfOffline,
  queueMutation,
  readCachedPulls,
  writeScope,
  type PendingWrite,
} from './offline.js';
/* The module's own shape, for the re-imported instance the broken-store cases use. */
import type * as OfflineModule from './offline.js';
import { TRANSPORT_ERROR } from './rpc-error.js';
import type { FeedRow } from './types.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

/**
 * The pull a queued write names, for the kinds that name one.
 *
 * Not every kind does any more: an organising patch names a `saved_items` row
 * and a collection write names a `stashes` row. The narrowing is what keeps
 * these assertions about the writes they were written for.
 */
const pullOf = (m: PendingWrite): string => ('pullId' in m ? m.pullId : `not-a-pull:${m.kind}`);

/**
 * Run something with `navigator.onLine` pinned.
 *
 * Node has a `navigator` with no `onLine` at all, so leaving it alone means
 * testing the branch that only fires under `undefined` — and every assertion
 * about "the server refused this" would pass for the wrong reason the day the
 * runtime grows the property. Pinned, and restored, at module scope because both
 * `isOfflineFailure` and `queueIfOffline` turn on it.
 */
const withOnline = <T>(value: boolean | undefined, run: () => T): T => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: value === undefined ? undefined : { onLine: value },
    configurable: true,
  });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
};

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
    const drained = await drainPending(USER_A, async (m) => {
      applied.push(`${m.kind}:${pullOf(m)}`);
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
    const drained = await drainPending(USER_A, async (m) => {
      applied.push(`${m.kind}:${pullOf(m)}`);
      if (pullOf(m) === 'stuck') throw new Error('gone');
    });

    // The failing write is attempted, its follow-up is skipped to preserve
    // order, and the unrelated pull proceeds.
    expect(applied).toEqual(['save:stuck', 'save:other']);
    expect(drained).toBe(1);

    // Both of the stuck pull's writes are still queued, still in order.
    const retried: string[] = [];
    await drainPending(USER_A, async (m) => {
      retried.push(`${m.kind}:${pullOf(m)}`);
    });
    expect(retried).toEqual(['save:stuck', 'unsave:stuck']);
  });
});

describe('a write the server refused for good', () => {
  const permanently = () => {
    // The shape `rpcError` produces for a foreign-key violation: the pull this
    // save points at no longer exists.
    const e = new Error('insert or update on table "saved_items" violates foreign key constraint');
    e.name = 'PostgrestError 23503';
    return e;
  };

  it('is dropped rather than kept, so the queue can empty', async () => {
    await queueMutation(USER_A, { kind: 'save', pullId: 'gone' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, { kind: 'save', pullId: 'fine' });

    const drained = await drainPending(USER_A, async (m) => {
      if (pullOf(m) === 'gone') throw permanently();
    });
    expect(drained).toBe(1);

    // Nothing left: the refused write is gone, not waiting for a retry that
    // would fail the same way every five minutes for the life of the tab.
    const retried: string[] = [];
    await drainPending(USER_A, async (m) => {
      retried.push(`${m.kind}:${pullOf(m)}`);
    });
    expect(retried).toEqual([]);
  });

  it('does not block the subject, so its later writes are judged on their own', async () => {
    await queueMutation(USER_A, { kind: 'save', pullId: 'gone' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, { kind: 'unsave', pullId: 'gone' });

    const attempted: string[] = [];
    await drainPending(USER_A, async (m) => {
      attempted.push(`${m.kind}:${pullOf(m)}`);
      throw permanently();
    });
    // Both were tried and both dropped -- a save-then-unsave of a pull that no
    // longer exists has nothing left to say.
    expect(attempted).toEqual(['save:gone', 'unsave:gone']);
    expect(await hasPending(USER_A)).toBe(false);
  });

  it('keeps a write the server merely failed to handle', async () => {
    await queueMutation(USER_A, { kind: 'save', pullId: 'p1' });
    const e = new Error('canceling statement due to statement timeout');
    e.name = 'PostgrestError 57014'; // transient: the server was unwell, not the write
    await drainPending(USER_A, async () => {
      throw e;
    });
    expect(await hasPending(USER_A)).toBe(true);
    // Leave the queue as it was found: the tests share one IndexedDB.
    await drainPending(USER_A, async () => undefined);
  });

  it('keeps a write RLS refused, because the refusal may be about the session', async () => {
    // A failed token refresh sends the request as `anon`, and RLS says 42501 to
    // that exactly as it would to an account that may never write here. A queue
    // built offline and drained in the minute the refresh is failing would be
    // emptied for good; instead every entry waits for the session to come back.
    await queueMutation(USER_A, { kind: 'save', pullId: 'p1' });
    const denied = new Error('new row violates row-level security policy for table "saved_items"');
    denied.name = 'PostgrestError 42501';
    await drainPending(USER_A, async () => {
      throw denied;
    });
    expect(await hasPending(USER_A)).toBe(true);
    await drainPending(USER_A, async () => undefined);
  });

  it('keeps a collection write whose target is a collection still in the queue', async () => {
    // Offline, the reader creates "Stoics", then "Marcus" inside it, then moves a
    // save in. The parent fails transiently on the first pass; only its scope is
    // blocked, so the child and the move are attempted and refused on the
    // foreign key. That refusal is the parent's absence, not theirs.
    await queueMutation(USER_A, {
      kind: 'stash-create',
      stashId: 'parent',
      name: 'Stoics',
      parentId: null,
    });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, {
      kind: 'stash-create',
      stashId: 'child',
      name: 'Marcus',
      parentId: 'parent',
    });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, { kind: 'organise', saveId: 'sv', patch: { stashId: 'parent' } });

    const fk = new Error('insert or update on table "stashes" violates foreign key constraint');
    fk.name = 'PostgrestError 23503';
    const unwell = new Error('canceling statement due to statement timeout');
    unwell.name = 'PostgrestError 57014';

    await drainPending(USER_A, async (m) => {
      if (m.kind === 'stash-create' && m.stashId === 'parent') throw unwell;
      throw fk;
    });
    expect(await hasPending(USER_A)).toBe(true);

    // The next pass lands the parent, and the writes that depend on it follow.
    const landed: string[] = [];
    await drainPending(USER_A, async (m) => {
      landed.push(
        m.kind === 'organise'
          ? `organise:${m.saveId}`
          : `${m.kind}:${'stashId' in m ? m.stashId : ''}`,
      );
    });
    expect(landed).toEqual(['stash-create:parent', 'stash-create:child', 'organise:sv']);
    expect(await hasPending(USER_A)).toBe(false);
  });

  it('drops a collection write whose target is nowhere', async () => {
    // Nothing queued creates "gone", and the server does not have it either: the
    // move can never land, and keeping it would hold the timer alive forever.
    await queueMutation(USER_A, { kind: 'organise', saveId: 'sv2', patch: { stashId: 'gone' } });
    const fk = new Error('insert or update on table "saved_items" violates foreign key constraint');
    fk.name = 'PostgrestError 23503';
    await drainPending(USER_A, async () => {
      throw fk;
    });
    expect(await hasPending(USER_A)).toBe(false);
  });

  it('defers dropping while an earlier write in the pass was held back', async () => {
    // Two subjects. The first fails transiently and is blocked; the second is
    // refused for good. It is not dropped in this pass -- it might depend on the
    // first -- and is dropped in the next, where nothing is held back.
    await queueMutation(USER_A, { kind: 'save', pullId: 'slow' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(USER_A, { kind: 'save', pullId: 'gone' });
    const unwell = new Error('canceling statement due to statement timeout');
    unwell.name = 'PostgrestError 57014';

    await drainPending(USER_A, async (m) => {
      if (pullOf(m) === 'slow') throw unwell;
      throw permanently();
    });
    const remaining: string[] = [];
    await drainPending(USER_A, async (m) => {
      remaining.push(pullOf(m) ?? '');
      if (pullOf(m) === 'gone') throw permanently();
    });
    expect(remaining).toEqual(['slow', 'gone']);
    expect(await hasPending(USER_A)).toBe(false);
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

  it('replays a stance with the submission time the reader made it at', async () => {
    // Whether a queued stance still counts is not decided here — the queue
    // cannot see a request that has not failed yet, which is why three rounds
    // of trying to decide it client-side kept leaving a window open. The server
    // declines a submission older than the stance on record, so all this has to
    // do is carry the original submission time rather than the replay's.
    const submittedAt = 1_000;
    await queueMutation(USER_A, {
      kind: 'conviction',
      pullId: 'p9',
      stance: 'agree',
      mutationId: 'queued-before-a-newer-one',
      submittedAt,
    });

    const applied: PendingWrite[] = [];
    await drainPending(USER_A, async (m) => {
      applied.push(m);
    });

    expect(applied).toEqual([
      {
        kind: 'conviction',
        pullId: 'p9',
        stance: 'agree',
        mutationId: 'queued-before-a-newer-one',
        submittedAt,
      },
    ]);
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

/**
 * Organising a library with no connection.
 *
 * Law 3 promises unlimited stashing. Before these kinds existed, moving a save
 * between collections on a train updated the screen optimistically, dropped the
 * PATCH, and then asked the same dead connection for the whole library — so the
 * reader watched their change disappear and their shelf turn into an error page
 * at once.
 */
describe('queued library writes', () => {
  it('carries an organising patch and the save it belongs to', async () => {
    // The patch is the payload: which columns the reader touched and what they
    // set them to. An entry that survives without it replays as nothing.
    const patch = { stashId: 'st-1', note: 'Worth arguing with', archived: false };
    await queueMutation(USER_A, { kind: 'organise', saveId: 'sv-1', patch });

    const applied: PendingWrite[] = [];
    const drained = await drainPending(USER_A, async (m) => {
      applied.push(m);
    });

    expect(drained).toBe(1);
    expect(applied).toEqual([{ kind: 'organise', saveId: 'sv-1', patch }]);
  });

  it('carries a collection’s client-minted id, name and parent', async () => {
    // The id is minted before the first attempt, which is the whole reason a
    // create is replayable: the retry collides on the primary key instead of
    // making a second folder with the same name.
    await queueMutation(USER_A, {
      kind: 'stash-create',
      stashId: 'st-9',
      name: 'Field notes',
      parentId: 'st-1',
    });

    const applied: PendingWrite[] = [];
    await drainPending(USER_A, async (m) => {
      applied.push(m);
    });

    expect(applied).toEqual([
      { kind: 'stash-create', stashId: 'st-9', name: 'Field notes', parentId: 'st-1' },
    ]);
  });

  it('holds a collection delete behind the create it followed, and lets other subjects past', async () => {
    /*
     * The one ordering in this feature that is not merely untidy to get wrong.
     *
     * A create replayed after its own delete brings back a collection the reader
     * threw away — the delete finds no row, shrugs, and the create then lands.
     * Both writes name the same `stashes.id`, so they share a scope and a stuck
     * create holds the delete behind it. An unrelated saved item is a different
     * subject and must not be held up by either.
     */
    const user = 'user-scopes';
    await queueMutation(user, {
      kind: 'stash-create',
      stashId: 'st',
      name: 'Field notes',
      parentId: null,
    });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(user, { kind: 'stash-delete', stashId: 'st' });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(user, { kind: 'organise', saveId: 'sv', patch: { archived: true } });

    const attempted: string[] = [];
    const drained = await drainPending(user, async (m) => {
      attempted.push(writeScope(m));
      // The parent row is not there yet — the create's first realistic failure.
      if (m.kind === 'stash-create') throw new Error('foreign key violation');
    });

    expect(attempted).toEqual(['stash:st', 'save:sv']);
    expect(drained).toBe(1);

    // Neither collection write was lost, and they still replay in order.
    const retried: string[] = [];
    await drainPending(user, async (m) => {
      retried.push(m.kind);
    });
    expect(retried).toEqual(['stash-create', 'stash-delete']);
  });

  it('keeps a pull, a saved item and a collection in separate scopes when their ids collide', () => {
    // All three are uuids from different tables. Unprefixed, one table's id
    // would silently share a blocking scope with another's the first time the
    // strings matched, coupling two writes that have nothing to do with
    // each other.
    const id = 'the-same-uuid';
    const scopes = new Set([
      writeScope({ kind: 'save', pullId: id }),
      writeScope({ kind: 'organise', saveId: id, patch: { archived: true } }),
      writeScope({ kind: 'stash-delete', stashId: id }),
    ]);
    expect(scopes.size).toBe(3);
  });

  it('gives a kind it does not know a scope of its own', () => {
    // Same version-skew case as `replayWrite`'s. Without a scope it would be
    // `undefined`, which every other unknown entry would then share — one stuck
    // leftover blocking another that has nothing to do with it.
    const scope = writeScope({ kind: 'from-a-later-version' } as unknown as PendingWrite);
    expect(scope).toBe('unknown:from-a-later-version');
  });

  it('keeps two patches to one saved item in the order the reader made them', async () => {
    // Last-write-wins on a column, so order is the only thing that decides where
    // the save ends up. Same subject, so one scope, so oldest first.
    const user = 'user-two-patches';
    await queueMutation(user, { kind: 'organise', saveId: 'sv', patch: { archived: true } });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation(user, { kind: 'organise', saveId: 'sv', patch: { archived: false } });

    const applied: boolean[] = [];
    await drainPending(user, async (m) => {
      if (m.kind === 'organise' && m.patch.archived !== undefined) applied.push(m.patch.archived);
    });
    expect(applied).toEqual([true, false]);
  });
});

/**
 * Which failures are worth keeping, and which are worth saying out loud.
 *
 * The distinction is the whole finding: queueing on *every* error would swallow a
 * 500 and an RLS refusal into a queue that retries them forever, and reloading on
 * every error turns a dropped connection into a dead end.
 */
describe('queueIfOffline', () => {
  it('keeps a write whose request never reached the server, and says it did', async () => {
    const user = 'user-kept';
    const transport = new Error('TypeError: Failed to fetch');
    transport.name = TRANSPORT_ERROR;
    const write: PendingWrite = { kind: 'organise', saveId: 'sv', patch: { readLater: true } };

    const kept = await withOnline(true, () => queueIfOffline(user, transport, write));
    expect(kept).toBe(true);

    const applied: PendingWrite[] = [];
    await drainPending(user, async (m) => {
      applied.push(m);
    });
    expect(applied).toEqual([write]);
  });

  it('refuses a failure the server actually answered, so the caller can surface it', async () => {
    // A permission denial is not a connectivity problem. Queued, it would be
    // retried forever and never reach the reader; the caller has to hear `false`
    // so it can say something.
    const user = 'user-refused';
    const denied = new Error('permission denied for table saved_items');
    denied.name = 'PostgrestError 42501';

    const kept = await withOnline(true, () =>
      queueIfOffline(user, denied, { kind: 'stash-delete', stashId: 'st' }),
    );
    expect(kept).toBe(false);
    expect(await hasPending(user)).toBe(false);
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
    await drainPending(USER_B, async (m) => {
      asB.push(pullOf(m));
    });
    expect(asB).toEqual(['b-only']);

    // A's write is untouched and still theirs to drain.
    const asA: string[] = [];
    await drainPending(USER_A, async (m) => {
      asA.push(pullOf(m));
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
    const a1 = drainPending(USER_A, async (m) => {
      seen.push(pullOf(m));
      await gate;
    });
    const a2 = drainPending(USER_A, async (m) => {
      seen.push(`dup:${pullOf(m)}`);
    });
    const b1 = drainPending(USER_B, async (m) => {
      seen.push(pullOf(m));
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
      async (m) => {
        applied.push(pullOf(m));
        signedIn = USER_B; // sign-out lands while the first write is in flight
      },
      () => signedIn === USER_A,
    );

    // Only the write that started while A was signed in is applied.
    expect(applied).toEqual(['first']);

    // The remainder is still A's, untouched, and replays when A returns.
    signedIn = USER_A;
    const later: string[] = [];
    await drainPending(USER_A, async (m) => {
      later.push(pullOf(m));
    });
    expect(later).toEqual(['second']);
  });
});

/**
 * Telling "the network is gone" apart from "the server said no".
 *
 * The feed used to treat every failure as offline whenever the cache had anything,
 * so a 500 or an expired JWT rendered "Offline — reading from your downloaded copies"
 * on a working connection. The server errors are the ones worth surfacing early, and
 * they were the ones being hidden.
 */
describe('isOfflineFailure', () => {
  it('is true when the browser says there is no network', () => {
    // Whatever the error was, there is no point calling it a server problem.
    expect(withOnline(false, () => isOfflineFailure(new Error('anything')))).toBe(true);
  });

  it('is true for the TypeError fetch rejects with when a request never completes', () => {
    // DNS failure, connection refused, CORS preflight failure.
    expect(withOnline(true, () => isOfflineFailure(new TypeError('Failed to fetch')))).toBe(true);
  });

  it('is false for a server error that actually arrived', () => {
    // The case that mattered: a response came back and said no. `onLine` is true,
    // and this must reach the reader as a retryable error, not as a connectivity shrug.
    const rlsFailure = new Error('permission denied for function get_feed');
    expect(withOnline(true, () => isOfflineFailure(rlsFailure))).toBe(false);
  });

  it('does not trust navigator.onLine to prove the connection works', () => {
    // `onLine === true` only means an interface is up, not that anything is
    // reachable — so it is never used in that direction. A TypeError still wins.
    expect(withOnline(true, () => isOfflineFailure(new TypeError('Load failed')))).toBe(true);
  });

  it('survives an environment with no navigator at all', () => {
    // Server-side rendering, and the Node test environment this suite runs in.
    expect(withOnline(undefined, () => isOfflineFailure(new Error('boom')))).toBe(false);
    expect(withOnline(undefined, () => isOfflineFailure(new TypeError('boom')))).toBe(true);
  });

  it('treats a non-Error rejection as a server problem', () => {
    // Erring toward showing the reader an error they can retry, rather than
    // silently serving stale cache for a reason nobody established.
    expect(withOnline(true, () => isOfflineFailure('a string'))).toBe(false);
    expect(withOnline(true, () => isOfflineFailure(null))).toBe(false);
  });
});

/*
 * `queueMutation` used to return `void` and swallow an IndexedDB failure, so a caller had
 * no way to tell a write that was waiting for the drain from one that had vanished. Most
 * callers do not care — a reader mid-gesture cannot act on a dead IndexedDB, and throwing
 * would turn a lost write into a broken screen. The census does care, because it tells the
 * reader their answer was recorded, and in a browser with site data blocked that was untrue.
 */
describe('queueMutation reports whether it persisted', () => {
  it('answers true when the write is waiting for the drain', async () => {
    const user = 'queue-contract-user';
    await expect(queueMutation(user, { kind: 'read', pullId: 'p1' })).resolves.toBe(true);
    await expect(hasPending(user)).resolves.toBe(true);
  });

  /*
   * The branch the change exists for, and the one the first version of this suite left
   * uncovered: two of its three cases passed against the old `Promise<void>` shape,
   * because `queueIfOffline` already returned a hard-coded `true` on the offline branch.
   *
   * `db()` memoises its promise, so removing `indexedDB` before the first call in this
   * module gives a stable rejection — which is what a browser with site data blocked
   * looks like from here.
   */
  /*
   * A store that cannot be opened at all — a browser with site data blocked, which is the
   * population this whole contract exists for. `idb`'s `openDB` rejects on this object
   * rather than going through `onerror`; either way `queueMutation`'s catch is what runs,
   * and the point of the fixture is that opening fails, not how.
   */
  const withBrokenStore = async <T>(run: (m: typeof OfflineModule) => Promise<T>) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { value: {}, configurable: true });
    try {
      // A fresh registry, so the instance under test does not share the working handle
      // the rest of this file has already memoised.
      vi.resetModules();
      return await run(await import('./offline.js'));
    } finally {
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else delete (globalThis as unknown as Record<string, unknown>).indexedDB;
      vi.resetModules();
    }
  };

  it('answers false when the store cannot be opened', async () => {
    await withBrokenStore(async (offline) => {
      await expect(
        offline.queueMutation('broken-store-user', { kind: 'read', pullId: 'p9' }),
      ).resolves.toBe(false);
    });
  });

  /*
   * The half the previous revision left untested, and the one whose absence would let the
   * regression back in silently: re-propagating `queueMutation`'s answer through
   * `queueIfOffline` kept the whole suite green, because every case ran against a working
   * store. This is the case that fails if the two contracts are collapsed again — and its
   * failure mode is a reader with site data blocked watching their Library be replaced by
   * the error screen.
   */
  it('queueIfOffline still takes responsibility when the store could not keep it', async () => {
    await withBrokenStore(async (offline) => {
      const handled = await withOnline(false, () =>
        offline.queueIfOffline('broken-store-user', TRANSPORT_ERROR, {
          kind: 'read',
          pullId: 'p10',
        }),
      );
      expect(handled).toBe(true);
    });
  });
});

/*
 * `queueIfOffline` answers a different question from `queueMutation`, deliberately.
 *
 * Its three callers in `Library.tsx` all reload the screen when it is false, so `false`
 * has to mean "the server refused this" and nothing else. An earlier revision propagated
 * persistence through it, which made a dead IndexedDB read as a server refusal and
 * replaced a working Library with the error screen — worse than the silent loss it was
 * trying to fix.
 */
describe('queueIfOffline answers whether it took responsibility', () => {
  it('is true for an offline failure, whatever the store did', async () => {
    const user = 'queue-contract-offline';
    const queued = await withOnline(false, () =>
      queueIfOffline(user, TRANSPORT_ERROR, { kind: 'read', pullId: 'p2' }),
    );
    expect(queued).toBe(true);
    await expect(hasPending(user)).resolves.toBe(true);
  });

  it('is false for a failure the server chose, and queues nothing', async () => {
    const user = 'queue-contract-online';
    const queued = await withOnline(true, () =>
      queueIfOffline(user, new Error('server said no'), { kind: 'read', pullId: 'p3' }),
    );
    expect(queued).toBe(false);
    await expect(hasPending(user)).resolves.toBe(false);
  });
});

/*
 * The queue used to accept a write it was going to throw away.
 *
 * `queueMutation` answered "persisted", which was true of IndexedDB and useless to
 * the reader: `runDrain` deletes a write the server refused for a reason no replay
 * can change, so the entry lived exactly until the next drain. Every caller that
 * reports success on a successful queue — the census counting a calibration as
 * recorded, Review leaving `lostGrade` unset — was therefore reporting a write with
 * no future, and the census is the expensive one because it is offered once.
 *
 * The refusal is now passed in and the write is declined, which turns each of those
 * callers' existing "could not record" branch into the one that fires. These pin
 * both halves: what is declined, and what must still be kept.
 */
describe('queueing a write the server has already refused', () => {
  const refusal = (code: string) => {
    const e = new Error('the server refused this write');
    e.name = `PostgrestError ${code}`;
    return e;
  };

  it.each(['23503', '23514', '22P02'])(
    'declines a recall the server refused with %s, rather than losing it on the next drain',
    async (code) => {
      const user = `u-decline-${code}`;
      const queued = await queueMutation(
        user,
        {
          kind: 'recall',
          pullId: 'gone',
          grade: 'good',
          mutationId: 'm1',
          submittedAt: 1_700_000_000_000,
          recallKind: 'calibration',
        },
        refusal(code),
      );
      expect(queued).toBe(false);
      // And nothing was written, so `hasPending` does not hold a retry timer open
      // for a write that has already been decided against.
      await expect(hasPending(user)).resolves.toBe(false);
    },
  );

  it('still queues a refusal a retry could survive', async () => {
    const user = 'u-transient';
    // 57014 is the server being unwell, and 42501 may be about the session rather
    // than the account — `rpc-error.ts` keeps both off the permanent list on purpose.
    for (const code of ['57014', '42501']) {
      expect(
        await queueMutation(
          user,
          {
            kind: 'recall',
            pullId: 'p1',
            grade: 'good',
            mutationId: `m-${code}`,
            submittedAt: 1_700_000_000_000,
            recallKind: 'review',
          },
          refusal(code),
        ),
      ).toBe(true);
    }
    await expect(hasPending(user)).resolves.toBe(true);
  });

  it('still queues when no refusal is offered at all', async () => {
    // The offline case: the request never left, so there is no server verdict to
    // judge and the write is exactly the kind the queue exists for.
    const user = 'u-no-refusal';
    expect(
      await queueMutation(user, {
        kind: 'recall',
        pullId: 'p1',
        grade: 'good',
        mutationId: 'm2',
        submittedAt: 1_700_000_000_000,
        recallKind: 'review',
      }),
    ).toBe(true);
    await expect(hasPending(user)).resolves.toBe(true);
  });

  it('still queues a collection write, whose target may be one entry behind it', async () => {
    /*
     * The one case `queueMutation` must not judge. A `stash-create` naming a parent,
     * or an `organise` naming a destination, can fail 23503 against a collection that
     * is itself still queued — and at queue time there is no queue to check yet. Only
     * a drain can tell, so both are kept and `runDrain` decides with the set in hand.
     * Declining them here would delete a collection the reader had just made.
     */
    const user = 'u-collection';
    expect(
      await queueMutation(
        user,
        { kind: 'stash-create', stashId: 's1', name: 'Later', parentId: 'p-queued' },
        refusal('23503'),
      ),
    ).toBe(true);
    expect(
      await queueMutation(
        user,
        { kind: 'organise', saveId: 'sv', patch: { stashId: 's1' } },
        refusal('23503'),
      ),
    ).toBe(true);
    await expect(hasPending(user)).resolves.toBe(true);
  });
});

/**
 * The card the reader already judged, asked durably.
 *
 * `Review.tsx` kept this in a `useRef`, and Review is a tab: switching to Library
 * destroys the component and the set with it, so a card whose grade is still queued
 * comes back due and a second tap mints a second mutation id. Two ids are two grades.
 * The queue outlives the mount and the reload, and a pending grade is exactly the
 * condition, so it is the queue that gets asked.
 */
describe('the pulls a queued grade already covers', () => {
  const drain = (user: string) => drainPending(user, async () => undefined);

  it('names a pull whose grade is still waiting', async () => {
    await queueMutation(USER_A, {
      kind: 'recall',
      pullId: 'p-graded',
      grade: 'good',
      mutationId: 'm1',
      submittedAt: Date.now(),
    });
    expect([...(await pendingRecallPullIds(USER_A))]).toEqual(['p-graded']);
    await drain(USER_A);
    // And stops naming it once the grade has actually applied, or the card would
    // never come round again.
    expect((await pendingRecallPullIds(USER_A)).size).toBe(0);
  });

  it("never names another account's", async () => {
    await queueMutation(USER_B, {
      kind: 'recall',
      pullId: 'p-theirs',
      grade: 'forgot',
      mutationId: 'm2',
      submittedAt: Date.now(),
    });
    expect((await pendingRecallPullIds(USER_A)).size).toBe(0);
    expect((await pendingRecallPullIds(USER_B)).has('p-theirs')).toBe(true);
    await drain(USER_B);
  });

  it('names only grades, not the saves and reads sharing the queue', async () => {
    // A card the reader saved is still due, and hiding it would be this fix
    // overreaching into the one place it has no business.
    await queueMutation(USER_A, { kind: 'save', pullId: 'p-saved' });
    await queueMutation(USER_A, { kind: 'read', pullId: 'p-read' });
    expect((await pendingRecallPullIds(USER_A)).size).toBe(0);
    await drain(USER_A);
  });
});
