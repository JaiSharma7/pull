import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';
import { isBudgetState, type BudgetState, type StudioJob, type StudioKind } from './studio.js';

export {
  budgetLine,
  isBudgetState,
  buildImportSource,
  checkSubmission,
  describeJob,
  isRunning,
  isWorthPolling,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MIN_TEXT_CHARS,
  STUDIO_KINDS,
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
 * An unreadable answer is treated as `open`. Refusing to let somebody start because a
 * status call failed would be the wrong failure: `enqueue_generation_job` checks the
 * cap itself and answers 53400, which is a real refusal with a real reason.
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
    .select('id, status, current_step, work_id, summary_id, error, created_at')
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
  }));
}
