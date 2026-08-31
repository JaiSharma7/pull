/**
 * History, minus the I/O.
 *
 * Pure and free of the Supabase client, so it can be tested at all: importing
 * `supabase.js` throws without `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`,
 * and the web app's vitest runs with neither. `lib/preferences.ts` and
 * `lib/preferences-api.ts` are split on exactly this line, as are `lib/routes.ts` and
 * `lib/feed-items.ts`.
 */

export interface HistoryEntry {
  id: number;
  /**
   * What happened.
   *
   * In practice always `'read'`: `record_read` is the only writer of `history_events`,
   * and it is idempotent per pull per UTC day. Saving and grading write to
   * `saved_pulls` and `knowledge_states` and leave no history row. Carried through
   * rather than assumed away, so the day a second kind starts being written this
   * screen shows it rather than mislabelling it.
   */
  kind: string;
  /** UTC calendar day — the generated column the per-day uniqueness is built on. */
  occurredOn: string;
  createdAt: string;
  dwellMs: number | null;
  pullId: string;
  headline: string;
  workId: string;
  workTitle: string;
  workKind: string;
  workYear: number | null;
  summaryTitle: string | null;
}

/**
 * Group entries into days, preserving the order they arrived in.
 *
 * A `Map`, not an object: a Map keeps insertion order for string keys, and the query
 * has already ordered these newest-first. Re-sorting here would be a second opinion
 * about ordering that could disagree with the one the pagination depends on.
 *
 * Days are matched by key rather than by "is this the same as the last one", so a page
 * boundary landing in the middle of a day cannot render that date twice.
 */
export function groupByDay(entries: HistoryEntry[]): { day: string; entries: HistoryEntry[] }[] {
  const days = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const bucket = days.get(entry.occurredOn);
    if (bucket) bucket.push(entry);
    else days.set(entry.occurredOn, [entry]);
  }
  return [...days].map(([day, dayEntries]) => ({ day, entries: dayEntries }));
}

/** A `Date` as the UTC calendar day Postgres would store, `YYYY-MM-DD`. */
function utcDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/**
 * `2026-08-31` → `Today`, `Yesterday`, or a written date.
 *
 * Compared in **UTC**, because that is what the day is. `occurred_on` is a stored
 * generated column computed as `(created_at at time zone 'UTC')::date`, and the first
 * version of this compared it against *local* midnight. For any reader whose date
 * differs from UTC's, that is wrong in a way that looks plausible: shortly after local
 * midnight in UTC+10, something read minutes ago carries the previous UTC date and was
 * labelled "Yesterday". A history that misdates what you did today is exactly the kind
 * of quiet wrongness this screen exists to avoid.
 *
 * Comparing the day strings settles it without any timezone arithmetic — two UTC days
 * are equal or they are not. The absolute date is rendered with `timeZone: 'UTC'` for
 * the same reason: it must name the day the row is filed under, not the day that
 * instant happens to fall on where the reader is sitting.
 *
 * `now` is injectable so this is testable without freezing the clock.
 */
export function formatHistoryDay(day: string, now: Date = new Date()): string {
  const today = utcDay(now);
  if (day === today) return 'Today';
  if (day === utcDay(new Date(now.getTime() - 86_400_000))) return 'Yesterday';

  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    // The year is noise within the current one and essential outside it.
    ...(String(y) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  });
}

/**
 * Where the last page ended, as a place in the ordering rather than a count.
 *
 * Offset pagination assumes the set does not move under it, and history is the one
 * list here that provably does: the read path writes a row every time the reader meets
 * an idea, and the ordering is newest-first, so every insert lands *above* the offset
 * and shifts everything down. Page two then repeats page one's last entry — and a
 * delete skips one instead. A deterministic sort does not fix that; it only guarantees
 * the shifted result is consistently shifted.
 *
 * All three parts are needed because all three are in the ORDER BY: `occurred_on` is
 * not unique across a day, `created_at` is not unique across a millisecond, and `id`
 * is the only thing that finally breaks the tie.
 */
export interface HistoryCursor {
  occurredOn: string;
  createdAt: string;
  id: number;
}

/** The cursor for the page after these entries, or null when there were none. */
export function cursorFrom(entries: HistoryEntry[]): HistoryCursor | null {
  const last = entries[entries.length - 1];
  if (!last) return null;
  return { occurredOn: last.occurredOn, createdAt: last.createdAt, id: last.id };
}
