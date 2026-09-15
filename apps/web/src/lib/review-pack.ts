/**
 * Practising from a downloaded copy — the arithmetic, with no IndexedDB in it.
 *
 * `lib/offline.ts` owns the store: `storeReviewPack`, `readReviewPack`,
 * `removeFromPack`. What it cannot own is the three questions the SCREEN has to
 * answer, each of which is a decision rather than a lookup:
 *
 *   * What is left to practise, given what this session has already answered and
 *     what is still queued on the device from an earlier one.
 *   * How old the copy is, in words a reader can act on.
 *   * Whether it is old enough to be worth saying so.
 *
 * Pure and here, for the reason `lib/library.ts` is pure and there: a wrong
 * answer to any of the three is ordinary logic, and ordinary logic should be
 * testable without a browser or a database.
 */

import type { DueReview } from './types.js';

/**
 * When a downloaded pack stops being a good description of what is due.
 *
 * A day, because the schedule moves on a daily granularity: `grade_recall` pushes
 * `next_due_at` out by whole days, and a Daily Pull is a day's worth. A pack from
 * this morning is still what the server would send; one from last week is a list
 * of questions the model has since answered differently.
 *
 * It is never a reason to refuse to practise. A stale pack is better than no
 * practice, so this only decides whether the reader is TOLD.
 */
export const PACK_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isStale(syncedAt: number, now: number = Date.now()): boolean {
  return now - syncedAt >= PACK_STALE_AFTER_MS;
}

/**
 * What is left of a downloaded pack.
 *
 * `answered` is every pull this device has an answer for that the server has not
 * necessarily seen — cards graded in this session, and cards still sitting in the
 * offline queue from a previous one. Both have to go, and for the same reason: a
 * pack is a copy of "what is due" taken at one moment, and asking a question the
 * reader has already answered is the one thing offline practice must not do. It
 * would also grade twice, which `recall_events` deduplicates on the mutation id
 * but which the reader would have to sit through regardless.
 *
 * The order is the pack's own — weakest memory first, as `readReviewPack`
 * restores it — rather than re-sorted here. Filtering never reorders.
 */
export function mergePack(pack: readonly DueReview[], answered: ReadonlySet<string>): DueReview[] {
  return pack.filter((item) => !answered.has(item.pullId));
}

/**
 * How long ago the copy was taken, in a reader's words.
 *
 * Coarse on purpose, and it rounds DOWN. "Synced 2 hours ago" over a copy taken
 * 119 minutes ago is right; over one taken 61 minutes ago it is a small lie about
 * the freshness of the thing the reader is about to trust, and this string exists
 * precisely so they can judge that.
 */
export function syncedLabel(syncedAt: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - syncedAt);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * What the download control says about itself.
 *
 * Three states, and the empty one names what pressing the button would get rather
 * than only reporting an absence — an offer, not a status line.
 */
export function packLabel(
  count: number,
  syncedAt: number | null,
  now: number = Date.now(),
): string {
  if (syncedAt === null || count === 0) {
    return 'Nothing downloaded yet. Take today’s practice with you and answer it offline.';
  }
  const stale = isStale(syncedAt, now) ? ' · this copy is over a day old' : '';
  return `${count} ${count === 1 ? 'idea' : 'ideas'} ready offline · synced ${syncedLabel(syncedAt, now)}${stale}`;
}

/** The banner shown while a session is being answered from the device rather than the server. */
export function practisingLabel(syncedAt: number, now: number = Date.now()): string {
  return `Practising from your downloaded copy · last synced ${syncedLabel(syncedAt, now)}`;
}
