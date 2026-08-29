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
  /** Writes made offline, drained in order once the connection returns. */
  pending: {
    key: number;
    value: { id?: number; kind: 'save' | 'unsave' | 'read'; pullId: string; at: number };
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
  kind: 'save' | 'unsave' | 'read',
  pullId: string,
): Promise<void> {
  try {
    const database = await db();
    await database.add('pending', { kind, pullId, at: Date.now() });
  } catch {
    /* nothing to do — the mutation is simply lost, which is the honest outcome */
  }
}

/**
 * Drain queued writes in the order they were made. A handler that throws stops
 * the drain rather than skipping ahead: replaying a save after a later unsave
 * would resurrect something the reader removed.
 */
export async function drainPending(
  apply: (m: { kind: 'save' | 'unsave' | 'read'; pullId: string }) => Promise<void>,
): Promise<number> {
  let drained = 0;
  try {
    const database = await db();
    const items = (await database.getAll('pending')).sort((a, b) => a.at - b.at);
    for (const item of items) {
      await apply(item);
      if (item.id !== undefined) await database.delete('pending', item.id);
      drained += 1;
    }
  } catch {
    /* stop at the first failure; the rest stay queued for the next attempt */
  }
  return drained;
}

export function onReconnect(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}
