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
 * multiple choice with no wrong answers — `mcqOptions` refuses to build fewer than two
 * options at all, so the card would have nothing to render — and a `cloze` would be a
 * fill-the-blank with no blank. Both are storable and both are broken, so neither is
 * offered.
 *
 * An earlier version of this said `mcqOptions` "returns a single button, the right one,
 * which grades `easy`". It returns an empty array, its own comment calls a single button
 * the thing it exists to prevent, and such a tap would score `good` rather than `easy`.
 * The conclusion survives the correction; the mechanism given for it did not.
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

/* --------------------------------------------------------------------------
 * The form's state machine
 * -------------------------------------------------------------------------- */

/**
 * Which idea's form is open, and what has been typed into each of them.
 *
 * KEYED BY PULL, and that is the whole point. `Source.tsx` had one open flag per idea
 * and one of everything else for the page -- prompt, answer, error, busy -- so the
 * flag was per-idea and every value carrying the reader's words was not. Opening a
 * second idea's form ran the toggle, which cleared the boxes, and a draft composed
 * under the first idea was gone with no confirmation and no undo. A save landing while
 * another form was open did the same thing. Both were demonstrated in review, and the
 * comment on the old open flag congratulated itself for avoiding exactly this.
 *
 * Lifted out of the component because there is no React test harness in this repo --
 * `apps/web` runs `environment: 'node'` -- so a state machine living in a component is
 * a state machine nothing can drive. That is why the bugs above were races and
 * shared-state mix-ups rather than logic errors in the half that is tested. This is
 * where `lib/` already keeps logic that has to be checkable without a browser.
 */
export interface AskState {
  /** The idea whose form is open, or null. One at a time, as before. */
  openFor: string | null;
  /** What has been typed, per idea. Absent means nothing typed yet. */
  drafts: Readonly<Record<string, DraftQuestion>>;
  /** The last refusal, per idea, so a failure cannot surface under a different one. */
  errors: Readonly<Record<string, string>>;
  /** The idea whose save is in flight, so one idea's request cannot label another's. */
  busyFor: string | null;
  /** The idea whose "Kept." line is showing. */
  keptFor: string | null;
}

export const EMPTY_ASK: AskState = {
  openFor: null,
  drafts: {},
  errors: {},
  busyFor: null,
  keptFor: null,
};

export type AskAction =
  | { type: 'toggle'; pullId: string }
  | { type: 'edit'; pullId: string; field: 'prompt' | 'answer'; value: string }
  | { type: 'sending'; pullId: string }
  | { type: 'kept'; pullId: string }
  | { type: 'failed'; pullId: string; message: string };

/** The draft for an idea, or a pair of empty strings. */
export function draftFor(state: AskState, pullId: string): DraftQuestion {
  return state.drafts[pullId] ?? { prompt: '', answer: '' };
}

function without<T>(map: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    /*
     * Opens one idea's form, or closes it. What it does NOT do is touch any other
     * idea's draft: closing is a dismissal of this one, and opening another is not a
     * dismissal of anything.
     *
     * Dismissing does drop this idea's draft and its error, which is what "Never mind"
     * means. The mutation id is dropped with it by the caller, for the reason the ref
     * carries: an id that outlives the words it was minted for makes the RPC answer
     * with the first question and discard the new wording.
     */
    case 'toggle': {
      const closing = state.openFor === action.pullId;
      return {
        ...state,
        openFor: closing ? null : action.pullId,
        drafts: closing ? without(state.drafts, action.pullId) : state.drafts,
        errors: without(state.errors, action.pullId),
        keptFor: null,
      };
    }
    case 'edit':
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.pullId]: { ...draftFor(state, action.pullId), [action.field]: action.value },
        },
        // A refusal is about what was in the box, so typing clears it.
        errors: without(state.errors, action.pullId),
      };
    case 'sending':
      return { ...state, busyFor: action.pullId, errors: without(state.errors, action.pullId) };
    /*
     * The row exists, so the words can go. Only this idea's: `openFor` is cleared only
     * if this is the idea whose form is open, so a save that lands while the reader has
     * moved to another idea does not close the form they are typing in.
     */
    case 'kept':
      return {
        openFor: state.openFor === action.pullId ? null : state.openFor,
        drafts: without(state.drafts, action.pullId),
        errors: without(state.errors, action.pullId),
        busyFor: state.busyFor === action.pullId ? null : state.busyFor,
        keptFor: action.pullId,
      };
    /*
     * The words stay in the box, and the message is filed against the idea it is about
     * -- so a failure that arrives after the reader has opened a different idea cannot
     * report itself under that one, and one that arrives after they closed the form is
     * still on record rather than written to a render site that no longer exists.
     */
    case 'failed':
      return {
        ...state,
        errors: { ...state.errors, [action.pullId]: action.message },
        busyFor: state.busyFor === action.pullId ? null : state.busyFor,
      };
  }
}
