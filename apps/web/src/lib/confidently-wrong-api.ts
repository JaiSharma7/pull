import {
  dedupeConfidentlyWrong,
  newestFirst,
  parseConfidentlyWrongRows,
  type ConfidentlyWrongItem,
} from './confidently-wrong.js';
import { pageAfter } from './paging.js';
import { supabase } from './supabase.js';

export { CONFIDENTLY_WRONG_COPY, formatAttemptDate } from './confidently-wrong.js';
export type { ConfidentlyWrongItem } from './confidently-wrong.js';

/**
 * The ideas the reader was sure of and then missed, in the last `days` days, one per
 * idea, most recent first, at most `limit` of them.
 *
 * WALKED, THEN ORDERED, THEN DEDUPLICATED, THEN CUT -- in that order. The first
 * version took twenty events from the server and deduplicated them here, so a reader
 * confidently wrong five times on each of four ideas saw four items in a list whose
 * own copy calls them the misconceptions worth repairing first. Repeated lapses are
 * exactly this list's population, and the cut has to come after the events have been
 * folded into ideas. The walk is bounded by thirty days of one reader's own lapses.
 *
 * KEYED ON `id`, NOT OFFSET (Codex finding). `pageAll` is LIMIT/OFFSET, and an offset
 * shifts under a concurrent write -- `paging.ts` says so, and `buildAccountExport`
 * measured it -- while this reader's other tab writes a `recall_events` row every
 * time they answer a question. A keyset walk on the primary key reads nothing twice
 * and skips nothing that was there when it began; a row written during the walk may
 * be missed, which is the honest outcome for an event that did not yet exist. `id`
 * is a uuid, so the walk is in no useful order: `newestFirst` orders the rows once
 * they are all in hand, and `dedupeConfidentlyWrong` then keeps the newest per idea.
 *
 * A failure is thrown, not swallowed into `[]`. The screen tells loading, failed and
 * "nothing in thirty days" apart, and it can only do that if the difference reaches
 * it: the first version returned an empty list on a network error, and the dashboard
 * read that as a clean record.
 */
export async function fetchConfidentlyWrong(
  userId: string | null,
  days = 30,
  limit = 20,
): Promise<ConfidentlyWrongItem[]> {
  if (!userId) return [];

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = await pageAfter<{ id: string }>((after, pageSize) => {
    const query = supabase
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
      .order('id', { ascending: true })
      .limit(pageSize);
    return after === null ? query : query.gt('id', String(after));
  }, 'id');

  return dedupeConfidentlyWrong(newestFirst(parseConfidentlyWrongRows(rows))).slice(0, limit);
}
