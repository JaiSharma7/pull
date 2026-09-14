/**
 * Studio — a summary of your own text, for you.
 *
 * The one place law 2 bends, and the shape of the bend is the point. Generation
 * still happens at GENERATION time, once, for one reader: nothing here runs per
 * impression, nothing here runs in a read path, and every call writes
 * `cost_ledger`. What changes is who can start one. Until now that was whoever
 * asked for a canonical work; now it is anybody with an account and something of
 * their own to understand.
 *
 * Which is exactly why `20260914010000` exists. The per-requester quotas — three
 * fast a day, a stagger, fifty as a ceiling — bound one reader and bound the
 * product not at all once everybody can spend, so a global daily cap sits under
 * them and this screen says what is left of it before the reader types anything.
 *
 * WHAT THE READER IS TOLD, in their words and before they press anything:
 *
 *   * the text goes to Google, which is the one exception to "nothing about your
 *     reading reaches a model" and is `docs/privacy.md`'s own sentence
 *   * the summary is private and is not published
 *   * how much of today's shared budget is left, and how many of their own jobs
 *
 * None of that is a disclosure buried in a policy: it is the copy on the screen,
 * because the alternative is a button that quietly sends somebody's diary to a
 * model provider.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  budgetLine,
  buildImportSource,
  checkSubmission,
  describeJob,
  fetchDailyCap,
  fetchImportedItemsForStudio,
  fetchMyJobs,
  fetchSpendToday,
  isRunning,
  MAX_TEXT_CHARS,
  MIN_TEXT_CHARS,
  requestPrivateSummary,
  STUDIO_KINDS,
  type StudioJob,
  type StudioKind,
} from '../lib/studio-api.js';
import { groupImported, type ImportedWorkGroup } from '../lib/import-api.js';
import { isOfflineFailure } from '../lib/offline.js';

/** How often a running job is asked about. */
const POLL_MS = 10_000;

export function Studio({
  userId,
  onNavigate,
}: {
  userId: string;
  onNavigate: (to: string) => void;
}) {
  const [source, setSource] = useState<'paste' | string>('paste');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [kind, setKind] = useState<StudioKind>('essay');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const [budget, setBudget] = useState<{ spent: number; cap: number } | null>(null);
  const [books, setBooks] = useState<ImportedWorkGroup[]>([]);
  const [jobs, setJobs] = useState<StudioJob[]>([]);

  const reloadJobs = useCallback(() => {
    fetchMyJobs(userId)
      .then(setJobs)
      .catch((e: unknown) => console.error('Could not read your generations', e));
  }, [userId]);

  useEffect(() => {
    let live = true;
    Promise.all([fetchSpendToday(), fetchDailyCap()])
      .then(([spent, cap]) => {
        if (live) setBudget({ spent, cap });
      })
      .catch((e: unknown) => console.error('Could not read the budget', e));
    fetchImportedItemsForStudio(userId)
      .then((items) => {
        if (live) setBooks(groupImported(items));
      })
      .catch((e: unknown) => console.error('Could not read your imports', e));
    reloadJobs();
    return () => {
      live = false;
    };
  }, [userId, reloadJobs]);

  /*
   * Polled while something is running, and not otherwise.
   *
   * Ten seconds, from the plan: a generation takes minutes, so a faster poll buys
   * nothing and a slower one leaves the reader watching a stale line. The effect
   * is armed on whether anything is actually running, so a screen with nothing in
   * flight sends no requests at all — which is most of the time, on a screen a
   * reader opens once and leaves open.
   */
  const running = jobs.some(isRunning);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reloadJobs, POLL_MS);
    return () => clearInterval(timer);
  }, [running, reloadJobs]);

  const picked = source === 'paste' ? null : (books.find((b) => b.workId === source) ?? null);

  async function submit() {
    if (sending) return;
    setError(null);
    setNote(null);

    const body = picked ? buildImportSource(picked.items) : text;
    const named = picked ? picked.title : title;
    const check = checkSubmission({ title: named, text: body });
    if (!check.ok) {
      setError(check.error);
      return;
    }

    setSending(true);
    try {
      const queued = await requestPrivateSummary({
        title: check.title,
        text: check.text,
        kind: picked ? 'book' : kind,
        author: author.trim() || null,
        // Only for an imported book, and the server checks it twice: the target
        // keeps it only if this reader authored a summary on that work, and
        // `template` asks the row again at the moment it writes. Sending it is
        // what makes the book gain a summary rather than acquire a second row.
        workId: picked ? picked.workId : null,
      });
      setBudget({ spent: queued.spentTodayCents, cap: queued.dailyCapCents });
      setNote(
        queued.queue === 'fast'
          ? `Started. ${queued.remainingToday} more today.`
          : `Queued, starting in about ${Math.round(queued.delaySeconds / 60)} minutes. ${queued.remainingToday} more today.`,
      );
      if (!picked) setText('');
      reloadJobs();
    } catch (e: unknown) {
      console.error('Could not request a summary', e);
      setError(
        isOfflineFailure(e)
          ? 'That has not reached your account — you look offline. Your text stays here.'
          : e instanceof Error
            ? e.message
            : 'That could not be started just now.',
      );
    } finally {
      setSending(false);
    }
  }

  const chars = picked ? buildImportSource(picked.items).length : text.trim().length;

  return (
    <section className="stack measure">
      <p className="meta">Studio</p>
      <h1>Have something of your own summarised.</h1>
      <p className="lede">
        An essay, a paper, a talk, or the highlights you have already kept. It is read once, written
        up once, and the result is yours — private, not published, and not part of the catalogue.
      </p>

      {/*
        The consent line, before the form rather than under the button.
        `docs/privacy.md` names this as the one exception to "nothing about your reading
        reaches a model", and a reader has to meet it before they have typed anything
        rather than after they have decided.
      */}
      <p className="studio__consent">
        This text is sent to Google to write the summary. It is the one thing this product sends to
        a model provider, and it happens because you asked.
      </p>

      {budget && <p className="meta">{budgetLine(budget.spent, budget.cap)}</p>}

      <hr className="rule" />

      <fieldset className="stack">
        <legend className="prefs__legend">What to summarise</legend>
        <div className="library__filters" role="group" aria-label="Source">
          <button
            type="button"
            className="btn btn--plain library__filter"
            aria-pressed={source === 'paste'}
            onClick={() => setSource('paste')}
          >
            Something I paste
          </button>
          {books.map((book) => (
            <button
              key={book.workId}
              type="button"
              className="btn btn--plain library__filter"
              aria-pressed={source === book.workId}
              onClick={() => setSource(book.workId)}
            >
              {book.title}
            </button>
          ))}
        </div>
        {books.length === 0 && (
          <p className="meta">
            Import a Kindle or Readwise file and your own books appear here as well.
          </p>
        )}
      </fieldset>

      {picked ? (
        <p className="meta">
          {picked.items.length} {picked.items.length === 1 ? 'highlight' : 'highlights'} from “
          {picked.title}”, joined in the order you kept them.
        </p>
      ) : (
        <>
          <label className="field__label" htmlFor="studio-title">
            Title
          </label>
          <input
            id="studio-title"
            className="field__input"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What this is called"
          />

          <label className="field__label" htmlFor="studio-author">
            Author
          </label>
          <input
            id="studio-author"
            className="field__input"
            value={author}
            maxLength={200}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Optional"
          />

          <label className="field__label" htmlFor="studio-kind">
            What kind of thing it is
          </label>
          <select
            id="studio-kind"
            className="field__input"
            value={kind}
            onChange={(e) => setKind(e.target.value as StudioKind)}
          >
            {STUDIO_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <label className="field__label" htmlFor="studio-text">
            The text
          </label>
          <textarea
            id="studio-text"
            className="field__textarea"
            rows={12}
            value={text}
            maxLength={MAX_TEXT_CHARS}
            aria-describedby="studio-text-count"
            onChange={(e) => setText(e.target.value)}
          />
          {/*
            Counted against the floor as well as the ceiling. `acquire` refuses
            inline text under 200 characters four steps and a queue hop after the
            press, so a reader who pastes a paragraph would otherwise watch a job
            fail a minute later for a reason nothing on screen mentioned.
          */}
          <p className="meta" id="studio-text-count">
            {chars.toLocaleString()} of {MAX_TEXT_CHARS.toLocaleString()} characters
            {chars < MIN_TEXT_CHARS ? ` · at least ${MIN_TEXT_CHARS} needed` : ''}
          </p>
        </>
      )}

      {error && (
        <p className="remember__error" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="meta" role="status">
          {note}
        </p>
      )}

      <p>
        <button
          type="button"
          className="btn btn--primary"
          aria-disabled={sending}
          onClick={() => void submit()}
        >
          {sending ? 'Starting…' : 'Write me a summary'}
        </button>
      </p>

      {jobs.length > 0 && (
        <>
          <hr className="rule" />
          <h2 style={{ fontSize: 'var(--step-1)' }}>What you have asked for</h2>
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {jobs.map((job) => (
              <li key={job.id} className="library__item">
                <p className="meta" role="status">
                  {describeJob(job)}
                </p>
                {job.status === 'succeeded' && job.workId && (
                  <button
                    type="button"
                    className="btn btn--plain"
                    onClick={() =>
                      onNavigate(
                        job.summaryId
                          ? `/source/${job.workId}?s=${job.summaryId}`
                          : `/source/${job.workId}`,
                      )
                    }
                  >
                    Read it
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* The end is a sentence, not the page simply stopping (law 7). */}
      <p className="meta">Nothing here is published. What you make, you keep.</p>
    </section>
  );
}
