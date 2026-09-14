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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  budgetLine,
  buildImportSource,
  checkSubmission,
  describeJob,
  fetchBudgetState,
  fetchImportedItemsForStudio,
  fetchImportedWorks,
  fetchMyJobs,
  isWorthPolling,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MIN_TEXT_CHARS,
  requestPrivateSummary,
  STUDIO_KINDS,
  type BudgetState,
  type StudioJob,
  type StudioKind,
} from '../lib/studio-api.js';
import type { ImportedItem } from '../lib/import-api.js';
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

  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [books, setBooks] = useState<{ workId: string; title: string; kind: string | null }[]>([]);
  /*
   * The picked book's highlights, fetched when it is picked.
   *
   * Studio used to load every highlight the reader owns on mount — forty sequential
   * requests and every body in memory for a four-thousand-highlight library — to draw a
   * row of title buttons. The bodies are wanted only for the one book that is sent.
   */
  const [items, setItems] = useState<{ workId: string; rows: ImportedItem[] } | null>(null);
  /*
   * What could not be read, as the ATTEMPT that failed rather than a flag.
   *
   * Both fetches used to report to `console.error` alone. A failed highlight fetch
   * left the screen saying "Reading your highlights from X…" for ever, with no retry
   * and a submit that refused with "try again in a moment" — a sentence that could
   * never come true without a reload. A screen that cannot do the thing has to say so.
   *
   * Each holds the key of the attempt it belongs to — the retry counter for the book
   * list, and the book plus the retry counter for the highlights — and the render
   * compares that key against the attempt currently in flight. So picking a second book
   * or pressing Try again retires the old message by DERIVING it away, with no effect
   * body that clears state synchronously: two failures sharing one `'books' | 'items'`
   * slot needed exactly that clear, and it is the cascading render lint forbids.
   */
  const [booksFailed, setBooksFailed] = useState<number | null>(null);
  const [itemsFailed, setItemsFailed] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [jobs, setJobs] = useState<StudioJob[]>([]);

  const reloadJobs = useCallback(() => {
    fetchMyJobs(userId)
      .then(setJobs)
      .catch((e: unknown) => console.error('Could not read your generations', e));
  }, [userId]);

  useEffect(() => {
    let live = true;
    fetchBudgetState()
      .then((state) => {
        if (live) setBudget(state);
      })
      .catch((e: unknown) => console.error('Could not read the budget', e));
    fetchImportedWorks(userId)
      .then((found) => {
        if (live) setBooks(found);
      })
      .catch((e: unknown) => {
        console.error('Could not read your imports', e);
        if (live) setBooksFailed(reloads);
      });
    reloadJobs();
    return () => {
      live = false;
    };
  }, [userId, reloadJobs, reloads]);

  /*
   * Polled while something is running, and not otherwise.
   *
   * Ten seconds, from the plan: a generation takes minutes, so a faster poll buys
   * nothing and a slower one leaves the reader watching a stale line. The effect
   * is armed on whether anything is actually worth asking about, so a screen with
   * nothing in flight sends no requests at all — which is most of the time, on a
   * screen a reader opens once and leaves open.
   *
   * `isWorthPolling` rather than `isRunning`, which is not the same question: a job
   * parked on the day's spent budget is unfinished and is also not going to change
   * in the next ten seconds, and the two were conflated into a 10 s poll that could
   * run for twenty-four hours.
   */
  const running = jobs.some((j) => isWorthPolling(j));
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reloadJobs, POLL_MS);
    return () => clearInterval(timer);
  }, [running, reloadJobs]);

  const picked = source === 'paste' ? null : (books.find((b) => b.workId === source) ?? null);

  /** The highlight fetch currently in flight, or the one that would be. */
  const itemsAttempt = picked ? `${picked.workId}#${reloads}` : null;

  useEffect(() => {
    if (picked === null || items?.workId === picked.workId) return;
    let live = true;
    const attempt = `${picked.workId}#${reloads}`;
    fetchImportedItemsForStudio(userId, picked.workId)
      .then((rows) => {
        if (live) setItems({ workId: picked.workId, rows });
      })
      .catch((e: unknown) => {
        console.error('Could not read that book’s highlights', e);
        if (live) setItemsFailed(attempt);
      });
    return () => {
      live = false;
    };
  }, [picked, items?.workId, userId, reloads]);

  /** The picked book's rows, and only once they are the picked book's. */
  const pickedItems = picked && items?.workId === picked.workId ? items.rows : null;

  /*
   * Built once per selection, not once per render and again on submit.
   *
   * A 400-highlight book is a few hundred kilobytes of joined string, and it was being
   * rebuilt on every `setNote`, every `setBudget` and every 10 s poll tick purely to
   * read `.length` for the character count — then discarded and built a second time
   * inside `submit`. Two independently computed copies of the thing whose bytes decide
   * `works.content_hash` is also one more than there should be.
   */
  const importedText = useMemo(
    () => (pickedItems ? buildImportSource(pickedItems) : ''),
    [pickedItems],
  );

  async function submit() {
    if (sending) return;
    setError(null);
    setNote(null);

    // Said as what it is. Without this the empty `importedText` reaches
    // `checkSubmission` and comes back as "there needs to be at least 200 characters",
    // which is a confusing thing to tell somebody who picked a four-hundred-highlight
    // book a second ago.
    if (picked && pickedItems === null) {
      setError('Still reading that book’s highlights — try again in a moment.');
      return;
    }

    const body = picked ? importedText : text;
    // The reader's own wording wins where they have given one, for a picked book as
    // much as for pasted text. Without an editable title, a book whose stored title is
    // over the bound was refused by `checkSubmission` naming a field the picked branch
    // did not render — a dead end reachable from data the screen would not let them
    // change.
    const named = title.trim() || (picked ? picked.title : '');
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
      setBudget(queued.budget);
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

  const chars = picked ? importedText.length : text.trim().length;

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

      {budget && <p className="meta">{budgetLine(budget)}</p>}

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
        {booksFailed === reloads ? (
          <p className="remember__error" role="alert">
            Could not read your imported books.{' '}
            <button
              type="button"
              className="btn btn--plain"
              onClick={() => setReloads((n) => n + 1)}
            >
              Try again
            </button>
          </p>
        ) : books.length === 0 ? (
          <p className="meta">
            Import a Kindle or Readwise file and your own books appear here as well.
          </p>
        ) : null}
      </fieldset>

      {picked ? (
        itemsFailed === itemsAttempt ? (
          <p className="remember__error" role="alert">
            Could not read that book’s highlights.{' '}
            <button
              type="button"
              className="btn btn--plain"
              onClick={() => setReloads((n) => n + 1)}
            >
              Try again
            </button>
          </p>
        ) : pickedItems === null ? (
          <p className="meta" role="status">
            Reading your highlights from “{picked.title}”…
          </p>
        ) : (
          <p className="meta">
            {pickedItems.length} {pickedItems.length === 1 ? 'highlight' : 'highlights'} from “
            {picked.title}”, joined in the order you kept them.
          </p>
        )
      ) : (
        <>
          <label className="field__label" htmlFor="studio-author">
            Author
          </label>
          <input
            id="studio-author"
            className="field__input"
            value={author}
            maxLength={MAX_TITLE_CHARS}
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

      {/*
        Rendered for a picked book as well as for pasted text, and that is not a
        convenience. The title of an imported book is whatever the file said, which can
        be longer than the column allows — and with no field, `checkSubmission` refused
        naming something the screen would not let the reader change. Their wording wins
        where they give one; the book's is the placeholder and the fallback.
      */}
      <label className="field__label" htmlFor="studio-title">
        Title
      </label>
      <input
        id="studio-title"
        className="field__input"
        value={title}
        maxLength={MAX_TITLE_CHARS}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={picked ? picked.title : 'What this is called'}
      />

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
