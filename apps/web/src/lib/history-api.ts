import type { HistoryEntry } from './history.js';
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
 * Ordered so the pages partition the set. `occurred_on` alone is not a total order —
 * a day holds many rows — and neither is `created_at` once two reads share a
 * millisecond, so `id` breaks the tie. Without a total order PostgREST may return the
 * same row on two pages and drop another entirely, and a history that quietly loses
 * entries is worse than one that stops.
 *
 * `hasMore` is established by requesting `PAGE_SIZE + 1` and discarding the extra,
 * rather than by a second count query: a count over an unbounded table gets slower
 * exactly as the feature gets more valuable.
 */
export async function fetchHistoryPage(page = 0): Promise<HistoryPage> {
  const from = page * PAGE_SIZE;
  const { data, error } = await supabase
    .from('history_events')
    .select(HISTORY_COLUMNS)
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + PAGE_SIZE);
  if (error) throw rpcError(error);

  const rows = (data ?? []) as unknown as HistoryRow[];
  const hasMore = rows.length > PAGE_SIZE;

  const entries = rows.slice(0, PAGE_SIZE).flatMap((r) => {
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

  return { entries, hasMore };
}
