/**
 * A question the reader writes for themselves, before it reaches the network.
 *
 * Pure on purpose, and for the reason `lib/import-fold.ts` is: `lib/supabase.ts` builds
 * its client at module scope and throws under vitest's `test` mode, so logic that lives
 * beside an RPC wrapper can only be tested by standing up configuration it does not use.
 * The shaping and the bounds are the part with a bug in them if there is one, so they
 * live here and `lib/questions-api.ts` only sends.
 */

/**
 * What `user_questions` accepts, mirrored from the table rather than trusted to it.
 *
 * `user_questions_prompt_length` is `between 1 and 2000` and `user_questions_answer_length`
 * is `<= 2000` (`20260905110000_your_highlights_are_yours_to_keep.sql:169-172`). A row
 * over either is refused with 23514, which PostgREST returns as a 400 — so the reader
 * would lose what they typed to a message about a constraint. Caught here instead, while
 * the words are still in the box.
 */
export const MAX_PROMPT = 2000;
export const MAX_ANSWER = 2000;

/**
 * The two kinds this form can honestly write, out of the four the table permits.
 *
 * `remember_pull` writes `(user_id, pull_id, kind, prompt, answer, client_mutation_id)`
 * and has no parameter for `options` or for `cloze`. So an `mcq` written here would be a
 * multiple choice with no wrong answers — `mcqOptions` builds what the reader sees from
 * the answer plus the options, and with none it returns a single button, the right one,
 * which grades `easy` — and a `cloze` would be a fill-the-blank with no blank. Both are
 * storable and both are broken, so neither is offered.
 *
 * That is the same reasoning the migration gives for declining to put the matching
 * CHECK constraints on this table: a rule its only writer cannot satisfy forbids a kind
 * rather than guarding one. The kinds wait for the screen that can supply the column.
 */
export const WRITABLE_KINDS = ['recall', 'short_answer'] as const;
export type WritableKind = (typeof WRITABLE_KINDS)[number];

/**
 * Which of the two a reader meant, read off what they typed rather than asked.
 *
 * Both are self-graded — the reader reveals and marks themselves — so the difference is
 * not how the question is scored but what they will be shown: a `short_answer` has
 * something to compare against, a `recall` is remembered and checked against nothing. A
 * reader who supplies an answer has said which one they wanted; a picker offering two
 * options that behave identically today would be a control that changes nothing.
 */
export function kindFor(answer: string): WritableKind {
  return answer.trim() ? 'short_answer' : 'recall';
}

export interface DraftQuestion {
  prompt: string;
  answer: string;
}

export type QuestionDraftResult =
  | { ok: true; prompt: string; answer: string | null; kind: WritableKind }
  | { ok: false; error: string };

/**
 * Shape a filled-in form into what `remember_pull` takes, or say why it cannot be.
 *
 * Trimmed here as well as by the RPC, which does `btrim(p_prompt)`. That matters for the
 * LENGTH check rather than for tidiness: a 2,010-character prompt with ten trailing
 * spaces is refused by a client that measures the raw string and accepted by the server
 * that measures the trimmed one, so measuring the same thing the server will is what
 * stops the form rejecting something the database would have taken.
 *
 * An empty answer becomes null rather than `''`. `remember_pull` already does
 * `nullif(btrim(...), '')`, so this only makes the two agree about what was sent.
 */
/**
 * Characters, counted the way `length()` counts them.
 *
 * `String.prototype.length` is UTF-16 code units and Postgres `length(text)` is
 * codepoints, and the two disagree by one for every character outside the basic plane --
 * so an emoji is 2 here and 1 there. The direction is the safe one, since this module
 * only refuses, but refusing is the bug: a reader who writes 1,200 emoji is told "a
 * question can be 2000 characters at most" about a question the database would have
 * taken at 1,200.
 *
 * Spreading a string iterates it by codepoint, which is exactly what Postgres counts in
 * a UTF-8 database. The same count-versus-unit split the pipeline's jsonb clamp had, one
 * layer up and in the other direction.
 */
function characters(s: string): number {
  return [...s].length;
}

export function draftQuestion({ prompt, answer }: DraftQuestion): QuestionDraftResult {
  const p = prompt.trim();
  const a = answer.trim();

  if (!p) return { ok: false, error: 'A question needs something to ask.' };
  if (characters(p) > MAX_PROMPT) {
    return { ok: false, error: `A question can be ${MAX_PROMPT} characters at most.` };
  }
  if (characters(a) > MAX_ANSWER) {
    return { ok: false, error: `An answer can be ${MAX_ANSWER} characters at most.` };
  }

  return { ok: true, prompt: p, answer: a || null, kind: kindFor(a) };
}
