/**
 * Write the question you want to be asked about an idea, and put it into review.
 *
 * One form, two screens. It was written inside `routes/Source.tsx` and the
 * Library needs exactly the same thing for an imported highlight — a reader who
 * has just kept four hundred Kindle highlights is precisely the reader with
 * something to practise — so it lives here rather than being copied. The pure
 * half is `lib/questions.ts` and is untouched: the reducer, the draft validation
 * and the kind decision are all still there, and this is only what they look like.
 *
 * `remember_pull` does three things at once and the copy says all three, because
 * a button that silently schedules something is a button that surprises people:
 * it stores the question, saves the idea, and puts it into review.
 *
 * NOT OPTIMISTIC, unlike a highlight, and the difference is what failure costs. A
 * highlight that fails to save is a mark that disappears from text still on
 * screen; the reader sees it go and can select again. A question is a sentence
 * they composed, and showing it as saved before it is would let them navigate
 * away from words that were never stored. So the box holds what they typed until
 * the row exists.
 */

import { useReducer, useRef, type ReactNode } from 'react';
import { askReducer, draftFor, draftQuestion, EMPTY_ASK } from '../lib/questions.js';
import { rememberPull } from '../lib/questions-api.js';
import { TRANSPORT_ERROR } from '../lib/rpc-error.js';
import { mutationId } from '../lib/submission.js';

export interface RememberThisProps {
  /** The idea the question is about. */
  pullId: string;
  /**
   * Told when a question has actually been written, so a screen that lists a
   * reader's own questions can ask for them again. Optional: the Library has no
   * such list, and a component that required one would be asking its callers to
   * care about something only one of them has.
   */
  onKept?: () => void;
  /**
   * Prefix for the ids this form mints, so two instances on one page cannot
   * collide. The pull id alone would be enough today and will not be the day a
   * screen shows the same idea twice.
   */
  idPrefix?: string;
  /**
   * The screen's own controls for this idea, rendered before the toggle in the
   * SAME row. Everything a reader can do with an idea in front of them belongs on
   * one line — Share, Highlight, Remember this — and this component has to own that
   * row rather than sit under it, because the form it opens is a block element and
   * cannot live inside the caller's `<p>`. The Library passes nothing and gets the
   * toggle alone, exactly as before.
   */
  actions?: ReactNode;
  /**
   * A sentence about one of those controls -- "Link copied", "Select some words
   * first" -- rendered LAST in the row, after the toggle.
   *
   * Separate from `actions` rather than left to the caller's ordering because the
   * position is the point. `.meta` in an actions row takes the whole line, so a
   * status sentence anywhere but last pushes whatever follows it onto the next
   * line at the moment it appears -- which is the moment of the press that
   * produced it, with the reader's finger still on a control that has just moved.
   * Last, nothing follows it to move.
   */
  status?: ReactNode;
}

export function RememberThis({
  pullId,
  onKept,
  idPrefix = 'ask',
  actions,
  status,
}: RememberThisProps) {
  /*
   * The reducer from `lib/questions.ts`, driven with one key.
   *
   * It is keyed by pull id because the source page holds drafts for every idea on
   * it at once; an instance of this component holds exactly one. Using it as-is
   * rather than writing a single-key variant keeps one tested implementation of
   * what a draft is, what makes it invalid, and which kind it becomes.
   */
  const [ask, dispatchAsk] = useReducer(askReducer, EMPTY_ASK);

  /*
   * The submission id, held until the write is confirmed and cleared when the
   * reader EDITS.
   *
   * Minted BEFORE the send, which is what makes a retry after a timeout safe:
   * `remember_pull` matches on `(user_id, client_mutation_id)` and returns the
   * first call's question rather than writing a second one. An id that outlived an
   * edit would be worse than a fresh one -- the RPC would answer with the FIRST
   * question and silently discard the new wording.
   */
  const submission = useRef<string | null>(null);

  const open = ask.openFor === pullId;
  const busy = ask.busyFor === pullId;
  const error = ask.errors[pullId];
  const kept = ask.keptFor === pullId && !open;
  const promptId = `${idPrefix}-prompt-${pullId}`;
  const answerId = `${idPrefix}-answer-${pullId}`;
  const formId = `${idPrefix}-form-${pullId}`;

  async function save() {
    if (ask.busyFor) return;
    const draft = draftQuestion(draftFor(ask, pullId));
    if (!draft.ok) {
      dispatchAsk({ type: 'failed', pullId, message: draft.error });
      return;
    }

    dispatchAsk({ type: 'sending', pullId });
    try {
      await rememberPull(pullId, {
        prompt: draft.prompt,
        answer: draft.answer,
        kind: draft.kind,
        mutationId: (submission.current ??= mutationId()),
      });
      submission.current = null;
      dispatchAsk({ type: 'kept', pullId });
      onKept?.();
    } catch (e: unknown) {
      /*
       * A REQUEST THAT NEVER LEFT THE DEVICE IS NOT A CONSTRAINT MESSAGE.
       * postgrest-js resolves rather than rejects on a dead connection, so
       * `rpcError` hands back an Error whose `message` is the verbatim "TypeError:
       * Failed to fetch" -- which is what a reader on a train was shown under a
       * form they had just filled in. The name is what tells the two apart, and
       * every other write path in this app branches on it.
       */
      dispatchAsk({
        type: 'failed',
        pullId,
        message:
          e instanceof Error && e.name === TRANSPORT_ERROR
            ? 'That has not reached your account — you look offline. It stays in the box.'
            : e instanceof Error
              ? e.message
              : 'That question did not reach your account.',
      });
    }
  }

  return (
    <>
      <p className="remember__actions">
        {actions}
        <button
          type="button"
          className="btn btn--plain"
          aria-expanded={open}
          aria-controls={formId}
          onClick={() => {
            // A dismissal drops the draft and its id together; opening a different
            // idea drops neither, because a different idea is a different instance.
            if (open) submission.current = null;
            dispatchAsk({ type: 'toggle', pullId });
          }}
        >
          {open ? 'Never mind' : 'Remember this'}
        </button>
        {status}
      </p>

      {open && (
        <div className="remember" id={formId}>
          <label className="field__label" htmlFor={promptId}>
            What should this idea ask you?
          </label>
          <textarea
            id={promptId}
            className="field__textarea"
            rows={2}
            value={draftFor(ask, pullId).prompt}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${idPrefix}-error-${pullId}` : undefined}
            onChange={(e) => {
              // The id goes with the wording it was minted for. Editing after a
              // failed Keep is a NEW question.
              submission.current = null;
              dispatchAsk({ type: 'edit', pullId, field: 'prompt', value: e.target.value });
            }}
            placeholder="What does an obstacle become?"
          />

          <label className="field__label" htmlFor={answerId}>
            The answer
          </label>
          {/* Sentence case and not `.meta`, which is mono and UPPERCASED. A label is
              two or three words and reads fine shouted; this is a sentence, and
              CLAUDE.md's law 1 leaves typography to do the work rather than raising
              the app's voice at the reader mid-explanation. */}
          <p className="remember__hint" id={`${answerId}-hint`}>
            Optional, and kept with the question so you can read it back. Review shows you the idea
            and you mark yourself either way.
          </p>
          <textarea
            id={answerId}
            className="field__textarea"
            aria-describedby={`${answerId}-hint`}
            rows={2}
            value={draftFor(ask, pullId).answer}
            onChange={(e) => {
              submission.current = null;
              dispatchAsk({ type: 'edit', pullId, field: 'answer', value: e.target.value });
            }}
          />

          {/* `.remember__error`, not `.meta`. The hint above argues that
              reader-facing prose must not be mono and uppercased, and a refusal
              rendered in exactly that looked identical to the neutral sentence beside
              it -- `role="alert"` being the only thing distinguishing them, which is a
              signal for screen readers and none at all for everyone else. */}
          {error && (
            <p className="remember__error" id={`${idPrefix}-error-${pullId}`} role="alert">
              {error}
            </p>
          )}

          <p>
            <button
              type="button"
              className="btn"
              aria-disabled={busy}
              aria-describedby={`${idPrefix}-consequence-${pullId}`}
              onClick={() => void save()}
            >
              {busy ? 'Keeping…' : 'Keep this question'}
            </button>{' '}
            {/* Described BY the button, not merely next to it: a screen-reader user
                tabbing here heard "Keep this question, button" and none of what it
                silently does. */}
            <span className="meta" id={`${idPrefix}-consequence-${pullId}`}>
              Keeping it also saves this idea and puts it in your review.
            </span>
          </p>
        </div>
      )}

      {kept && (
        <p className="meta" role="status">
          {/* NOT "from tomorrow", and not "here". `remember_pull` inserts
              `knowledge_states` with `on conflict do nothing`, so an idea already in
              review keeps the schedule it had -- which may be two months out. And it
              is Review that asks, not the screen this form is on. */}
          Kept. It will come up in your reviews.
        </p>
      )}
    </>
  );
}
