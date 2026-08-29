import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FeedRow } from './types.js';

/**
 * Offline reading, free forever (CLAUDE.md law 3).
 *
 * Deepstash puts library downloads behind Pro. Here it costs nothing because it
 * runs entirely in the browser: the service worker caches the bundle, and
 * IndexedDB holds the reader's own content plus a queue of writes made while
 * disconnected.
 *
 * Built on the web before any native wrapper, so Capacitor later becomes an
 * enhancement rather than a rescue operation.
 */

interface WapDB extends DBSchema {
  pulls: { key: string; value: FeedRow & { cachedAt: number } };
  /**
   * Writes made offline, drained in order once the connection returns.
   *
   * `userId` is not decoration. Pending writes survive sign-out, so on a shared
   * browser one account's queued saves and reads would otherwise replay into
   * whoever signs in next — contaminating their history, knowledge model and
   * library with someone else's reading.
   */
  pending: {
    key: number;
    value: {
      id?: number;
      userId: string;
      kind: 'save' | 'unsave' | 'read';
      pullId: string;
      at: number;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<WapDB>> | null = null;

function db() {
  dbPromise ??= openDB<WapDB>('what-a-pull', 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('pulls')) {
        database.createObjectStore('pulls', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('pending')) {
        database.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
      }
    },
  });
  return dbPromise;
}

/** Best-effort throughout: storage can be unavailable (private windows, blocked
 *  site data), and reading must never fail because caching did. */
export async function cachePulls(rows: FeedRow[]): Promise<void> {
  try {
    const database = await db();
    const tx = database.transaction('pulls', 'readwrite');
    await Promise.all(rows.map((r) => tx.store.put({ ...r, cachedAt: Date.now() })));
    await tx.done;
  } catch {
    /* offline caching is an enhancement, never a requirement */
  }
}

export async function readCachedPulls(limit = 20): Promise<FeedRow[]> {
  try {
    const database = await db();
    const all = await database.getAll('pulls');
    return all.sort((a, b) => b.cachedAt - a.cachedAt).slice(0, limit);
  } catch {
    return [];
  }
}

export async function queueMutation(
  userId: string,
  kind: 'save' | 'unsave' | 'read',
  pullId: string,
): Promise<void> {
  try {
    const database = await db();
    await database.add('pending', { userId, kind, pullId, at: Date.now() });
  } catch {
    /* nothing to do — the mutation is simply lost, which is the honest outcome */
  }
}

/**
 * Drain queued writes, oldest first.
 *
 * Ordering only has to hold *per pull*: replaying a save after a later unsave
 * would resurrect something the reader removed, but a stuck write for one pull
 * says nothing about another. So a failure blocks only that pull's remaining
 * writes and the drain continues elsewhere — otherwise one permanently invalid
 * item (a save for a pull deleted while offline, say) would wedge the queue for
 * every pull, forever.
 */
// Keyed by user, not global. A single shared promise meant that if the account
// changed mid-drain, the new account's mount-time call would await the previous
// account's work — which filters to the *old* user's entries — and then never
// retry, leaving the new account's writes pending until the next reconnect.
const inFlight = new Map<string, Promise<number>>();

export function drainPending(
  userId: string,
  apply: (m: { kind: 'save' | 'unsave' | 'read'; pullId: string }) => Promise<void>,
  /**
   * Whether `userId` is still the signed-in account. Checked before every
   * write, because a drain can outlive a sign-out: the Supabase client is
   * shared, and a queued `read` carries no user argument — `record_read`
   * derives `auth.uid()` — so one account's pending read would otherwise land
   * in the next account's history and knowledge model.
   */
  isStillCurrent: () => boolean = () => true,
): Promise<number> {
  // Single-flight. The mount-time drain and a reconnect drain can otherwise
  // overlap — React Strict Mode's double effect mount reproduces it every time
  // in development — and both would snapshot the same pending items before
  // either deleted them, replaying every write twice.
  const existing = inFlight.get(userId);
  if (existing) return existing;

  const started = withCrossTabLock(userId, () => runDrain(userId, apply, isStillCurrent)).finally(
    () => {
      inFlight.delete(userId);
    },
  );
  inFlight.set(userId, started);
  return started;
}

/**
 * The in-flight map is per JavaScript context, but IndexedDB is shared across
 * every tab on the origin. Two tabs could each snapshot the same pending
 * entries before either deleted them, replaying every write twice. Web Locks
 * are origin-wide, which is the right scope; where unavailable we fall back to
 * the per-context guard alone.
 */
async function withCrossTabLock<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return run();
  return locks.request(`wap.drain.${userId}`, run);
}

async function runDrain(
  userId: string,
  apply: (m: { kind: 'save' | 'unsave' | 'read'; pullId: string }) => Promise<void>,
  isStillCurrent: () => boolean,
): Promise<number> {
  let drained = 0;
  const blocked = new Set<string>();
  try {
    const database = await db();
    const items = (await database.getAll('pending'))
      // Only this account's writes. Another user's stay queued for them.
      .filter((item) => item.userId === userId)
      .sort((a, b) => a.at - b.at);
    for (const item of items) {
      // Re-check between every item, not just at the start: signing out
      // mid-drain must stop the remaining writes rather than attribute them to
      // whoever signs in next. The entries stay queued for their real owner.
      if (!isStillCurrent()) break;
      if (blocked.has(item.pullId)) continue;
      try {
        await apply(item);
      } catch {
        // Keep it queued and skip the rest of this pull's writes, preserving
        // their relative order for the next attempt.
        blocked.add(item.pullId);
        continue;
      }
      if (item.id !== undefined) await database.delete('pending', item.id);
      drained += 1;
    }
  } catch {
    /* IndexedDB itself is unavailable — nothing to drain */
  }
  return drained;
}

export function onReconnect(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}
