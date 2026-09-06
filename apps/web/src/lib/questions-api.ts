/**
 * The network half of a reader's own questions.
 *
 * `lib/questions.ts` shapes and bounds; this sends. The split exists because this module
 * imports `lib/supabase.ts`, which throws at import under vitest.
 *
 * One RPC and two table reads. `remember_pull` is `security invoker` — everything it
 * writes is a row the reader already has a policy for, so RLS does the checking — while
 * the select and the update below go through `user_questions_read_own` and
 * `user_questions_update_own` directly.
 */

import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/** A question the reader wrote, as the Source page lists it back to them. */
export interface UserQuestion {
  id: string;
  pullId: string;
  kind: string;
  prompt: string;
  answer: string | null;
  createdAt: string;
}

export interface RememberedQuestion {
  questionId: string;
  /** False when a replay carrying an id already on record wrote nothing. */
  created: boolean;
}

/**
 * Write a question about an idea, and put the idea into review.
 *
 * `remember_pull` does three things in one transaction: the question, a
 * `knowledge_states` row if the idea is not already scheduled, and a `saved_items` row.
 * Writing a question about an idea is a claim to want it back, so it enters the
 * scheduler — tomorrow, at the default stability — while an idea already in review keeps
 * its own schedule, because being asked about is not evidence about when it should next
 * be asked.
 *
 * REPLAY-SAFE, and the mutation id is what makes it so. A second call carrying the same
 * id writes nothing and returns the first call's `questionId` with `created: false`, the
 * same shape `grade_recall` uses. So a retry after a timeout cannot leave a reader with
 * the same question twice.
 */
export async function rememberPull(
  pullId: string,
  args: { prompt: string; answer: string | null; kind: string; mutationId: string },
): Promise<RememberedQuestion> {
  const { data, error } = await supabase.rpc('remember_pull', {
    p_pull_id: pullId,
    p_prompt: args.prompt,
    // `as never` for the reason `commitImport` needs one: the generated types render a
    // parameter with no default as non-nullable, while the column it feeds is nullable
    // and `remember_pull` does `nullif(btrim(coalesce(p_answer, '')), '')` precisely so
    // a null may be sent.
    p_answer: args.answer as never,
    p_kind: args.kind,
    p_mutation_id: args.mutationId,
  });

  if (error) throw rpcError(error);
  return data as unknown as RememberedQuestion;
}

/**
 * The reader's own live questions across a set of ideas, newest first.
 *
 * Takes the whole page's pull ids rather than one, like `fetchHighlights` beside it: a
 * source with eighteen ideas would otherwise be eighteen round trips to draw one screen.
 *
 * `retired_at is null` because a retired question is one they have taken out of
 * rotation, not one they have deleted — `get_due_reviews` stops offering it and this
 * list stops showing it, but the row stays so the recall events filed against it keep
 * their referent.
 *
 * No `user_id` filter, and that is not an omission: `user_questions_read_own` is
 * `(select auth.uid()) = user_id`, so the policy has already refused every other
 * reader's rows before this query is planned. Adding the predicate would restate in the
 * client something the database is enforcing, and a restatement can drift.
 */
export async function fetchUserQuestions(pullIds: readonly string[]): Promise<UserQuestion[]> {
  if (pullIds.length === 0) return [];

  const { data, error } = await supabase
    .from('user_questions')
    .select('id, pull_id, kind, prompt, answer, created_at')
    .in('pull_id', pullIds as string[])
    .is('retired_at', null)
    // `id` after `created_at`, because `created_at` alone is not a total order. Two
    // questions written inside one transaction share it to the microsecond, and Postgres
    // may then return them either way round -- so a reader's own list would reorder
    // itself between two loads of the same page. `get_due_reviews` carries the same
    // tiebreak on the same column for the same reason.
    .order('created_at', { ascending: false })
    .order('id', { ascending: true });

  if (error) throw rpcError(error);
  return (data ?? []).map((r) => ({
    id: r.id,
    pullId: r.pull_id,
    kind: r.kind,
    prompt: r.prompt,
    answer: r.answer,
    createdAt: r.created_at,
  }));
}

/**
 * Take a question out of rotation without destroying it.
 *
 * Retired rather than deleted, and the difference is the reader's history:
 * `recall_events.user_question_id` points at this row, and deleting it would set those
 * references null — so every grade they ever gave that question would stop saying what
 * it was a grade OF. `user_questions_update_own` is what permits this.
 */
export async function retireQuestion(id: string): Promise<void> {
  const { error } = await supabase
    .from('user_questions')
    .update({ retired_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw rpcError(error);
}
