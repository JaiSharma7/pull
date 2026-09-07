import type { AnkiQuestion, ReviewEvent } from './export-formats.js';
import {
  ankiDeck,
  reviewEvents,
  type QuizQuestionRow,
  type RecallEventRow,
  type SavedPullRow,
  type UserQuestionRow,
} from './export-rows.js';
import type { Highlight } from './highlights.js';
import { fetchHighlights } from './highlights-api.js';
import { pageAfter } from './paging.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * The reads behind the two exports 7d adds, and nothing else.
 *
 * Every shaping decision lives in `export-rows.ts`, which imports nothing that
 * reaches the network, and every byte of the files themselves is written by
 * `export-formats.ts`. What is left here is queries — which is the part that
 * cannot be unit-tested against this repo's `environment: 'node'` suite anyway,
 * and so is the part worth keeping thin.
 *
 * No migration and no new RPC. Both exports are plain selects through the same
 * RLS every other read in the app goes through, which is the posture
 * `buildAccountExport` argues for at length: "a reader can only export
 * themselves" is a property the database already enforces, and a second place
 * for that rule is a second place for it to be wrong.
 */

/**
 * How many pull ids go into one `in` filter.
 *
 * PostgREST takes its filters in the query string, so a list of uuids is roughly
 * 39 bytes of URL each. A collection is unbounded — law 3 makes stashing
 * unlimited on purpose — so a reader with a few thousand saves in one collection
 * would build a URL past what proxies and Postgres' own line limits accept, and
 * the export would fail for exactly the readers who have most to export.
 */
const ID_CHUNK = 100;

function chunked<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * The reader's highlights on a given set of Pulls, keyed by Pull.
 *
 * `fetchHighlights` already pages and shapes; this adds the chunking it does not
 * do — it is called elsewhere with one screen's worth of ids — and the grouping
 * the CSV needs. Chunks are fetched in sequence rather than at once: an export is
 * not a screen a reader is waiting to interact with, and forty parallel requests
 * from one tab is how a rate limiter learns about us.
 */
export async function fetchHighlightsByPull(
  userId: string,
  pullIds: readonly string[],
): Promise<Map<string, Highlight[]>> {
  const byPull = new Map<string, Highlight[]>();
  for (const chunk of chunked([...new Set(pullIds)], ID_CHUNK)) {
    for (const h of await fetchHighlights(userId, chunk)) {
      const list = byPull.get(h.pullId);
      if (list) list.push(h);
      else byPull.set(h.pullId, [h]);
    }
  }
  return byPull;
}

/* --------------------------------------------------------------------------
 * The deck
 * -------------------------------------------------------------------------- */

type SavedRow = {
  pull_id: string | null;
  pulls: {
    id: string;
    quiz_questions: QuizQuestionRow[] | null;
    summaries: { works: { title: string } | null } | null;
  } | null;
};

type OwnRow = UserQuestionRow & {
  pulls: { summaries: { works: { title: string } | null } | null } | null;
};

export interface AnkiDeck {
  questions: AnkiQuestion[];
  history: ReviewEvent[];
}

/**
 * Every question the reader could be asked, with what happened when they were.
 *
 * Three walks, and the asymmetry between the first two is deliberate. Canonical
 * questions are the product's, so the deck carries them only for ideas the
 * reader kept — `quiz_questions` embedded under `saved_items`, which is one walk
 * instead of a second query keyed by an unbounded list of ids. Their own
 * questions are theirs wherever they wrote them, so those are taken for the
 * whole account, saved or not.
 *
 * Retired questions are left out. `user_questions.retired_at` is documented as
 * "set when the reader stops wanting to be asked this", and writing one into a
 * deck they are about to study is asking it again. They are not lost: they are
 * the reader's writing, they are kept in the table, and `buildAccountExport`
 * carries every row of `user_questions` into the JSON export.
 *
 * The history is every `recall_events` row rather than only those naming a
 * question, because that is what `summariseHistory` needs: a free-recall grade
 * names no question and counts towards each of its Pull's, which is how a reader
 * who has been reviewing since before they wrote a question gets a deck that
 * knows it.
 */
export async function fetchAnkiDeck(userId: string): Promise<AnkiDeck> {
  /*
   * KEYSET, NOT OFFSET, on all three walks below.
   *
   * Review finding, and `buildAccountExport` had already measured it: `.range(from, to)`
   * is `LIMIT/OFFSET`, and an insertion or deletion in another tab mid-export shifts
   * every later page, so the deck silently carries one row twice and omits another. An
   * export is exactly where that happens, because it runs long enough for a write to land
   * underneath it. `id` is the cursor on each: unique within one reader's rows, so it is
   * both a total order and something to ask for what sorts after.
   */
  const savedRows = await pageAfter<SavedRow & Record<string, unknown>>((after, limit) => {
    let q = supabase
      .from('saved_items')
      .select(
        'id, pull_id, pulls(id, quiz_questions(id, pull_id, kind, prompt, answer, distractors), summaries(works(title)))',
      )
      .eq('user_id', userId)
      .not('pull_id', 'is', null)
      .order('id', { ascending: true })
      .limit(limit);
    if (after !== null) q = q.gt('id', after);
    return q;
  }, 'id').catch((e: unknown) => {
    throw rpcError(e);
  });

  const ownRows = await pageAfter<OwnRow & Record<string, unknown>>((after, limit) => {
    let q = supabase
      .from('user_questions')
      .select('id, pull_id, kind, prompt, answer, options, pulls(summaries(works(title)))')
      .eq('user_id', userId)
      .is('retired_at', null)
      .order('id', { ascending: true })
      .limit(limit);
    if (after !== null) q = q.gt('id', after);
    return q;
  }, 'id').catch((e: unknown) => {
    throw rpcError(e);
  });

  /*
   * `kind` AND `submitted_at` ARE SELECTED BECAUSE `reviewEvents` NEEDS BOTH.
   *
   * Four of the seven `recall_events` kinds are not retrieval -- `conviction`,
   * `counterpull`, `delta_probe` and `calibration` -- and each carries a null question
   * id, which is the shape `summariseHistory` spreads across every question on the Pull.
   * And `applied_at` is when the row was written, not when the reader answered: a grade
   * queued offline lands late, and reading the wrong column makes the OLDER attempt the
   * `last:` tag. Both are filtered and resolved in `export-rows.ts`, where they can be
   * tested.
   */
  const eventRows = await pageAfter<RecallEventRow & { id: string } & Record<string, unknown>>(
    (after, limit) => {
      let q = supabase
        .from('recall_events')
        .select(
          'id, pull_id, quiz_question_id, user_question_id, kind, grade, applied_at, submitted_at',
        )
        .eq('user_id', userId)
        .order('id', { ascending: true })
        .limit(limit);
      if (after !== null) q = q.gt('id', after);
      return q;
    },
    'id',
  ).catch((e: unknown) => {
    throw rpcError(e);
  });

  const workTitleByPull = new Map<string, string | null>();
  const saved: SavedPullRow[] = [];
  for (const row of savedRows) {
    // A save whose Pull is gone is expected rather than corrupt — `fetchLibrary`
    // says the same of the same join — and there is nothing to revise about it.
    if (!row.pulls) continue;
    const workTitle = row.pulls.summaries?.works?.title ?? null;
    workTitleByPull.set(row.pulls.id, workTitle);
    saved.push({ pullId: row.pulls.id, workTitle, questions: row.pulls.quiz_questions ?? [] });
  }

  const own: UserQuestionRow[] = [];
  for (const row of ownRows) {
    const title = row.pulls?.summaries?.works?.title ?? null;
    // Only when the embed found one: a question on an unsaved Pull is the case
    // this fills in, and overwriting a title already known with a null would undo
    // the walk above.
    if (title !== null) workTitleByPull.set(row.pull_id, title);
    own.push(row);
  }

  return {
    questions: ankiDeck(saved, own, workTitleByPull),
    history: reviewEvents(eventRows),
  };
}
