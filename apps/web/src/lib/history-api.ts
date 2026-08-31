import { cursorFrom, type HistoryCursor, type HistoryEntry } from './history.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * Unlimited history, free forever (CLAUDE.md law 3).
 *
 * `history_events` is written by the read path and read by nobody — the Colophon has
 * been telling every reader "Audio, offline, history, stashes and Daily Pulls are free
 * permanently" over a promise with no surface at all. A claim with no screen behind it
 * is a claim, not a feature.
 *
 * Affordable by design rather than by subsidy: these are rows in Postgres under an
 * owner-only RLS policy (`history_events_own`), so "unlimited" costs what storage
 * costs. No model runs here (law 2).
 */

/**
 * One page's worth.
 *
 * **PostgREST caps a response at `max_rows` (100)**, and history is the one list in
 * this app that genuinely grows without bound. Fifty keeps a page comfortably inside
 * that ceiling and makes the "is there more" probe cheap. An unpaged select would
 * silently stop at 100 rows and still call itself unlimited — the exact shape of
 * dishonesty this file exists to avoid.
 */
const PAGE_SIZE = 50;

/**
 * Columns enumerated, never `select('*')` on `works`.
 *
 * `20260831013500` dropped the table grant and re-granted every column except
 * `content_hash`, so a star select is a permission error rather than a leak.
 */
const HISTORY_COLUMNS =
  'id, kind, occurred_on, created_at, dwell_ms, ' +
  'pulls(id, headline, summaries(title, works(id, title, kind, year)))';

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Whether another page exists, established by asking for one row more than needed. */
  hasMore: boolean;
  /** Where to resume. Null when this page was empty. */
  cursor: HistoryCursor | null;
}

interface HistoryRow {
  id: number;
  kind: string;
  occurred_on: string;
  created_at: string;
  dwell_ms: number | null;
  pulls: {
    id: string;
    headline: string;
    summaries: {
      title: string | null;
      works: { id: string; title: string; kind: string; year: number | null } | null;
    } | null;
  } | null;
}

/**
 * A reader's own history, newest first.
 *
 * No `user_id` filter: `history_events_own` already scopes this to `auth.uid()`, and
 * a second client-side filter would be a claim about correctness that RLS is the only
 * thing actually enforcing. Filtering here would also hide the failure if the policy
 * were ever wrong, which is the opposite of useful.
 *
 * **Keyset, not offset.** The first version took a page number, and offset pagination
 * assumes the set does not move under it. This one provably does: the read path writes
 * a history row every time the reader meets an idea, ordering is newest-first, so every
 * insert lands above the offset and shifts the rest down — page two then repeats page
 * one's last entry. Asking for "everything strictly after this exact row" cannot repeat
 * or skip, however much arrives in between.
 *
 * The `or` filter is the tuple comparison `(occurred_on, created_at, id) < (…)` spelled
 * out, because PostgREST has no row-value syntax. It must stay in lockstep with the
 * `order` below — a cursor that compares on different columns than the sort is a
 * silent, intermittent wrong answer.
 *
 * `hasMore` comes from requesting one row more than needed rather than a count query,
 * which would get slower exactly as the feature got more valuable.
 */
export async function fetchHistoryPage(cursor: HistoryCursor | null = null): Promise<HistoryPage> {
  let query = supabase.from('history_events').select(HISTORY_COLUMNS);

  if (cursor) {
    const { occurredOn: d, createdAt: c, id } = cursor;
    // Timestamps are double-quoted: `created_at` carries `+00:00` and `:`, and an
    // unquoted value inside `or(...)` is parsed against PostgREST's own grammar.
    query = query.or(
      [
        `occurred_on.lt.${d}`,
        `and(occurred_on.eq.${d},created_at.lt."${c}")`,
        `and(occurred_on.eq.${d},created_at.eq."${c}",id.lt.${id})`,
      ].join(','),
    );
  }

  const { data, error } = await query
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE + 1);
  if (error) throw rpcError(error);

  const rows = (data ?? []) as unknown as HistoryRow[];
  const hasMore = rows.length > PAGE_SIZE;

  // Sliced before shaping, so the cursor is taken from the last row actually shown.
  // Taking it from a row that was dropped as unreadable would skip everything between.
  const page = rows.slice(0, PAGE_SIZE);
  const entries = page.flatMap((r) => {
    const pull = r.pulls;
    const work = pull?.summaries?.works;
    // A row whose pull or work is no longer readable is dropped rather than rendered
    // as a blank line. The event is real, but "you read something, and we cannot say
    // what" is not worth a row on the reader's own record.
    if (!pull || !work) return [];
    return [
      {
        id: r.id,
        kind: r.kind,
        occurredOn: r.occurred_on,
        createdAt: r.created_at,
        dwellMs: r.dwell_ms,
        pullId: pull.id,
        headline: pull.headline,
        workId: work.id,
        workTitle: work.title,
        workKind: work.kind,
        workYear: work.year,
        summaryTitle: pull.summaries?.title ?? null,
      } satisfies HistoryEntry,
    ];
  });

  /*
   * The cursor comes from the last *fetched* row, not the last rendered one.
   *
   * Those differ whenever the tail of a page was dropped as unreadable, and resuming
   * from the last rendered entry would re-fetch every dropped row on the next page —
   * which drops them again, so the reader could never get past them.
   */
  const lastFetched = page[page.length - 1];
  return {
    entries,
    hasMore,
    cursor: lastFetched
      ? {
          occurredOn: lastFetched.occurred_on,
          createdAt: lastFetched.created_at,
          id: lastFetched.id,
        }
      : cursorFrom(entries),
  };
}
