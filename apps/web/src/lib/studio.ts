/**
 * Studio — the pure half of asking for a summary of your own text.
 *
 * The one place law 2 bends, and it bends in a bounded, ledgered direction:
 * generation still happens at GENERATION time, once, for one reader, under the
 * same per-requester quota every canonical job has and under the global daily cap
 * `20260914010000` added. Nothing here runs in a read path and nothing here calls
 * a model — this module decides what text is sent and what a job's state is
 * called, both of which are arithmetic over strings.
 *
 * Pure and separate from `lib/studio-api.ts` for the reason `lib/ingestion.ts` is
 * separate from `lib/import-api.ts`: the module that sends imports
 * `lib/supabase.ts`, which throws at import under vitest, so everything worth
 * asserting has to live where a test can reach it.
 */

import type { ImportedItem } from './imports.js';

/**
 * The shortest text the pipeline will accept.
 *
 * `acquire` refuses inline text under 200 characters, and it refuses it four
 * steps and one queue hop after the reader pressed the button. Checked here so
 * the refusal arrives under the box they typed into rather than as a job that
 * fails silently a minute later.
 */
export const MIN_TEXT_CHARS = 200;

/** What one call may carry, matching `enqueue_generation_job`'s own bound. */
export const MAX_TEXT_CHARS = 200_000;

export const MAX_TITLE_CHARS = 200;

/** The work kinds the pipeline knows, as the Studio offers them. */
export const STUDIO_KINDS = ['book', 'essay', 'paper', 'talk', 'article'] as const;
export type StudioKind = (typeof STUDIO_KINDS)[number];

export type SubmitCheck = { ok: true; text: string; title: string } | { ok: false; error: string };

/**
 * Whether this is something the pipeline can be asked for, and what to say when
 * it is not.
 *
 * Trimmed before it is measured, because trailing whitespace is not context and a
 * reader who pasted 199 characters and a newline should not be told they have 200.
 * The ceiling is stated in characters rather than words for the same reason the
 * database states it that way: it is the number the refusal will quote.
 */
export function checkSubmission(input: { title: string; text: string }): SubmitCheck {
  const title = input.title.trim();
  const text = input.text.trim();

  if (!title) return { ok: false, error: 'Give it a title, so you can find it again.' };
  if (title.length > MAX_TITLE_CHARS) {
    return { ok: false, error: `That title is longer than ${MAX_TITLE_CHARS} characters.` };
  }
  if (text.length < MIN_TEXT_CHARS) {
    return {
      ok: false,
      error: `There needs to be at least ${MIN_TEXT_CHARS} characters to summarise; this is ${text.length}.`,
    };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      error: `That is ${text.length.toLocaleString()} characters and the limit is ${MAX_TEXT_CHARS.toLocaleString()}. Send it in parts.`,
    };
  }
  return { ok: true, text, title };
}

/**
 * The text of an imported source, built from the highlights themselves.
 *
 * DETERMINISTIC, which is why this is a function rather than a template literal at
 * the call site. The same highlights must produce byte-identical text on two presses:
 * the pipeline hashes what it is given and dedupes canonical work on
 * `works.content_hash`, and a screen that shuffled its own input would make every
 * property keyed on that hash meaningless.
 *
 * WHAT IT DOES NOT BUY, on the path this function's output actually takes: reuse.
 * `template` adopts the reader's existing work rather than calling `upsertWork`, so
 * no `works` row ever carries this text's hash and `findPublishedSummaryByHash` cannot
 * find it — a second generation of the same book runs the full paid walk again. That
 * is a real gap rather than a subtlety, and closing it is a design question the adopt
 * path raises and does not answer: the reader's work already carries TWO readable
 * summaries by then (the import's and the generated one), so a hash lookup has to be
 * told which of them it is looking for. Named here rather than implied away; the
 * screen warns instead, which is the honest interim.
 *
 * Order comes from the rows as they were kept — the caller hands them in that order and
 * this does not re-sort — and the locator rides on its own line so the model can cite
 * where a passage came from without it running into the passage.
 *
 * Highlights are joined by a blank line rather than a separator glyph. They are
 * passages from one book, not a list, and the pipeline's own segmentation reads
 * paragraphs.
 */
export function buildImportSource(items: readonly ImportedItem[]): string {
  return items
    .map((item) => {
      const body = item.body.trim();
      const locator = item.locator?.trim();
      return locator ? `${locator}\n${body}` : body;
    })
    .filter((part) => part !== '')
    .join('\n\n');
}

/** Everything `generation_jobs` says about a job the reader asked for. */
export interface StudioJob {
  id: string;
  status: string;
  currentStep: string;
  workId: string | null;
  summaryId: string | null;
  error: string | null;
  createdAt: string;
}

/** Whether this job has not finished. */
export function isRunning(job: StudioJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/**
 * Whether this job is worth asking about again soon.
 *
 * Not the same question as `isRunning`, and conflating them had Studio polling every
 * ten seconds for up to twenty-four hours: a job parked on the day's budget is not
 * finished and is also not going to change in the next ten seconds. Polling stops once
 * a job has been running long enough to be waiting rather than working; the reader
 * sees the state on their next visit, which is when the answer will have changed.
 */
export function isWorthPolling(job: StudioJob, now: number = Date.now()): boolean {
  if (!isRunning(job)) return false;
  return now - Date.parse(job.createdAt) <= POLL_FOR_MS;
}

/**
 * How long a job is worth asking about, whatever its status.
 *
 * The first version exempted `queued` entirely, on the reasoning that a queued job is
 * about to start — which left the same unbounded poll on the other status: the
 * per-requester stagger delays the 50th job of the day by `(50 - 3 + 1) * 300` seconds,
 * nearly four hours, and the job is `queued` for all of it. A tab left open issued
 * roughly fourteen hundred requests against a row that could not change.
 *
 * Four hours covers the whole stagger, so a job that started the day queued is still
 * being watched when its turn comes. Past that the reader sees the answer on their next
 * visit, which is when it will have changed.
 */
export const POLL_FOR_MS = 4 * 60 * 60 * 1000;

/**
 * What a job is doing, in the reader's terms rather than the queue's.
 *
 * `current_step` is a node in a twelve-step DAG and means nothing to anybody who
 * has not read `graph.ts`. What a reader wants to know is whether it has started,
 * whether it is nearly done, and whether it went wrong — so the steps are folded
 * into three sentences and a failure quotes its own reason.
 *
 * WHAT THIS CANNOT TELL, said here because two versions of it have now claimed
 * something it does not know. A job parked on the day's spent budget is
 * indistinguishable from one that is working: `dispatch_generation_step` sets
 * `status = 'running'` on every hop, so a job waiting at `synthesize` is `running`,
 * and the worker never touches its status while it re-sends the step for up to 24
 * hours. Telling that reader "Writing the summary." for a day would be a screen lying
 * at length.
 *
 * So a job running past any plausible duration says it is TAKING LONGER, and does not
 * guess why. The previous version named the budget, which mislabels in both directions
 * — a genuinely slow source is told the budget is spent, and a budget-parked job is
 * told a summary is being written for its first twenty minutes. The worker does know
 * which it is (it increments `budgetWaits` on the queue message), and surfacing that
 * needs a column it writes: a migration rather than a sentence, and worth doing rather
 * than guessing at. Named here so the next person finds the decision rather than the
 * guess.
 */
export function describeJob(job: StudioJob, now: number = Date.now()): string {
  if (job.status === 'succeeded') return 'Done.';
  if (job.status === 'failed') {
    return job.error ? `That did not finish: ${job.error}` : 'That did not finish.';
  }
  if (job.status === 'queued') return 'Waiting its turn.';

  // Past this, no generation is still plausibly mid-call: the worker holds a message
  // for 180 s and a whole run is minutes. What it is waiting on is not something this
  // screen can see, so it does not say.
  if (now - Date.parse(job.createdAt) > STALLED_AFTER_MS) {
    return 'Taking longer than usual. It will finish on its own — you can close this.';
  }

  if (EARLY_STEPS.has(job.currentStep)) return 'Reading the text.';
  if (job.currentStep === 'synthesize') return 'Writing the summary.';
  return 'Finishing up.';
}

/**
 * How long a job can plausibly be running before "running" stops being the honest word.
 *
 * Twenty minutes. A full walk is twelve steps of seconds-to-a-minute each plus queue
 * hops; the per-requester stagger can delay a START by hours, but that job is `queued`,
 * not `running`, so it never reaches this branch.
 */
export const STALLED_AFTER_MS = 20 * 60 * 1000;

const EARLY_STEPS = new Set(['resolve_identity', 'acquire', 'chunk']);

/** What a reader may be told about the day's budget: whether there is room, not how much. */
export type BudgetState = 'open' | 'low' | 'spent';

export function isBudgetState(value: unknown): value is BudgetState {
  return value === 'open' || value === 'low' || value === 'spent';
}

/**
 * What is left of today's global budget, as a sentence.
 *
 * COARSE, and that is the correction rather than the shape. It used to take the exact
 * spend and the exact cap and print the difference — which is a live countdown to
 * closing the day for everybody, handed to the one person who might want to. The
 * migration that added the cap argues against exactly that and then granted both
 * numbers; `generation_budget_state()` is what a reader gets now.
 *
 * Still said rather than hidden: a reader who is told the day is spent can come back
 * tomorrow, and one who is not simply sees a button that does nothing.
 */
export function budgetLine(state: BudgetState): string {
  if (state === 'spent') {
    return 'Today’s generation budget is spent. Summaries start again at midnight UTC.';
  }
  if (state === 'low') {
    return 'Today’s shared generation budget is nearly used up.';
  }
  return 'There is room in today’s shared generation budget.';
}
