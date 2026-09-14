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
 * DETERMINISTIC, which is the whole reason this is a function rather than a
 * template literal at the call site: the pipeline hashes what it is given
 * (`works.content_hash`) and reuses a summary of the same hash, so the same
 * highlights must produce byte-identical text on two presses or the reader pays
 * twice for one book. Order comes from the rows as they were kept — the caller
 * hands them in that order and this does not re-sort — and the locator rides on
 * its own line so the model can cite where a passage came from without it running
 * into the passage.
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

/** Whether this job is still going, and therefore still worth asking about. */
export function isRunning(job: StudioJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/**
 * What a job is doing, in the reader's terms rather than the queue's.
 *
 * `current_step` is a node in a twelve-step DAG and means nothing to anybody who
 * has not read `graph.ts`. What a reader wants to know is whether it has started,
 * whether it is nearly done, and whether it went wrong — so the steps are folded
 * into three sentences and a failure quotes its own reason.
 *
 * A job that is waiting on the day's budget is NOT a failure and does not read as
 * one: it stays `queued` while the worker re-sends its step, so it is described as
 * waiting, which is what it is.
 */
export function describeJob(job: StudioJob): string {
  if (job.status === 'succeeded') return 'Done.';
  if (job.status === 'failed') {
    return job.error ? `That did not finish: ${job.error}` : 'That did not finish.';
  }
  if (job.status === 'queued') return 'Waiting its turn.';
  if (EARLY_STEPS.has(job.currentStep)) return 'Reading the text.';
  if (job.currentStep === 'synthesize') return 'Writing the summary.';
  return 'Finishing up.';
}

const EARLY_STEPS = new Set(['resolve_identity', 'acquire', 'chunk']);

/**
 * What is left of today's global budget, as a sentence.
 *
 * In money rather than in jobs, because that is what the cap actually counts and
 * because a number of jobs would be a guess: a long source costs more than a short
 * one. Said plainly rather than hidden — a reader who is told the day is spent can
 * come back tomorrow, and one who is not simply sees a button that does nothing.
 */
export function budgetLine(spentCents: number, capCents: number): string {
  const left = Math.max(0, capCents - spentCents);
  if (left <= 0) {
    return 'Today’s generation budget is spent. Summaries start again at midnight UTC.';
  }
  return `About $${(left / 100).toFixed(2)} of today’s shared generation budget is left.`;
}
