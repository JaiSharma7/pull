import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';
import { isBudgetState, type BudgetState, type StudioJob, type StudioKind } from './studio.js';

export {
  budgetLine,
  fitImportSource,
  truncationNote,
  waitMinutes,
  checkSubmission,
  describeJob,
  isWorthPolling,
  POLL_MS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MIN_TEXT_CHARS,
  STUDIO_KIND_LABEL,
  STUDIO_KINDS,
  studioKindFor,
} from './studio.js';
export type { BudgetState, StudioJob, StudioKind, SubmitCheck } from './studio.js';

/**
 * The reader's books, and one book's highlights.
 *
 * Re-exported rather than reimplemented — nothing about either is Studio-specific.
 * `fetchImportedWorks` is what the picker needs (one row per book); the items are
 * fetched for the ONE book a reader picks, because their bodies are only wanted for
 * the text that is actually sent.
 */
export {
  fetchImportedItems as fetchImportedItemsForStudio,
  fetchImportedWorks,
} from './import-api.js';

/** What `enqueue_generation_job` answers with. */
export interface Enqueued {
  jobId: string;
  kind: string;
  queue: 'fast' | 'normal';
  delaySeconds: number;
  remainingToday: number;
  /** `open | low | spent`. Never the figures — see `generation_budget_state()`. */
  budget: BudgetState;
  /**
   * Set when this answer is a REPLAY — the mutation id named a job that already exists,
   * so nothing was queued and nothing was charged.
   */
  replayed?: boolean;
  /**
   * Set when that job is already over. `queue` and `delaySeconds` describe a place in a
   * queue, which a finished job does not have, so the screen must not read them: saying
   * "Started." above a job list that says it did not finish is the failure this field
   * exists to prevent.
   */
  finished?: boolean;
  /** The job's own status, present with `finished`. */
  status?: string;
}

/**
 * Ask for a private summary of the reader's own text.
 *
 * `visibility` IS NEVER SENT, and that is a boundary rather than a tidiness rule.
 * `generation_jobs.visibility` defaults to private and the pipeline reads the
 * column; the target jsonb is stored verbatim, so a key that looks like an
 * instruction has no business sitting in it. `enqueue_generation_job` strips it
 * anyway — belt and braces, in the direction that fails safe.
 *
 * `work_id` is sent only when the reader is generating from their own imported
 * book, and the server checks it: it survives into the target only if the caller
 * has authored a summary on that work, and `template` checks again against the row
 * at the moment of the write. Sending it is what makes an imported book gain a
 * summary rather than acquire a second `works` row.
 *
 * `rights_status` is `user_owned` because that is what it is: the reader's own
 * document, which law 4 permits them to have summarised for themselves and which
 * is never published. The pipeline refuses to publish a job that is not cleared,
 * which is the check that actually enforces it.
 */
export async function requestPrivateSummary(input: {
  title: string;
  text: string;
  kind: StudioKind;
  author?: string | null;
  workId?: string | null;
  /**
   * Minted once per submission by the screen, and REUSED on the reader's retry.
   *
   * `isOfflineFailure` cannot tell a request that never arrived from one that arrived,
   * committed and lost its response — so the screen says "that has not reached your
   * account" either way, and the reader presses again. Without this the second press is
   * another ~5.6 cents of provider spend and, on an adopted book, a second summary of
   * one title on their own shelf. With it the database answers with the job they already
   * have. Every other replayable write in this app carries one; this is the one that
   * spends money.
   */
  mutationId: string;
}): Promise<Enqueued> {
  const { data, error } = await supabase.rpc('enqueue_generation_job', {
    p_target: {
      jobKind: 'private_summary',
      kind: input.kind,
      title: input.title,
      text: input.text,
      rights_status: 'user_owned',
      ...(input.author ? { author: input.author } : {}),
      ...(input.workId ? { work_id: input.workId } : {}),
    },
    p_mutation_id: input.mutationId,
  });
  if (error) throw rpcError(error);
  return data as unknown as Enqueued;
}

/**
 * Whether there is budget left today — never how much.
 *
 * `spend_today()` and `daily_spend_cap_cents()` were both granted to `authenticated`
 * so this screen could print the difference, which is a live countdown to closing the
 * day for everybody handed to the one account that might want to. Both are back behind
 * the service role; this is the whole of what a reader may know, and it is enough for
 * the sentence the screen needs.
 *
 * An unreadable answer is treated as `open`, BY THE CALLER: this throws like every
 * other call in this module, and `Studio.tsx` catches it and falls back. Refusing to
 * let somebody start because a status call failed would be the wrong failure —
 * `enqueue_generation_job` checks the cap itself and answers 53400, which is a real
 * refusal with a real reason — but swallowing the error here would also hide a broken
 * RPC from the console, so the fallback is at the screen and the throw stays.
 */
export async function fetchBudgetState(): Promise<BudgetState> {
  const { data, error } = await supabase.rpc('generation_budget_state');
  if (error) throw rpcError(error);
  return isBudgetState(data) ? data : 'open';
}

/**
 * This reader's own generation jobs, newest first.
 *
 * Read through `generation_jobs_own`, which is a SELECT policy on
 * `requester_id` — so this needs no filter of its own to be safe and carries one
 * anyway, because a query that relies on RLS for its RESULT rather than for its
 * SECURITY is a query nobody can read.
 *
 * Bounded rather than paged: a reader is capped at fifty jobs a day and this
 * screen is about what is happening now, not about a history. Twelve is more than
 * a page of them.
 */
export async function fetchMyJobs(userId: string, limit = 12): Promise<StudioJob[]> {
  const { data, error } = await supabase
    .from('generation_jobs')
    .select('id, status, current_step, work_id, summary_id, error, created_at, updated_at')
    .eq('requester_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw rpcError(error);

  return (data ?? []).map((row) => ({
    id: row.id,
    status: row.status,
    currentStep: row.current_step,
    workId: row.work_id,
    summaryId: row.summary_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
