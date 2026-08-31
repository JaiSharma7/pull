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
