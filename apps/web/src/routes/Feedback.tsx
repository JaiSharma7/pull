import { useRef, useState } from 'react';
import { MAX_MESSAGE, SUBJECT_OPTIONS, draftFeedback } from '../lib/feedback.js';
import { FeedbackRateLimited, sendFeedback } from '../lib/feedback-api.js';
import { TRANSPORT_ERROR } from '../lib/rpc-error.js';
import { mutationId } from '../lib/submission.js';

/**
 * Say what is wrong, without leaving to find a mail client.
 *
 * Before this the only channels were the mailbox in `docs/terms.md` and GitHub's
 * vulnerability reporting — both of which ask a reader to stop reading, open another
 * application, and compose a message to a stranger. The realistic outcome of that is
 * silence, and silence is indistinguishable from nothing being wrong.
 *
 * NOT A `mailto:` LINK, which is the point rather than an implementation detail. A
 * `mailto:` hands the reader to Outlook or Gmail — a context switch most people abandon,
 * and one that produces a message from a personal address nobody can associate back to
 * an account. This writes a row.
 *
 * NOT OPTIMISTIC, for the reason `RememberThis` gives about the same choice: what the
 * reader typed is a paragraph they composed, and showing it as sent before it is would
 * let them navigate away from words that were never stored. The box holds what they
 * wrote until the row exists.
 */
export function Feedback({ userId, fromPath }: { userId: string; fromPath?: string | null }) {
  const [subject, setSubject] = useState<string>(SUBJECT_OPTIONS[0]?.value ?? 'bug');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  /*
   * Minted before the send and held until it is confirmed, so a retry after a timeout
   * collides on `feedback_mutation_idx` rather than filing the same complaint twice.
   * Cleared when the reader EDITS, because an id that outlived an edit would make the
   * second send a no-op against the first wording — the reader would see "sent" and we
   * would hold the message they had just rewritten.
   */
  const submission = useRef<string | null>(null);

  const chosen = SUBJECT_OPTIONS.find((o) => o.value === subject);
  const used = [...message].length;

  async function send() {
    if (busy) return;

    const draft = draftFeedback({ subject, message, path: fromPath });
    if (!draft.ok) {
      setError(draft.error);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await sendFeedback(userId, {
        subject: draft.subject,
        message: draft.message,
        path: draft.path,
        mutationId: (submission.current ??= mutationId()),
      });
      submission.current = null;
      setMessage('');
      setSent(true);
    } catch (e: unknown) {
      /*
       * Three failures that need three different sentences.
       *
       * The rate limit is not an error the reader caused by writing badly, and the
       * database's own message already says what to do — so it is passed through rather
       * than replaced with something vaguer. A dead connection is not a constraint
       * message either: postgrest-js RESOLVES rather than rejects on one, so `rpcError`
       * hands back an Error whose message is the verbatim "TypeError: Failed to fetch",
       * and the name is what tells the two apart.
       */
      setError(
        e instanceof FeedbackRateLimited
          ? e.message
          : e instanceof Error && e.name === TRANSPORT_ERROR
            ? 'That has not reached us — you look offline. It stays in the box.'
            : e instanceof Error
              ? e.message
              : 'That did not reach us.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack measure">
      <h2>Send feedback</h2>
      <p>
        Something broken, something missing, or something wrong in a summary — this goes straight to
        the person who maintains it. No mail client, no account details to dig out.
      </p>

      <label className="field__label" htmlFor="feedback-subject">
        What is this about?
      </label>
      <select
        id="feedback-subject"
        className="field__input"
        value={subject}
        aria-describedby="feedback-subject-hint"
        onChange={(e) => {
          setSubject(e.target.value);
          setSent(false);
        }}
      >
        {SUBJECT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {/* The hint for the CURRENT choice, under the control. A `select` cannot carry a
          sentence per option, and two of these labels are ambiguous without one: a wrong
          page is "something is broken" or "a problem with a summary" depending on which
          half is at fault, and those are different problems. */}
      <p className="form-note" id="feedback-subject-hint">
        {chosen?.hint}
      </p>

      <label className="field__label" htmlFor="feedback-message">
        What happened?
      </label>
      <textarea
        id="feedback-message"
        className="field__textarea"
        rows={6}
        value={message}
        aria-invalid={Boolean(error)}
        aria-describedby="feedback-count"
        onChange={(e) => {
          // A new wording is a new message, so the id goes with it.
          submission.current = null;
          setMessage(e.target.value);
          setSent(false);
          if (error) setError(null);
        }}
        placeholder="The more specific the better — what you did, and what happened instead."
      />
      {/* Counted from the top rather than shown only near the limit: a reader who has
          written 3,900 characters and is about to lose the lot to a refusal should have
          been able to see it coming. `MAX_MESSAGE` is the column's own bound. */}
      <p className="form-note" id="feedback-count">
        {used} of {MAX_MESSAGE} characters
      </p>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <p>
        <button
          type="button"
          className="btn btn--primary"
          aria-disabled={busy}
          onClick={() => void send()}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </p>

      {sent && (
        <p className="meta" role="status">
          {/* Deliberately not "we will get back to you". Nothing here promises a reply,
              and a reader who is told one and does not get it has been misled by the
              screen rather than let down by the person. */}
          Sent. Thank you — it has arrived.
        </p>
      )}
    </div>
  );
}
