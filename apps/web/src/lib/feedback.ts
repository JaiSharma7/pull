import { FEEDBACK_SUBJECTS, type FeedbackSubject } from '@wap/schemas';

/**
 * What a reader is telling us, and whether it is ready to send.
 *
 * Pure, and separate from the screen for the reason `lib/questions.ts` gives about
 * itself: the part worth testing is the validation and the truncation, and testing
 * those should not require a DOM or a Supabase client.
 *
 * The subject list is NOT re-declared here. It comes from `@wap/schemas`, which
 * `packages/db/src/enum-parity.ts` asserts equal to the generated
 * `feedback_subject` enum in both directions — so a migration that adds a subject
 * fails typecheck until this screen can render it, rather than shipping a form
 * whose options and whose column disagree.
 */

/** The reader-facing name for each subject, in the order the form offers them. */
const SUBJECT_LABELS: Record<FeedbackSubject, string> = {
  bug: 'Something is broken',
  idea: 'An idea or request',
  content: 'A problem with a summary',
  account: 'My account',
  other: 'Something else',
};

/**
 * A sentence under each option, because the labels alone leave two of them ambiguous.
 *
 * "A problem with a summary" and "Something is broken" both describe a wrong page to
 * a reader who has not thought about which half is at fault, and they go to different
 * places: one is a bug, the other is a rights or accuracy question about the corpus.
 */
const SUBJECT_HINTS: Record<FeedbackSubject, string> = {
  bug: 'A button that does nothing, a page that will not load, something that lost your work.',
  idea: 'Something missing, or something you wish worked differently.',
  content: 'A summary that is wrong, misattributed, or should not be here at all.',
  account: 'Signing in, your data, deleting your account.',
  other: 'Anything that does not fit the rest.',
};

export interface SubjectOption {
  value: FeedbackSubject;
  label: string;
  hint: string;
}

/** Every subject the database will accept, in the order the form shows them. */
export const SUBJECT_OPTIONS: SubjectOption[] = FEEDBACK_SUBJECTS.map((value) => ({
  value,
  label: SUBJECT_LABELS[value],
  hint: SUBJECT_HINTS[value],
}));

/**
 * The column is `check (length(message) between 1 and 4000)`, and this is the same
 * number so a reader is told before sending rather than by a constraint violation
 * afterwards. Kept as a named export so the counter on the form and the check here
 * cannot drift.
 */
export const MAX_MESSAGE = 4000;

/**
 * `path` is `check (length(path) <= 200)`. Anything longer is truncated rather than
 * refused: the path is context we collect, not something the reader typed, and
 * refusing to send someone's bug report because they were on a long URL would be
 * absurd.
 */
export const MAX_PATH = 200;

export type DraftResult =
  | { ok: true; subject: FeedbackSubject; message: string; path: string | null }
  | { ok: false; error: string };

/** Count by code point, so an emoji is one character rather than two. */
const characters = (s: string): number => [...s].length;

export function isSubject(value: string): value is FeedbackSubject {
  return (FEEDBACK_SUBJECTS as readonly string[]).includes(value);
}

/**
 * Is this ready to send?
 *
 * The subject is validated rather than trusted even though it comes from a control
 * that only offers valid values: the form reads it back out of the DOM as a string,
 * and a `select` is one `value` attribute away from carrying something the enum has
 * never heard of. The database would refuse it with `22P02`, which reaches the reader
 * as an unreadable Postgres error under a form they have just spent five minutes on.
 */
export function draftFeedback(input: {
  subject: string;
  message: string;
  path?: string | null;
}): DraftResult {
  if (!isSubject(input.subject)) {
    return { ok: false, error: 'Choose what this is about.' };
  }

  const message = input.message.trim();
  if (!message) {
    return { ok: false, error: 'Tell us what happened — even a sentence helps.' };
  }
  if (characters(message) > MAX_MESSAGE) {
    return {
      ok: false,
      error: `That is longer than we can store. ${MAX_MESSAGE} characters at most.`,
    };
  }

  return { ok: true, subject: input.subject, message, path: shapePath(input.path) };
}

/**
 * Where they were, as a path and never a full URL.
 *
 * A path cannot carry an origin, a query string or a fragment, so it cannot smuggle a
 * search term the reader typed or the id of the idea they had anchored into a table
 * they did not expect to hold either. `/search?q=how+to+leave+my+job` is a path with a
 * query string; what gets stored is `/search`.
 *
 * Empty, absent, or not a path at all becomes null rather than an empty string —
 * "we do not know where they were" and "they were nowhere" should not be two values
 * that both mean the first one.
 */
export function shapePath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.split('?')[0]?.split('#')[0]?.trim() ?? '';
  if (!path.startsWith('/')) return null;
  return path.slice(0, MAX_PATH) || null;
}
