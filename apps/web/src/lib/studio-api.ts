import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';
import type { StudioJob, StudioKind } from './studio.js';

export {
  budgetLine,
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
export type { StudioJob, StudioKind, SubmitCheck } from './studio.js';

/**
 * The reader's imported highlights, for the source picker.
 *
 * Re-exported under a name that says what the Studio wants it for rather than
 * imported from two modules by one screen. It is the same walk the Library does;
 * nothing about it is Studio-specific, which is precisely why it is not
 * reimplemented here.
 */
export { fetchImportedItems as fetchImportedItemsForStudio } from './import-api.js';

/** What `enqueue_generation_job` answers with. */
export interface Enqueued {
  jobId: string;
  kind: string;
  queue: 'fast' | 'normal';
  delaySeconds: number;
  remainingToday: number;
  spentTodayCents: number;
  dailyCapCents: number;
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
 * What the product has spent today, in cents.
 *
 * `spend_today()` is granted to `authenticated` precisely so this screen can say
 * there is no budget left rather than letting a reader submit into a refusal. It
 * is refused to `anon`: a signed-out visitor cannot enqueue, so the number tells
 * them nothing they can act on and tells anybody else how close the product is to
 * its own ceiling.
 */
export async function fetchSpendToday(): Promise<number> {
  const { data, error } = await supabase.rpc('spend_today');
  if (error) throw rpcError(error);
  return typeof data === 'number' ? data : Number(data ?? 0);
}

export async function fetchDailyCap(): Promise<number> {
  const { data, error } = await supabase.rpc('daily_spend_cap_cents');
  if (error) throw rpcError(error);
  return typeof data === 'number' ? data : Number(data ?? 0);
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
