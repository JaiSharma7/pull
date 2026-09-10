import {
  dedupeConfidentlyWrong,
  parseConfidentlyWrongRows,
  type ConfidentlyWrongItem,
} from './confidently-wrong.js';
import { pageAll } from './paging.js';
import { supabase } from './supabase.js';

export { CONFIDENTLY_WRONG_COPY, formatAttemptDate } from './confidently-wrong.js';
export type { ConfidentlyWrongItem } from './confidently-wrong.js';

/**
 * The ideas the reader was sure of and then missed, in the last `days` days, one per
 * idea, most recent first, at most `limit` of them.
 *
 * PAGED, THEN DEDUPLICATED, THEN CUT -- in that order. The first version took twenty
 * events from the server and deduplicated them here, so a reader confidently wrong five
 * times on each of four ideas saw four items in a list whose own copy calls them the
 * misconceptions worth repairing first. Repeated lapses are exactly this list's
 * population, and the cut has to come after the events have been folded into ideas.
 * `pageAll` walks the range because `max_rows = 100` is a silent cap, not an error (see
 * `paging.ts`); the walk is bounded by thirty days of one reader's own lapses.
 *
 * A failure is thrown, not swallowed into `[]`. The screen tells loading, failed and
 * "nothing in thirty days" apart, and it can only do that if the difference reaches it:
 * the first version returned an empty list on a network error, and the dashboard read
 * that as a clean record.
 */
export async function fetchConfidentlyWrong(
  userId: string | null,
  days = 30,
  limit = 20,
): Promise<ConfidentlyWrongItem[]> {
  if (!userId) return [];

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = await pageAll<unknown>((from, to) =>
    supabase
      .from('recall_events')
      .select(
        `
        id,
        pull_id,
        applied_at,
        pulls (
          id,
          headline,
          summaries (
            works (
              id,
              title
            )
          )
        )
      `,
      )
      .eq('confidence', 'sure')
      .eq('grade', 'forgot')
      .gte('applied_at', sinceIso)
      .order('applied_at', { ascending: false })
      // A total order, so the offset walk does not read a row twice across a page
      // boundary when two events share a timestamp.
      .order('id', { ascending: true })
      .range(from, to),
  );

  return dedupeConfidentlyWrong(parseConfidentlyWrongRows(rows)).slice(0, limit);
}
