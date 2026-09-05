import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb';
import type { Stance } from '@wap/schemas';
import type { RecallGrade } from './grades.js';
import { isPermanentFailure, sqlState, TRANSPORT_ERROR } from './rpc-error.js';
import type { SavePatch } from './stash-api.js';
import type { DueReview, FeedRow } from './types.js';

/**
 * Offline reading, free forever (CLAUDE.md law 3).
 *
 * Deepstash puts library downloads behind Pro. Here it costs nothing because it
 * runs entirely in the browser: the service worker caches the bundle, and
 * IndexedDB holds the reader's own content plus a queue of writes made while
 * disconnected.
 *
 * Everything in IndexedDB is keyed by account. The queue always was; the page
 * cache was not, and for a while that was a documented gap rather than a
 * design: on a shared computer an offline load could show whoever sat down
 * next the previous reader's feed. Schema version 2 closed it — the cache is
 * keyed `userId:pullId` and read through a `by-user` index, and the rows the
 * old schema held were dropped at upgrade because nothing recorded whose they
 * were. A downloaded review pack, added in the same version, is keyed the same
 * way from the start.
 *
 * Built on the web before any native wrapper, so Capacitor later becomes an
 * enhancement rather than a rescue operation.
 */

/**
 * A queued write, as a union so each kind carries exactly its own payload.
 *
 * Saves and reads are identified entirely by their pull. The two learning
 * writes are not: an explanation is several sentences the reader composed and a
 * conviction is a stance, and both exist nowhere else once the request that
 * carried them fails. They are queued for the same reason the others are, but
 * they are the ones it would actually hurt to lose.
 *
 * Every kind here must be safe to replay, since a queued write is retried
 * whenever its *response* was lost rather than its effect: saves collide on
 * their unique index, `record_read` is idempotent per pull and day, and the two
 * learning writes carry a `mutationId` minted once per submission, which is
 * what lets the server recognise a replay as a submission it already applied
 * — even when a later stance has superseded it in the meantime.
 *
 * `recall` is the one exception, and it earns its place by being queued under a
 * narrower condition instead — see the note on that member. The lasting fix is a
 * mutation id on `grade_recall`, the same treatment `set_conviction` and
 * `save_explanation` already have; until the RPC takes one, the condition is what
 * keeps the invariant.
 */
export type PendingWrite =
  | { kind: 'save' | 'unsave' | 'read'; pullId: string }
  /**
   * A recall grade — queued under a stricter rule than everything else here.
   *
   * `grade_recall` is the one write in this app that is **not** safe to replay. It
   * multiplies stability (`stability * (2.0 + …)` for a "good") and increments
   * `reps`, so applying one grade twice roughly squares the interval and the card
   * silently disappears from review for months. There is no unique index to collide
   * with and no mutation id to recognise a replay by, because the RPC takes neither.
   *
   * That makes the two failures asymmetric, and the asymmetry decides the rule.
   * Losing a grade is self-correcting: the card stays due and the reader grades it
   * again. Double-applying one is invisible and wrong in the direction this product
   * cannot afford — a memory model that quietly stops asking.
   *
   * So this kind is queued **only when the request demonstrably never reached the
   * server** — `isOfflineFailure`, which is `navigator.onLine === false` or the
   * PostgREST `code: ''` that means the call never got to Postgres. A 500, a refusal
   * or a timeout mid-flight is dropped rather than queued, because the write may
   * already have applied. See `Review.tsx`.
   *
   * The residual risk is a response lost in transit after the server committed, which
   * looks like a transport failure and is not one. It is the same class of risk the
   * `save` and `read` paths already accept, and it is far smaller than losing every
   * grade of a review session done on a plane — offline being one of the five things
   * law 3 promises free forever.
   */
  | {
      kind: 'recall';
      pullId: string;
      grade: RecallGrade;
      /**
       * Minted once per submission, so a replay whose first response was lost
       * can be recognised by the server as the same grade rather than applied
       * twice.
       *
       * Optional, and genuinely so: entries queued before this field existed are
       * given one at the schema upgrade (`stampQueuedGrades`), but the screens
       * that queue a grade are 1b's to change and still write none, and nothing
       * sends it to the RPC yet. So an entry in the store may or may not carry
       * one, and any consumer must treat it as absent-by-default until 1b makes
       * both fields required and threads them through.
       */
      mutationId?: string;
      /** When the reader answered, for the same server-side record. */
      submittedAt?: number;
    }
  | { kind: 'explain'; pullId: string; text: string; mutationId: string }
  | {
      kind: 'conviction';
      pullId: string;
      stance: Stance;
      mutationId: string;
      /**
       * When the reader submitted this stance — not when it was queued, which
       * is only when its request gave up. The server orders competing stances
       * by this and declines any older than the one on record, so a retry
       * delayed past a newer decision is a no-op rather than a reversal.
       */
      submittedAt: number;
    }
  /**
   * One organising change to one saved item — its collection, its note, its
   * archive or read-later flag.
   *
   * Law 3 promises unlimited stashing, and a promise that fails offline is a
   * smaller promise. Before this kind existed, moving a save between collections
   * on a train updated the screen, lost the write, and then reloaded a library
   * that could not load — so the reader watched their change vanish and their
   * shelf turn into an error page in one motion.
   *
   * Replay-safe because `updateSavedItem` is a last-write-wins `update` on the
   * named columns of one row: applying `archived = true` twice is applying it
   * once. `saveId` is `saved_items.id`, so a save deleted while offline makes
   * this a zero-row update rather than an error — PostgREST does not treat a
   * missing match as a failure, and the entry drains instead of wedging.
   *
   * The patch carries only the columns the reader touched, which is why two
   * patches for the same save cannot clobber each other's unrelated fields.
   * Same-column ones can, so their order matters — see `writeScope`.
   */
  | { kind: 'organise'; saveId: string; patch: SavePatch }
  /**
   * A collection created while disconnected.
   *
   * The id is minted by the client (`newStashId`), which is what makes this
   * replayable at all: `createStash` swallows `23505`, so a retry after a lost
   * response collides on the primary key instead of creating a second folder
   * with the same name. That is the same shape the `save` kind already has, one
   * table over.
   *
   * `parentId` is stored as the reader chose it. A create whose parent is itself
   * still queued can fail its foreign key on the first attempt; it stays queued
   * and succeeds on the next pass, because the parent was queued earlier and the
   * drain runs oldest first.
   */
  | { kind: 'stash-create'; stashId: string; name: string; parentId: string | null }
  /**
   * A collection deleted while disconnected.
   *
   * `delete … where id = $1` removes zero rows the second time, which is not an
   * error, so a replay is a no-op. What it is *not* safe against is being
   * replayed before the create it follows: the delete would find nothing, the
   * create would then land, and a collection the reader deleted would come back.
   * Ordering per stash is what forbids that, and it is `writeScope`'s job.
   */
  | { kind: 'stash-delete'; stashId: string };

/**
 * Which queued writes must keep their order relative to each other.
 *
 * Order is not global here and never was. It is *per subject*: replaying a save
 * after a later unsave resurrects something the reader removed, but a stuck
 * write for one pull says nothing about another, so a failure blocks one subject
 * and the drain continues elsewhere. Without that, a single permanently invalid
 * entry — a save for a pull deleted while offline — would wedge the queue for
 * everything, forever.
 *
 * Three kinds of subject now, and each is a different table's primary key:
 *
 *   pull:…    the six reading writes, keyed by `pulls.id`
 *   save:…    an organising patch, keyed by `saved_items.id`
 *   stash:…   a collection created or deleted, keyed by `stashes.id`
 *
 * The prefix is not decoration. All three are uuids drawn from different tables,
 * and an unprefixed key would let one table's id share a blocking scope with
 * another's — quietly coupling two unrelated writes the first time the strings
 * matched. It also keeps the create/delete pair for one stash in one scope,
 * which is the ordering that actually has to hold.
 */
export function writeScope(write: PendingWrite): string {
  switch (write.kind) {
    case 'save':
    case 'unsave':
    case 'read':
    case 'recall':
    case 'explain':
    case 'conviction':
      return `pull:${write.pullId}`;
    case 'organise':
      return `save:${write.saveId}`;
    case 'stash-create':
    case 'stash-delete':
      return `stash:${write.stashId}`;
  }
  /*
   * Unreachable for any `PendingWrite`, and the `never` is what proves it: a
   * kind added to the union without a branch above fails this assignment at
   * compile time rather than falling out of here with no scope.
   *
   * It is reachable at all only for an entry IndexedDB kept across an app
   * version that dropped a kind. Such an entry gets a scope of its own, so it
   * blocks nothing but itself.
   */
  const unknown: never = write;
  return `unknown:${String((unknown as { kind?: unknown }).kind)}`;
}

/** A feed row as the cache holds it: the row, whose it is, and when it arrived. */
interface CachedPull extends FeedRow {
  /** `userId:pullId` — one row per reader per pull, so two accounts never share one. */
  key: string;
  userId: string;
  cachedAt: number;
}

/**
 * One due card, downloaded for practising without a connection.
 *
 * `item` is whatever `get_due_reviews` returned, stored whole rather than
 * projected, so the pack follows the engine: when the RPC starts carrying a
 * question with a kind and a rationale, the pack carries it too without a
 * schema bump here.
 */
interface PackEntry {
  key: string;
  userId: string;
  pullId: string;
  item: DueReview;
  /** When this pack was fetched — the number a screen turns into "synced 2 h ago". */
  syncedAt: number;
}

interface WapDB extends DBSchema {
  pulls: { key: string; value: CachedPull; indexes: { 'by-user': string } };
  reviewPack: { key: string; value: PackEntry; indexes: { 'by-user': string } };
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
    value: PendingWrite & {
      id?: number;
      userId: string;
      at: number;
    };
  };
}

/**
 * Schema versions:
 *
 *   1  `pulls` keyed by pull id, unscoped; `pending` keyed by an autoincrement.
 *   2  `pulls` keyed `userId:pullId` with a `by-user` index; `reviewPack`, keyed
 *      the same way; every `recall` queued BEFORE the upgrade is given a mutation
 *      id it was queued without.
 *
 * The narrower wording is the true one. Version 2 backfills the entries already
 * on disk; it does not make the field an invariant of the store, because the two
 * screens that queue a grade — `Review.tsx` and `KnowledgeCensus.tsx` — still
 * queue `{kind, pullId, grade}` and are 1b's to change. Nothing sends the id to
 * the server yet either: `replayWrite` calls `gradeRecall(pullId, grade)` and
 * `api.gradeRecall` posts two arguments. `grade_recall` HAS taken `p_mutation_id`
 * since 20260905100000, so the de-duplication exists server-side and is simply
 * not reached until 1b threads it through. Stamping now means the entries already
 * queued are ready for that, rather than being the one class of write that can
 * never be recognised.
 */
const SCHEMA_VERSION = 2;

/**
 * The connection, or `null` for "there is no store right now".
 *
 * `null` is a real answer rather than a failure, and every caller treats it as
 * "cache unavailable" — the same way it treats a rejection. It exists for the
 * one case a rejection does not cover: another tab holding the database open at
 * an older version (see `blocked` below), where the open would otherwise stay
 * pending forever and so would everything awaiting it.
 */
type Handle = IDBPDatabase<WapDB> | null;

let dbPromise: Promise<Handle> | null = null;
/** The open connection behind `dbPromise`, so it can be closed synchronously when asked to yield. */
let live: IDBPDatabase<WapDB> | null = null;

function db(): Promise<Handle> {
  dbPromise ??= open().catch((error: unknown) => {
    // A FAILED OPEN IS NOT REMEMBERED. Every reason one fails is transient — an
    // upgrade that aborted, a version another tab raised past this build,
    // storage pressure, a private window running out of quota — and a memoised
    // rejection means this tab answers "no store" for the rest of its life and
    // never tries again. `terminated`, `blocking` and the blocked-then-failed
    // branch in `open` all clear the memo for the same reason; this is the
    // remaining path that did not.
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

/**
 * Open the store, and never leave a caller waiting on another tab.
 *
 * The PWA updates itself, and an updated page opens the database at a version
 * the page in the next tab — still running the previous release — has not
 * heard of. IndexedDB then asks that older connection to close, and if it does
 * not, the new open stays `blocked` until it does. The first release had no
 * answer to that request, so with a memoised promise the whole module would
 * wait on a tab the reader may never revisit: Review would wedge after its
 * first grade and the offline feed would render nothing at all. Three
 * callbacks close that off:
 *
 *   blocked    an older tab will not yield. Answer `null` now — no store — and
 *              if the tab does go away later, the open completes and the
 *              connection is taken up for whoever calls next, without a reload.
 *   blocking   a newer tab wants in. Close this connection, synchronously,
 *              inside the `versionchange` event, so the newer open never even
 *              sees `blocked`; and drop the memo so the next call reopens. If
 *              this tab's code is too old to open what the newer one made, that
 *              reopen rejects, and a rejection is what a missing store already
 *              looks like to every caller — the page is one the PWA is already
 *              replacing.
 *   terminated the browser closed the connection on its own. Drop the memo so
 *              the next call reopens rather than using a dead handle.
 */
function open(): Promise<Handle> {
  return new Promise<Handle>((resolve, reject) => {
    let yielded = false;
    openDB<WapDB>('what-a-pull', SCHEMA_VERSION, {
      async upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion < 2) {
          /*
           * Dropped, not migrated. A v1 row is a feed row and a timestamp; nothing
           * in it says which account fetched it, and guessing "the current one"
           * would attribute a previous reader's feed to whoever upgraded. Losing a
           * page of cache costs one refetch; keeping it wrong costs the property
           * this version exists to establish.
           */
          if (database.objectStoreNames.contains('pulls')) database.deleteObjectStore('pulls');
          database.createObjectStore('pulls', { keyPath: 'key' }).createIndex('by-user', 'userId');
          database
            .createObjectStore('reviewPack', { keyPath: 'key' })
            .createIndex('by-user', 'userId');
        }
        if (!database.objectStoreNames.contains('pending')) {
          database.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
        } else if (oldVersion < 2) {
          // Aborted by hand on failure, because `idb` does not await this
          // callback -- it calls `upgrade(...)` and discards the promise
          // (`idb@8` build/index.js:171-173). So an `async upgrade` that
          // rejects never touches the versionchange transaction: it commits,
          // `openDB` resolves, and the rejection escapes to `window` as an
          // unhandled rejection while the store sits permanently half-stamped
          // and every caller is told the upgrade succeeded. Reachable without
          // a bug in here: `crypto.randomUUID` is undefined in a non-secure
          // context, and a versionchange transaction that commits before the
          // cursor walk finishes raises `TransactionInactiveError`.
          //
          // Aborting instead means the version bump does not land, `openDB`
          // rejects, and the next open tries the whole thing again from v1 --
          // which is what "commits with the schema or not at all" was always
          // supposed to mean.
          try {
            await stampQueuedGrades(transaction);
          } catch {
            // Aborted rather than rethrown, and both halves matter.
            //
            // `transaction.done` rejects with `AbortError` the moment the abort
            // lands and nothing in `idb`'s upgrade path awaits it, so it is
            // claimed here rather than left to surface on `window`. And the
            // original error is NOT rethrown, for the same reason this block
            // exists at all: `idb` discards whatever this callback returns, so a
            // throw becomes a second unhandled rejection and changes nothing.
            // The abort is the mechanism — it fails the version bump, `openDB`
            // rejects with `AbortError`, `db()` drops the memo, and the next
            // open tries the whole upgrade again from v1.
            transaction.done.catch(() => undefined);
            transaction.abort();
          }
        }
      },
      blocked() {
        yielded = true;
        resolve(null);
      },
      blocking() {
        live?.close();
        live = null;
        dbPromise = null;
      },
      terminated() {
        live = null;
        dbPromise = null;
      },
    }).then(
      (database) => {
        live = database;
        if (yielded) dbPromise = Promise.resolve(database);
        else resolve(database);
      },
      (error: unknown) => {
        if (yielded) {
          // The `blocked` path already answered `null`, so there is nobody left
          // to reject to -- but the memo is a promise resolved to `null`, and
          // the success path above is the only thing that ever replaced it. A
          // tab whose open both blocked AND then failed (an older tab holding a
          // connection, then a newer one raising the version past this build)
          // would answer "no store" for the rest of its life, never retrying
          // even after the blocker closed. Clearing it makes the next call
          // reopen, which is what `terminated` and `blocking` already do.
          dbPromise = null;
          return;
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Give every queued grade from before version 2 the mutation id it was queued
 * without.
 *
 * A `recall` entry replays whenever its response was lost, and `grade_recall`
 * applies each replay it receives. The id is what will let the server tell a
 * replay from a new grade; minting it here, once, at upgrade, means an entry
 * queued by the old code replays under one stable id from now on rather than
 * being the one write in the store that still cannot be recognised. Done inside
 * the upgrade transaction so it commits with the schema or not at all.
 *
 * `submittedAt` is taken from the entry's own `at` — the moment the write was
 * queued, which is the moment the reader answered — and not from the clock at
 * upgrade. The server orders a late replay against the reader's current state
 * by this value, so stamping it with the upgrade time would tell it a grade
 * from three days offline had just been given.
 *
 * It backfills what is already on disk and nothing more. Grades queued after
 * this upgrade arrive without an id until 1b changes the screens that queue
 * them, and nothing carries the id to the RPC until 1b does that either — so
 * this does not yet close the double-apply hazard, it makes the entries that
 * predate the fix ready for it.
 */
async function stampQueuedGrades(
  transaction: IDBPTransaction<WapDB, StoreNames<WapDB>[], 'versionchange'>,
): Promise<void> {
  let cursor = await transaction.objectStore('pending').openCursor();
  while (cursor) {
    const entry = cursor.value;
    if (entry.kind === 'recall' && !entry.mutationId) {
      await cursor.update({
        ...entry,
        mutationId: globalThis.crypto.randomUUID(),
        submittedAt: entry.submittedAt ?? entry.at ?? Date.now(),
      });
    }
    cursor = await cursor.continue();
  }
}

/** One key per reader per row, for both stores. Ids are uuids, so the colon is unambiguous. */
function scopedKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

/**
 * Best-effort throughout: storage can be unavailable (private windows, blocked
 * site data, a tab that will not yield), and reading must never fail because
 * caching did.
 *
 * `userId` is the account the rows were fetched for, and `null` means there is
 * none — a signed-out visitor has no feed and nothing to scope a copy to, so
 * nothing is written rather than something written to nobody.
 */
export async function cachePulls(userId: string | null, rows: FeedRow[]): Promise<void> {
  if (!userId) return;
  try {
    const database = await db();
    if (!database) return;
    const tx = database.transaction('pulls', 'readwrite');
    const cachedAt = Date.now();
    await Promise.all(
      rows.map((r) => tx.store.put({ ...r, key: scopedKey(userId, r.id), userId, cachedAt })),
    );
    await tx.done;
  } catch {
    /* offline caching is an enhancement, never a requirement */
  }
}

/** This account's cached rows, newest first — and only this account's. */
export async function readCachedPulls(userId: string | null, limit = 20): Promise<FeedRow[]> {
  if (!userId) return [];
  try {
    const database = await db();
    if (!database) return [];
    const mine = await database.getAllFromIndex('pulls', 'by-user', userId);
    return mine
      .sort((a, b) => b.cachedAt - a.cachedAt)
      .slice(0, limit)
      .map(({ key: _key, userId: _userId, cachedAt: _cachedAt, ...row }) => row);
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------------
 * The review pack
 * -------------------------------------------------------------------------- */

/** What is on the device to practise from, and when it was fetched. */
export interface ReviewPack {
  items: DueReview[];
  syncedAt: number;
}

/**
 * Replace this account's pack with what the server just returned.
 *
 * Replace, not merge: the pack is a copy of "what is due", and a card the
 * server no longer lists — graded elsewhere, or no longer due — must leave the
 * device too, or offline practice would keep asking questions the model has
 * already moved on from. Answers whether the copy is actually on disk, for the
 * screen that tells the reader "N ideas ready offline".
 */
export async function storeReviewPack(
  userId: string,
  items: readonly DueReview[],
  syncedAt = Date.now(),
): Promise<boolean> {
  try {
    const database = await db();
    if (!database) return false;
    const tx = database.transaction('reviewPack', 'readwrite');
    const stale = await tx.store.index('by-user').getAllKeys(userId);
    await Promise.all(stale.map((key) => tx.store.delete(key)));
    await Promise.all(
      items.map((item) =>
        tx.store.put({
          key: scopedKey(userId, item.pullId),
          userId,
          pullId: item.pullId,
          item,
          syncedAt,
        }),
      ),
    );
    await tx.done;
    return true;
  } catch {
    return false;
  }
}

/**
 * This account's pack, in the order the server would have asked — weakest
 * memory first, which is how `get_due_reviews` orders it. The index returns
 * rows by key, so the order is restored here rather than trusted. `null` when
 * nothing is downloaded, which includes a pack the reader has worked through
 * to the end: that is the state a screen offers a fresh download from.
 */
/**
 * Enough of a `DueReview` to render and to order by.
 *
 * The entry is stored whole precisely so its shape can drift, which makes a pack
 * written by an older build the expected case rather than a corruption. An entry
 * missing `retrievability` makes the comparator below `NaN` and the promised
 * "weakest memory first" order arbitrary; one missing `headline` reaches the
 * screen as `undefined`. Dropping it costs the reader one card they can fetch
 * again; keeping it costs them a wrong order and a blank.
 */
function isDueReview(item: unknown): item is DueReview {
  if (typeof item !== 'object' || item === null) return false;
  const row = item as Partial<DueReview>;
  return (
    typeof row.pullId === 'string' &&
    typeof row.headline === 'string' &&
    typeof row.retrievability === 'number' &&
    Number.isFinite(row.retrievability)
  );
}

export async function readReviewPack(userId: string): Promise<ReviewPack | null> {
  try {
    const database = await db();
    if (!database) return null;
    const entries = (await database.getAllFromIndex('reviewPack', 'by-user', userId)).filter(
      (entry) => isDueReview(entry.item),
    );
    if (entries.length === 0) return null;
    const items = entries
      .sort(
        (a, b) => a.item.retrievability - b.item.retrievability || a.pullId.localeCompare(b.pullId),
      )
      .map((e) => e.item);
    return { items, syncedAt: Math.max(...entries.map((e) => e.syncedAt)) };
  } catch {
    return null;
  }
}

/** A card answered offline leaves the pack, so it is not asked twice before the next sync. */
export async function removeFromPack(userId: string, pullId: string): Promise<void> {
  try {
    const database = await db();
    if (!database) return;
    await database.delete('reviewPack', scopedKey(userId, pullId));
  } catch {
    /* best effort, as above */
  }
}

/** Everything this account downloaded — and nothing another account did. */
export async function clearReviewPack(userId: string): Promise<void> {
  try {
    const database = await db();
    if (!database) return;
    const tx = database.transaction('reviewPack', 'readwrite');
    const keys = await tx.store.index('by-user').getAllKeys(userId);
    await Promise.all(keys.map((key) => tx.store.delete(key)));
    await tx.done;
  } catch {
    /* best effort, as above */
  }
}

/**
 * Anyone waiting to hear that something was queued.
 *
 * A write can fail while `navigator.onLine` is still true — a 500, a timeout, a
 * server that is up but unwell. No `online` event follows, because connectivity
 * never changed, so without this the entry would sit until a reload or an
 * unrelated network transition. The listener is how a retry gets scheduled.
 */
const queuedListeners = new Set<() => void>();

export function onPendingQueued(handler: () => void): () => void {
  queuedListeners.add(handler);
  return () => {
    queuedListeners.delete(handler);
  };
}

/**
 * Queue a write for the next drain. Answers whether it was actually persisted.
 *
 * The failure is still swallowed — a caller mid-gesture has nothing useful to do about a
 * dead IndexedDB, and throwing here would turn a lost write into a broken screen. What
 * changed is that it no longer *reports* success it did not achieve. Most callers ignore
 * the answer, which is right for them; the one that tells the reader their answer was
 * recorded needs to know the difference, because in a browser with site data blocked the
 * write reached neither Postgres nor IndexedDB and 'recorded' was untrue.
 */
export async function queueMutation(userId: string, write: PendingWrite): Promise<boolean> {
  try {
    const database = await db();
    if (!database) return false;
    await database.add('pending', { ...write, userId, at: Date.now() });
  } catch {
    /* Lost, which is the honest outcome — and now the honest return value too. */
    return false;
  }
  for (const listener of queuedListeners) listener();
  return true;
}

/**
/** Whether this account still has queued writes — the signal to keep retrying. */
export async function hasPending(userId: string): Promise<boolean> {
  try {
    const database = await db();
    // AN UNAVAILABLE STORE IS NOT AN EMPTY ONE, and this is the one place the
    // difference decides a policy. `Feed.tsx` uses this to decide whether to
    // keep the drain timer alive; answering `false` while the store is merely
    // blocked -- an older tab holding the previous version open, which THIS
    // release makes reachable for the first time, since it is the store's first
    // version bump -- resets the backoff and schedules no retry, so a queue that
    // really is on disk sits undrained until a reload. Answering `true` costs
    // one more scheduled attempt that finds nothing.
    if (!database) return true;
    return (await database.getAll('pending')).some((item) => item.userId === userId);
  } catch {
    return true;
  }
}

/**
 * Drain queued writes, oldest first.
 *
 * Ordering only has to hold *per subject* — per pull, per saved item, per
 * collection. Replaying a save after a later unsave would resurrect something
 * the reader removed, and replaying a stash create after the delete that
 * followed it would bring back a collection they threw away; but a stuck write
 * for one subject says nothing about another. So a failure blocks only that
 * subject's remaining writes and the drain continues elsewhere — otherwise one
 * permanently invalid item (a save for a pull deleted while offline, say) would
 * wedge the queue for everything, forever. `writeScope` names the subject.
 */
// Keyed by user, not global. A single shared promise meant that if the account
// changed mid-drain, the new account's mount-time call would await the previous
// account's work — which filters to the *old* user's entries — and then never
// retry, leaving the new account's writes pending until the next reconnect.
const inFlight = new Map<string, Promise<number>>();

export function drainPending(
  userId: string,
  apply: (m: PendingWrite) => Promise<void>,
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
  apply: (m: PendingWrite) => Promise<void>,
  isStillCurrent: () => boolean,
): Promise<number> {
  let drained = 0;
  const blocked = new Set<string>();
  try {
    const database = await db();
    if (!database) return drained;
    const items = (await database.getAll('pending'))
      // Only this account's writes. Another user's stay queued for them.
      .filter((item) => item.userId === userId)
      .sort((a, b) => a.at - b.at);
    // Collections this pass may still create. A write that points at one of them
    // can fail its foreign key today and succeed tomorrow -- see `refusedForGood`.
    const queuedStashes = new Set(
      items.flatMap((item) => (item.kind === 'stash-create' ? [item.stashId] : [])),
    );
    for (const item of items) {
      // Re-check between every item, not just at the start: signing out
      // mid-drain must stop the remaining writes rather than attribute them to
      // whoever signs in next. The entries stay queued for their real owner.
      if (!isStillCurrent()) break;
      // Project rather than forward the row: `id`, `userId` and `at` are
      // bookkeeping for this queue, not part of the write being replayed.
      const { id: _id, userId: _userId, at: _at, ...write } = item;
      const scope = writeScope(write);
      if (blocked.has(scope)) continue;
      try {
        await apply(write);
      } catch (error) {
        // A refusal that will not change on a retry -- the row is gone -- is
        // dropped rather than kept: kept, it holds `hasPending` true and the retry
        // timer alive for the life of the tab. The subject is not blocked, so a
        // later write for it is judged on its own; it will most likely be dropped
        // for the same reason, which is the right outcome for a save-then-unsave
        // of a pull that no longer exists. Everything else is kept, and the rest
        // of this subject's writes are skipped to preserve their relative order
        // for the next attempt.
        //
        // Only in a pass where nothing was held back. A write blocked earlier in
        // this drain may be the one this write depends on -- the collection it
        // moves a save into, say -- and a foreign key it fails today is one it
        // passes once that lands. Dropping is deferred to a pass that can tell.
        if (blocked.size === 0 && refusedForGood(error, write, queuedStashes)) {
          console.warn('[offline] dropping a queued write the server refused for good', {
            kind: write.kind,
            scope,
            error: error instanceof Error ? error.message : String(error),
          });
          if (item.id !== undefined) await database.delete('pending', item.id);
          continue;
        }
        blocked.add(scope);
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

/**
 * Is this refusal final for this write?
 *
 * `isPermanentFailure` says whether the SQLSTATE is one Postgres uses for a
 * request it can never satisfy. Whether that is true of *this* request depends on
 * what the request was, and two kinds of write can carry one of those codes
 * transiently:
 *
 *   23503 on a collection write. `stash-create` names a parent and `organise` a
 *   destination, and either may be a collection this same drain is still about
 *   to create -- the parent was queued first and the drain runs oldest first, but
 *   a transport failure on the parent blocks only the parent's scope, so the child
 *   is attempted anyway and refused. It stays queued while its target is queued,
 *   and is dropped only when the target is nowhere: not queued, and not on the
 *   server.
 *
 * Everything else is what the codes were listed for: a pull that is gone is gone,
 * and no later pass brings it back. A check violation is dropped too, and on text
 * the reader composed that is a loss -- but a kept write blocks its scope on every
 * pass and holds the timer alive for the life of the tab, which is the failure this
 * whole classification exists to end. The honest fix is not to let the text get
 * that long: the inputs are bounded to the columns' limits in the components.
 */
function refusedForGood(error: unknown, write: PendingWrite, queuedStashes: Set<string>): boolean {
  if (!isPermanentFailure(error)) return false;
  const code = sqlState(error);
  if (code === '23503') {
    if (write.kind === 'stash-create') {
      return write.parentId === null || !queuedStashes.has(write.parentId);
    }
    if (write.kind === 'organise') {
      const target = write.patch.stashId;
      return typeof target !== 'string' || !queuedStashes.has(target);
    }
  }
  return true;
}

export function onReconnect(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}

/**
 * Was this failure the network, or the server?
 *
 * The feed's catch used to fall back to cache whenever the cache had anything, and set
 * `offline` regardless of why the fetch failed. So a 500, an expired JWT or an RLS
 * misconfiguration all rendered "Offline — reading from your downloaded copies" over
 * stale content, on a connection that was plainly working. That is not merely an
 * unhelpful message: it is a confident wrong diagnosis, and it hides exactly the class
 * of failure worth hearing about in the first week of use.
 *
 * Three signals, and the third is the one that actually fires in practice:
 *
 *   navigator.onLine === false   the browser is certain there is no network. Trusted
 *                                only in this direction — `true` means "an interface
 *                                is up", which is not the same as reachable, so it is
 *                                never used to prove the opposite.
 *   error instanceof TypeError   what `fetch` rejects with directly. Real for a bare
 *                                fetch; almost never seen through supabase-js.
 *   name === TRANSPORT_ERROR     the same failure after postgrest-js has caught it.
 *
 * That third case is the important one and it was missing. postgrest-js does not let
 * a fetch rejection propagate: it resolves with an error object instead, so by the
 * time this is called the `TypeError` is a string inside a message and `instanceof`
 * can never match. Checking only the first two conditions meant a reader on hotel
 * wifi or a dropped VPN — interface up, requests failing — was shown an error while
 * their downloaded Pulls sat unread in IndexedDB. That is a law 3 promise broken in
 * exactly the situation offline reading exists for.
 *
 * Anything else is the server's problem, and should reach the reader as an error they
 * can retry rather than as a shrug about connectivity.
 */
export function isOfflineFailure(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (error instanceof TypeError) return true;
  return error instanceof Error && error.name === TRANSPORT_ERROR;
}

/**
 * Keep a write the network lost; surface anything the server refused.
 *
 * The two failures look identical at the call site and mean opposite things. A
 * PATCH that never left the device is a change the reader made and still wants,
 * so it belongs in the queue and the screen should carry on as if it landed. A
 * 500, an expired JWT or an RLS refusal is a real failure: the write may already
 * have applied, the local state may now be a lie, and the reader has to hear
 * about it.
 *
 * Returns whether this was an offline failure that has been taken off the caller's
 * hands — NOT whether the write reached the store. It answers `true` for a write
 * `queueMutation` could not persist, deliberately: see the note on the return below.
 * Callers that answer a failure by reloading must ask this first — reloading offline
 * replaces a working screen with a dead end, and that is precisely the reload worth
 * not doing. A caller that needs to know the write is really on disk calls
 * `queueMutation` directly.
 */
export async function queueIfOffline(
  userId: string,
  error: unknown,
  write: PendingWrite,
): Promise<boolean> {
  if (!isOfflineFailure(error)) return false;
  /*
   * Deliberately NOT propagating `queueMutation`'s answer.
   *
   * The two functions answer different questions. `queueMutation` says whether the write
   * is on disk, which is what a caller telling the reader "recorded" needs. This says
   * whether the failure was an offline one that has been taken off the caller's hands —
   * which is what its callers actually branch on, and all three of them reload the screen
   * when it is false.
   *
   * Propagating persistence collapsed those into one value, and a dead IndexedDB then
   * read as "the server refused this". A reader with site data blocked, moving a kept
   * Pull into a collection in a tunnel, had their whole Library replaced by the error
   * screen — the exact dead end `Library.tsx` and `queueMutation` above both say must not
   * happen, and worse than the silent loss it replaced. A caller that needs the stronger
   * answer calls `queueMutation` directly, as `KnowledgeCensus` does.
   */
  await queueMutation(userId, write);
  return true;
}
