import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import {
  cachePulls,
  clearReviewPack,
  drainPending,
  hasPending,
  isOfflineFailure,
  onPendingQueued,
  queueIfOffline,
  queueMutation,
  readCachedPulls,
  readReviewPack,
  removeFromPack,
  storeReviewPack,
  writeScope,
  type PendingWrite,
} from './offline.js';
/* The module's own shape, for the re-imported instance the broken-store cases use. */
import type * as OfflineModule from './offline.js';
import { TRANSPORT_ERROR } from './rpc-error.js';
import type { DueReview, FeedRow } from './types.js';

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

const due = (pullId: string, retrievability = 0.5): DueReview => ({
  pullId,
  headline: `Due ${pullId}`,
  body: 'Body',
  whyItMatters: null,
  workTitle: 'Work',
  workSlug: 'work',
  retrievability,
  stability: 1,
  reps: 1,
  dueAt: '2026-09-05T00:00:00Z',
  question: null,
});

/*
 * The raw API, for laying down a database the way the old code left it, for
 * playing the part of another tab, and for inspecting what the upgrade made of
 * it — without going through the module's memoised handle, which is the thing
 * under test.
 */
const rawOpen = (
  version: number,
  onUpgrade?: (db: IDBDatabase) => void,
  onBlocked?: () => void,
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open('what-a-pull', version);
    request.onupgradeneeded = () => onUpgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => onBlocked?.();
  });

const rawRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const settled = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const rawDelete = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('what-a-pull');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('delete blocked: a connection did not yield'));
  });

/** The id the upgrade minted, carried from the first case to the second. */
let stampedId: string | undefined;

/*
 * FIRST IN THE FILE, ON PURPOSE. The module memoises its connection on first use
 * and opens at the current version, so this suite has to lay down a version-1
 * database before anything touches the store — or it is testing an upgrade that
 * already ran. A test added above it that reaches the store will fail these,
 * loudly, which is the right failure.
 */
describe('schema version 1 → 2', () => {
  it('answers "no store" while an older tab holds the database, then takes it up when that tab lets go', async () => {
    // What the old code left behind: cached rows nobody can attribute, and a
    // queued grade with nothing to recognise a replay by ...
    const oldTab = await rawOpen(1, (db) => {
      db.createObjectStore('pulls', { keyPath: 'id' });
      db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
    });
    const seed = oldTab.transaction(['pulls', 'pending'], 'readwrite');
    seed.objectStore('pulls').put({ ...row('legacy'), cachedAt: Date.now() });
    seed
      .objectStore('pending')
      .add({ kind: 'recall', pullId: 'p-old', grade: 'good', userId: USER_A, at: 1 });
    seed.objectStore('pending').add({ kind: 'save', pullId: 'p-save', userId: USER_A, at: 2 });
    await settled(seed);

    // ... and a tab still running that code. It has no `blocking` handler, so it
    // keeps its connection open and the upgrade is blocked behind it. Nothing
    // that awaited the store would ever settle if the module waited for it.
    vi.resetModules();
    const fresh = await import('./offline.js');
    await expect(fresh.readCachedPulls(USER_A)).resolves.toEqual([]);
    await expect(
      fresh.queueMutation(USER_A, { kind: 'read', pullId: 'while-blocked' }),
    ).resolves.toBe(false);

    // AN UNAVAILABLE STORE IS NOT AN EMPTY ONE. Two entries are on disk right
    // now. `Feed.tsx` uses `hasPending` to decide whether to keep the drain
    // timer alive, so answering `false` here would reset the backoff and
    // schedule nothing — and the queue would sit undrained after the old tab
    // closed, until a reload.
    await expect(fresh.hasPending(USER_A)).resolves.toBe(true);

    // The old tab goes away. The open that was waiting completes, runs the
    // upgrade, and the module takes the connection up without a reload.
    oldTab.close();
    await vi.waitFor(async () => {
      await expect(
        fresh.queueMutation(USER_A, { kind: 'read', pullId: 'after-adoption' }),
      ).resolves.toBe(true);
    });

    const v2 = await rawOpen(2);
    expect(v2.version).toBe(2);
    const tx = v2.transaction(['pulls', 'reviewPack', 'pending'], 'readonly');
    const pulls = tx.objectStore('pulls');
    expect(pulls.keyPath).toBe('key');
    expect(pulls.indexNames.contains('by-user')).toBe(true);
    // The unscoped rows are gone, not adopted by whoever upgraded.
    expect(await rawRequest(pulls.count())).toBe(0);
    expect(tx.objectStore('reviewPack').keyPath).toBe('key');
    const queued: { kind: string; mutationId?: string; submittedAt?: number }[] = await rawRequest(
      tx.objectStore('pending').getAll(),
    );
    await settled(tx);
    v2.close();

    const recall = queued.find((e) => e.kind === 'recall');
    expect(recall?.mutationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The moment the reader answered — the entry's own queue time — and not the
    // moment of the upgrade. A device offline for days must not tell the server
    // its stale grade was given just now.
    expect(recall?.submittedAt).toBe(1);
    // Only a grade needed one; every other kind is replay-safe by construction.
    expect(queued.find((e) => e.kind === 'save')?.mutationId).toBeUndefined();
    stampedId = recall?.mutationId;
    vi.resetModules();
  });

  it('keeps the stamped id across a second open, and hands it to the drain', async () => {
    // A fresh module instance opens the database again, at version 2. No upgrade
    // runs, so nothing is re-minted, and the drain replays the grade under the
    // id it was given the first time — which is the whole point of stamping it.
    expect(stampedId).toBeDefined();
    vi.resetModules();
    try {
      const fresh = await import('./offline.js');
      const seen: PendingWrite[] = [];
      await fresh.drainPending(USER_A, async (m) => {
        seen.push(m);
      });
      const recall = seen.find((m) => m.kind === 'recall');
      expect(recall?.kind === 'recall' ? recall.mutationId : null).toBe(stampedId);
      expect(recall?.kind === 'recall' ? typeof recall.submittedAt : null).toBe('number');
    } finally {
      vi.resetModules();
    }
  });
});

describe('an upgrade that cannot finish', () => {
  it('leaves the store at version 1 rather than half-stamped', async () => {
    // `idb` calls `upgrade(...)` and discards the promise, so an async upgrade
    // that rejects used to let the version bump commit anyway: `openDB`
    // resolved, the module reported success, and the entries the cursor had not
    // reached kept no mutation id — permanently, because the stamping only runs
    // at `oldVersion < 2`. `crypto.randomUUID` throwing is not hypothetical: it
    // is undefined in a non-secure context.
    await rawDelete();
    const oldTab = await rawOpen(1, (db) => {
      db.createObjectStore('pulls', { keyPath: 'id' });
      db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
    });
    const seed = oldTab.transaction('pending', 'readwrite');
    seed.objectStore('pending').add({ kind: 'recall', pullId: 'p1', grade: 'good', at: 1 });
    seed.objectStore('pending').add({ kind: 'recall', pullId: 'p2', grade: 'good', at: 2 });
    await settled(seed);
    oldTab.close();

    const realUuid = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: () => {
        throw new Error('randomUUID is unavailable in an insecure context');
      },
    });

    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.resetModules();
      const fresh = await import('./offline.js');
      // A store that cannot be opened at all answers `false`: this does not resolve
      // itself the way a tab holding the previous version does, and answering `true`
      // would schedule a retry every five minutes for the life of the tab, each one
      // a fresh open that fails again.
      await expect(fresh.hasPending(USER_A)).resolves.toBe(false);
      // And it is said out loud once. Nothing is rethrown and `openDB` rejects with
      // an AbortError every caller reads as "no store", so without this the whole
      // offline queue is permanently unavailable with nothing recorded anywhere.
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: realUuid,
      });
      vi.resetModules();
    }

    // Still version 1, and both entries still unstamped: nothing was half-done.
    const check = await rawOpen(1);
    expect(check.version).toBe(1);
    const queued: { mutationId?: string }[] = await rawRequest(
      check.transaction('pending', 'readonly').objectStore('pending').getAll(),
    );
    expect(queued).toHaveLength(2);
    expect(queued.every((e) => e.mutationId === undefined)).toBe(true);
    check.close();

    // And the failure is not remembered: a fresh open, with a working
    // `randomUUID`, upgrades and stamps both.
    await rawDelete();
    vi.resetModules();
  });
});

describe('offline cache', () => {
  it('round-trips cached pulls so a dropped connection still has something to read', async () => {
    await cachePulls(USER_A, [row('a'), row('b')]);
    const cached = await readCachedPulls(USER_A);
    expect(cached.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('returns the most recently cached first', async () => {
    await cachePulls(USER_A, [row('old')]);
    await new Promise((r) => setTimeout(r, 5));
    await cachePulls(USER_A, [row('new')]);
    const [first] = await readCachedPulls(USER_A);
    expect(first?.id).toBe('new');
  });

  it('hands back feed rows, not the bookkeeping around them', async () => {
    await cachePulls(USER_A, [row('plain')]);
    const cached = (await readCachedPulls(USER_A)).find((r) => r.id === 'plain');
    expect(cached).toEqual(row('plain'));
  });

  it("never shows one account another's copy", async () => {
    // The reason version 2 exists: on a shared computer an offline load used to
    // show whoever sat down next the previous reader's feed.
    await cachePulls(USER_A, [row('a-only')]);
    await cachePulls(USER_B, [row('b-only')]);
    expect((await readCachedPulls(USER_B)).map((r) => r.id)).not.toContain('a-only');
    expect((await readCachedPulls(USER_A)).map((r) => r.id)).not.toContain('b-only');
  });

  it('keeps one pull cached by two accounts as two rows', async () => {
    await cachePulls(USER_A, [row('shared')]);
    await cachePulls(USER_B, [row('shared')]);
    expect((await readCachedPulls(USER_A)).map((r) => r.id)).toContain('shared');
    expect((await readCachedPulls(USER_B)).map((r) => r.id)).toContain('shared');
  });

  it('writes nothing and reads nothing for no account', async () => {
    await cachePulls(null, [row('nobody')]);
    expect(await readCachedPulls(null)).toEqual([]);
    expect((await readCachedPulls(USER_A)).map((r) => r.id)).not.toContain('nobody');
  });
});

describe('an upgrade from another tab', () => {
  it('is let through: the module closes its own connection rather than blocking it', async () => {
    // This module holds a connection (the cache tests above opened it).
    await cachePulls(USER_A, [row('before-yield')]);

    // A newer release in another tab wants the next version. If this connection
    // stayed open, that tab's open would be blocked behind it — the situation
    // version 1 left every reader in. Closing synchronously, inside the
    // `versionchange` event, means the other tab never even sees `blocked`.
    let blocked = false;
    const newerTab = await rawOpen(
      3,
      () => undefined,
      () => {
        blocked = true;
      },
    );
    expect(blocked).toBe(false);
    expect(newerTab.version).toBe(3);
    newerTab.close();

    // Put the store back for the rest of the file: this code cannot open a
    // version it has never heard of, and a rejection there is "no store", which
    // the drain tests below would read as an empty queue.
    await rawDelete();

    // And the module reopens on its own: its handle was dropped, not poisoned.
    await cachePulls(USER_A, [row('after-yield')]);
    expect((await readCachedPulls(USER_A)).map((r) => r.id)).toEqual(['after-yield']);
  });
});

describe('review pack', () => {
  it('is null until something is downloaded', async () => {
    expect(await readReviewPack('pack-nobody')).toBeNull();
  });

  it('drops an entry an older build wrote in a shape this one cannot order', async () => {
    // The entry is stored whole precisely so its shape can drift, which makes a
    // pack written by an older build the expected case rather than a corruption.
    // Without the guard, an item missing `retrievability` makes the comparator
    // NaN and the promised "weakest memory first" order arbitrary, and a missing
    // headline reaches the screen as `undefined`.
    const user = 'pack-drift';
    await storeReviewPack(user, [due('good')], 2_000);

    const raw = await rawOpen(2);
    const tx = raw.transaction('reviewPack', 'readwrite');
    tx.objectStore('reviewPack').put({
      key: `${user}:drifted`,
      userId: user,
      pullId: 'drifted',
      syncedAt: 2_000,
      item: { pullId: 'drifted', body: 'written by a build that named things differently' },
    });
    await settled(tx);
    raw.close();

    const pack = await readReviewPack(user);
    expect(pack?.items.map((i) => i.pullId)).toEqual(['good']);
  });

  it('stores a pack for one account and reads it back with when it was synced', async () => {
    const user = 'pack-a';
    await expect(storeReviewPack(user, [due('p1'), due('p2')], 1_000)).resolves.toBe(true);
    const pack = await readReviewPack(user);
    expect(pack?.syncedAt).toBe(1_000);
    expect(pack?.items.map((i) => i.pullId).sort()).toEqual(['p1', 'p2']);
    expect(pack?.items.find((i) => i.pullId === 'p1')).toEqual(due('p1'));
  });

  it('comes back weakest memory first, as the server would have asked', async () => {
    // The index hands rows back by key. `get_due_reviews` orders by
    // retrievability, and the pack has to ask in that order or offline practice
    // starts with the cards that need it least.
    const user = 'pack-order';
    await storeReviewPack(user, [due('z', 0.9), due('a', 0.2), due('m', 0.5)]);
    expect((await readReviewPack(user))?.items.map((i) => i.pullId)).toEqual(['a', 'm', 'z']);
  });

  it('is per account', async () => {
    await storeReviewPack('pack-b', [due('b1')]);
    await storeReviewPack('pack-c', [due('c1')]);
    expect((await readReviewPack('pack-b'))?.items.map((i) => i.pullId)).toEqual(['b1']);
    expect((await readReviewPack('pack-c'))?.items.map((i) => i.pullId)).toEqual(['c1']);
  });

  it('replaces the previous pack rather than merging into it', async () => {
    // A card the server no longer lists must leave the device too, or offline
    // practice keeps asking what the model has already moved on from.
    const user = 'pack-replace';
    await storeReviewPack(user, [due('gone'), due('kept')]);
    await storeReviewPack(user, [due('kept'), due('new')]);
    expect((await readReviewPack(user))?.items.map((i) => i.pullId).sort()).toEqual([
      'kept',
      'new',
    ]);
  });

  it('drops a card that was answered, and only that card', async () => {
    const user = 'pack-remove';
    await storeReviewPack(user, [due('answered'), due('waiting')]);
    await removeFromPack(user, 'answered');
    expect((await readReviewPack(user))?.items.map((i) => i.pullId)).toEqual(['waiting']);
  });

  it('is null again once every card has been answered', async () => {
    const user = 'pack-done';
    await storeReviewPack(user, [due('only')]);
    await removeFromPack(user, 'only');
    expect(await readReviewPack(user)).toBeNull();
  });

  it("clears one account's pack and leaves another's alone", async () => {
    await storeReviewPack('pack-clear-a', [due('a1')]);
    await storeReviewPack('pack-clear-b', [due('b1')]);
    await clearReviewPack('pack-clear-a');
    expect(await readReviewPack('pack-clear-a')).toBeNull();
    expect((await readReviewPack('pack-clear-b'))?.items.map((i) => i.pullId)).toEqual(['b1']);
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
 * A grade that reached the server and stayed in the queue.
 *
 * `blocking()` fires when another tab opens the database at a higher version, and
 * the first version of it closed this tab's handle synchronously. `runDrain`
 * captured that handle before its loop and its post-apply `delete('pending', id)`
 * is the last thing it does with it — outside the inner try, so an
 * `InvalidStateError` there was swallowed by the outer catch and the entry
 * survived a write the server had already taken.
 *
 * Harmless for a save or a read. For a recall grade it is what this file's own
 * comments call unaffordable: `grade_recall` multiplies stability and increments
 * `reps`, so applying it twice roughly squares the interval.
 */
describe('a connection that yields mid-drain', () => {
  it('does not leave an applied grade in the queue for the next pass', async () => {
    const user = 'u-yield';
    await queueMutation(user, {
      kind: 'recall',
      pullId: 'p1',
      grade: 'good',
      mutationId: 'm1',
      submittedAt: 1_700_000_000_000,
    });
    await queueMutation(user, {
      kind: 'recall',
      pullId: 'p2',
      grade: 'good',
      mutationId: 'm2',
      submittedAt: 1_700_000_000_001,
    });

    const applied: string[] = [];
    // Another tab asks for a higher version while the first write is being applied.
    // NOT awaited here, deliberately: in a browser the upgrade happens in a
    // different tab, and awaiting it in this one would simply deadlock against the
    // deferral being tested. What matters is that `versionchange` fires on this
    // connection mid-drain, which is the moment the old `blocking()` closed it.
    const bumps: Promise<{ close: () => void }>[] = [];
    await drainPending(user, async (m) => {
      applied.push(`${m.kind}:${'pullId' in m ? m.pullId : ''}`);
      if (applied.length === 1) {
        bumps.push(openDB('what-a-pull', 3, { upgrade() {} }));
        await new Promise((r) => setTimeout(r, 0));
      }
    });
    for (const b of bumps) (await b).close();

    // Second pass: nothing left to replay.
    const second: string[] = [];
    await drainPending(user, async (m) => {
      second.push(`${m.kind}:${'pullId' in m ? m.pullId : ''}`);
    });

    expect(applied).toEqual(['recall:p1', 'recall:p2']);
    expect(second).toEqual([]);
    await expect(hasPending(user)).resolves.toBe(false);
  });
});

/*
 * A store call made while another tab is upgrading must still settle.
 *
 * Round 3 fixed a real fault — `blocking()` closed the handle under a running drain,
 * so the post-apply delete threw and an applied grade stayed queued — by DEFERRING
 * the close until the drain finished. That was worse than the fault. IndexedDB
 * serialises the connection queue per database, so a connection that has not let go
 * blocks every later `open()` from this tab too: a cache read issued during the
 * deferral never settled, and a drain whose own work reopens the database deadlocked
 * outright, wedging the queue for the life of the tab.
 *
 * The delete is resilient instead (`forget` reopens and retries), and `blocking()`
 * does the one thing it is for. This pins the property that the deferral broke.
 */
describe('a version change from another tab', () => {
  it('does not deadlock a drain whose own work reopens the database', async () => {
    /*
     * The deadlock, which is the sharp end of it. `forget` reopens the database to
     * remove a write whose handle died, so a drain's own critical path can call
     * `db()` — and a round-3 fix held the connection open until the drain finished.
     * Each waited for the other: `inFlight.delete` never ran, so every later
     * `drainPending(user)` returned the same hung promise and the queue was wedged
     * for the life of the tab. Offline is one of the five law 3 keeps free forever.
     *
     * `blocking()` closes immediately again and the delete is made resilient
     * instead, which is where the fix belonged.
     */
    const user = 'u-deadlock';
    await queueMutation(user, { kind: 'save', pullId: 'p1' });
    await queueMutation(user, { kind: 'save', pullId: 'p2' });

    const bump = openDB('what-a-pull', 4, { upgrade() {} });

    const drained = await Promise.race([
      drainPending(user, async (m) => {
        if ('pullId' in m && m.pullId === 'p1') {
          // Another tab's upgrade lands mid-drain, then this drain reopens.
          await new Promise((r) => setTimeout(r, 0));
          await hasPending(user);
        }
      }).then((n) => `drained:${n}`),
      new Promise<string>((r) => setTimeout(() => r('deadlocked'), 1000)),
    ]);

    expect(drained, 'the drain never finished').not.toBe('deadlocked');
    // And the queue is not wedged: a second drain runs rather than returning the
    // first one's hung promise.
    const second = await Promise.race([
      drainPending(user, async () => {}).then(() => 'ran'),
      new Promise<string>((r) => setTimeout(() => r('wedged'), 1000)),
    ]);
    expect(second, 'the queue stayed wedged after the drain').toBe('ran');
    (await bump).close();
  });
});
