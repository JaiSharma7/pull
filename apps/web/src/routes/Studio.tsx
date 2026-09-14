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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  budgetLine,
  fitImportSource,
  truncationNote,
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
  STUDIO_KIND_LABEL,
  STUDIO_KINDS,
  POLL_MS,
  studioKindFor,
  waitMinutes,
  type BudgetState,
  type StudioJob,
  type StudioKind,
} from '../lib/studio-api.js';
import type { ImportedItem } from '../lib/import-api.js';
import { isOfflineFailure } from '../lib/offline.js';
import { sqlState } from '../lib/rpc-error.js';
import { mutationId } from '../lib/submission.js';

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
  /*
   * The same flag, readable in the same tick.
   *
   * `if (sending) return` reads the value THIS render captured, and the button carries
   * `aria-disabled` rather than `disabled` — it stays clickable on purpose — so two
   * presses before React commits both passed. With a mutation id on the call that is no
   * longer merely a wasted request: both transactions miss the replay row and the second
   * insert hits `generation_jobs_client_mutation_key`, putting a raw constraint violation
   * under the form while a job really did start. `Library.tsx` takes the same answer for
   * the same reason.
   */
  const sendingRef = useRef(false);
  /*
   * ONE ID PER SUBMISSION, kept across the reader's retries of it.
   *
   * Minted when a submission is first sent and cleared only when one succeeds, so the
   * press that follows "That has not reached your account" replays rather than buys: a
   * request that committed and lost its response is indistinguishable from one that
   * never arrived, and only the database can tell. Cleared on success so the NEXT
   * submission — a different text, or the same book asked for again on purpose — is a
   * new one.
   */
  const submission = useRef<string | null>(null);

  /**
   * Anything that changes WHAT would be sent retires the id.
   *
   * An id that outlived an edit is worse than a fresh one: the replay branch in
   * `enqueue_generation_job` answers with the job the id already names, BEFORE it looks
   * at the target — so a reader who was told "that has not reached your account",
   * changed their text and pressed again would be shown "Started." for a job
   * summarising what they replaced. `RememberThis` clears its own id on every edit for
   * exactly this reason.
   */
  function editing() {
    submission.current = null;
  }

  /**
   * Picking a source, which is an edit AND a fresh attempt at that book's highlights.
   *
   * The failure key is `(book, retry counter)`, and neither moves when a reader leaves a
   * book and comes back — so a book that failed once drew its red alert again the moment
   * it was re-picked, over a refetch that was already in flight and about to succeed.
   * Clearing it here rather than in the effect keeps the state change in the event that
   * caused it, which is also what stops it being a synchronous set inside an effect.
   */
  function pick(next: string) {
    // The chip already selected is not a change of source, and pressing it should not
    // throw away a title being typed. Everything below is about LEAVING a source.
    if (next === source) return;
    editing();
    setItemsFailed(null);
    /*
     * And the title, which belonged to the source being left.
     *
     * `named = title.trim() || picked.title` means a title typed for one book wins over
     * the next one's — so picking A, naming it, then picking B filed a paid generation
     * of B's highlights under A's name, with only the placeholder changing to say
     * otherwise. The field is a per-source override; leaving the source retires it.
     */
    setTitle('');
    setSource(next);
  }

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
  /*
   * Which attempt at the book list has LANDED, failure included.
   *
   * Without it there is no in-flight state between the two: pressing Try again derived
   * the alert away on the next render — `booksFailed` names the attempt before — while
   * `books` was still `[]` and the refetch had not resolved, so the screen told a reader
   * with four hundred imported highlights that they had imported nothing, then flickered
   * back to the alert if the retry failed too.
   */
  const [booksAnswered, setBooksAnswered] = useState<number | null>(null);
  const [itemsFailed, setItemsFailed] = useState<string | null>(null);
  /*
   * TWO COUNTERS AND THREE EFFECTS, because three things fail independently.
   *
   * One counter drove everything, in the deps of one effect that fetched all of it:
   * pressing Try again under a failed highlight fetch re-ran the budget state, the book
   * list and the job list as well — three round trips to retry a fourth, unrelated one,
   * on a screen whose whole argument is that generation is metered. `reloads` now
   * retries the book list and nothing else, `itemReloads` the open book's highlights,
   * and the budget and the job list have no retry to be caught up in.
   */
  const [reloads, setReloads] = useState(0);
  const [itemReloads, setItemReloads] = useState(0);
  const [jobs, setJobs] = useState<StudioJob[]>([]);

  const reloadJobs = useCallback(() => {
    fetchMyJobs(userId)
      .then(setJobs)
      .catch((e: unknown) => console.error('Could not read your generations', e));
  }, [userId]);

  /*
   * The two that have no retry of their own, and no `reloads` in their deps.
   *
   * The counter split was only half done: `itemReloads` came out for the highlights and
   * `reloads` was left driving this effect, so Try again under a failed BOOK LIST still
   * re-issued `generation_budget_state` and `fetchMyJobs` beside it — two requests that
   * had just succeeded, on a screen whose premise is that every request is metered.
   */
  useEffect(() => {
    let live = true;
    fetchBudgetState()
      .then((state) => {
        if (live) setBudget(state);
      })
      .catch((e: unknown) => {
        // `open`, not nothing. `fetchBudgetState` documents an unreadable answer as
        // `open` and then throws on one, so the fallback has to live here: without it
        // `budget` stays null, the sentence is not rendered at all, and the reader gets
        // a screen that silently drops a line it promises. Refusing to let somebody
        // start because a status call failed would be the wrong failure —
        // `enqueue_generation_job` checks the cap itself and answers 53400.
        console.error('Could not read the budget', e);
        if (live) setBudget('open');
      });
    reloadJobs();
    return () => {
      live = false;
    };
  }, [userId, reloadJobs]);

  /** The book list, which is what `reloads` retries and the only thing it retries. */
  useEffect(() => {
    let live = true;
    const attempt = reloads;
    fetchImportedWorks(userId)
      .then((found) => {
        if (!live) return;
        setBooks(found);
        setBooksAnswered(attempt);
      })
      .catch((e: unknown) => {
        console.error('Could not read your imports', e);
        if (!live) return;
        setBooksFailed(attempt);
        setBooksAnswered(attempt);
      });
    return () => {
      live = false;
    };
  }, [userId, reloads]);

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
  const itemsAttempt = picked ? `${picked.workId}#${itemReloads}` : null;

  useEffect(() => {
    if (picked === null || items?.workId === picked.workId) return;
    let live = true;
    const attempt = `${picked.workId}#${itemReloads}`;
    fetchImportedItemsForStudio(userId, picked.workId)
      .then((rows) => {
        if (!live) return;
        setItems({ workId: picked.workId, rows });
        // Cleared on success, because the key alone does not expire. Book A fails, book
        // B is picked and succeeds, and picking A again matches `A#0` against a failure
        // recorded before the refetch that is about to succeed — so the alert rendered
        // over highlights that were in memory, and only Try again could clear it.
        setItemsFailed(null);
      })
      .catch((e: unknown) => {
        console.error('Could not read that book’s highlights', e);
        if (live) setItemsFailed(attempt);
      });
    return () => {
      live = false;
    };
  }, [picked, items?.workId, userId, itemReloads]);

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
  const imported = useMemo(
    () =>
      pickedItems ? fitImportSource(pickedItems) : { text: '', used: 0, total: 0, complete: true },
    [pickedItems],
  );
  const importedText = imported.text;
  /*
   * Said before the press, not after it.
   *
   * A book over `MAX_TEXT_CHARS` came back from `checkSubmission` with "Send it in
   * parts" — advice the paste box can take and the picker cannot, since the only
   * granularity it offers is a whole book. `fitImportSource` cuts to a whole number of
   * highlights instead, deterministically, and this is the sentence that makes that an
   * offer rather than something done quietly to the reader's book.
   */
  const shortened = truncationNote(imported);

  async function submit() {
    if (sendingRef.current) return;
    setError(null);
    setNote(null);

    // Said as what it is. Without this the empty `importedText` reaches
    // `checkSubmission` and comes back as "there needs to be at least 200 characters",
    // which is a confusing thing to tell somebody who picked a four-hundred-highlight
    // book a second ago.
    if (picked && pickedItems === null) {
      /*
       * Two different states, and only one of them gets better by waiting. A fetch that
       * FAILED leaves `pickedItems` null for ever as far as this button is concerned —
       * nothing on this path re-issues it — so "try again in a moment" was a sentence
       * that could never come true, which is the dead end this screen's own comment
       * above `booksFailed` describes fixing on the render path.
       */
      setError(
        itemsFailed === itemsAttempt
          ? 'Could not read that book’s highlights. Use Try again above, then submit.'
          : 'Still reading that book’s highlights — try again in a moment.',
      );
      return;
    }

    // The one case `fitImportSource` cannot cut its way out of: a single highlight over
    // the whole bound. Said here rather than left to `checkSubmission`, which would
    // answer "Send it in parts" to a reader who has no parts to send.
    if (picked && pickedItems !== null && imported.text === '' && pickedItems.length > 0) {
      // Two ways to end with no text, and they are not the same thing to be told.
      // `complete` means nothing was dropped for LENGTH — so every row in the book was
      // blank, and naming the first highlight as too long is a cause that is false and
      // leaves the reader nothing they could do about it.
      setError(
        imported.complete
          ? 'There is no text in this book’s highlights to summarise.'
          : 'The first highlight in this book is on its own longer than one summary can take.',
      );
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

    sendingRef.current = true;
    setSending(true);
    try {
      const queued = await requestPrivateSummary({
        title: check.title,
        text: check.text,
        kind: picked ? studioKindFor(picked.kind) : kind,
        // Null for a picked book, like `kind` and `workId` beside it. The Author field
        // is only rendered on the paste branch, so a value here is whatever the reader
        // typed before switching the source chip — inert on the adopt path, and written
        // verbatim into a new `works` row on the fall-through that exists for the case
        // where the ownership re-check fails.
        author: picked ? null : author.trim() || null,
        // Only for an imported book, and the server checks it twice: the target
        // keeps it only if this reader authored a summary on that work, and
        // `template` asks the row again at the moment it writes. Sending it is
        // what makes the book gain a summary rather than acquire a second row.
        workId: picked ? picked.workId : null,
        mutationId: (submission.current ??= mutationId()),
      });
      submission.current = null;
      setBudget(queued.budget);
      setNote(
        // A replay of a job that is already over has no place in a queue to report, and
        // `queue`/`delaySeconds` describe one — so saying "Started." here would sit
        // directly above a row in the list below saying it did not finish.
        queued.finished
          ? 'You already asked for this one, and it has finished — it is in the list below.'
          : queued.queue === 'fast'
            ? `Started. ${queued.remainingToday} more today.`
            : `Queued, starting in about ${waitMinutes(queued.delaySeconds)}. ${queued.remainingToday} more today.`,
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
      /*
       * And the budget line catches up with the refusal.
       *
       * `budget` is read once on mount and otherwise only replaced by a SUCCESSFUL
       * submit, so a day that filled between the two left the screen printing "There is
       * room in today's shared generation budget." immediately above an error saying it
       * is spent. `53400` is the code both the door and `reserve_budget` raise for
       * exactly this, so the screen does not have to parse the sentence.
       */
      // `53400` is `configuration_limit_exceeded`, which is what both the door check in
      // `enqueue_generation_job` and `reserve_budget` raise, and `sqlState` reads it back
      // off the name `rpcError` gave the error — so the screen updates the line without
      // parsing the sentence.
      if (sqlState(e) === '53400') setBudget('spent');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  // The paste branch's counter, and only the paste branch's: the picked branch has no
  // count on screen — it says how many highlights are going in, and `shortened` says so
  // in words when some are not — so computing one for it was half a line of dead work on
  // every render, and read as if there were a count to find.
  const chars = text.trim().length;

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

        BOTH PROVIDERS ARE NAMED, which this said only Google. `SUMMARY_FALLBACK_PROVIDER`
        builds a chain that sends the same text to Anthropic when Gemini is unavailable —
        `providers.ts` falls through on `ProviderUnavailableError` — and this screen
        cannot read an Edge Function's environment to know whether a deployment has one
        configured. Consent has to describe what CAN happen to the document somebody is
        about to paste, so it names the set rather than the likely case: over-naming a
        processor is not the direction in which this is harmful.
      */}
      <p className="studio__consent">
        This text is sent to a model provider to write the summary — Google, or Anthropic if Google
        is unavailable. It is the one thing this product sends to a model provider, and it happens
        because you asked.
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
            onClick={() => pick('paste')}
          >
            Something I paste
          </button>
          {books.map((book) => (
            <button
              key={book.workId}
              type="button"
              className="btn btn--plain library__filter"
              aria-pressed={source === book.workId}
              onClick={() => pick(book.workId)}
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
        ) : booksAnswered !== reloads ? (
          <p className="meta" role="status">
            Looking for your imported books…
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
              onClick={() => setItemReloads((n) => n + 1)}
            >
              Try again
            </button>
          </p>
        ) : pickedItems === null ? (
          <p className="meta" role="status">
            Reading your highlights from “{picked.title}”…
          </p>
        ) : (
          <>
            <p className="meta">
              {pickedItems.length} {pickedItems.length === 1 ? 'highlight' : 'highlights'} from “
              {picked.title}”, joined in the order you kept them.
            </p>
            {shortened && (
              <p className="meta" role="status">
                {shortened}
              </p>
            )}
          </>
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
            onChange={(e) => {
              editing();
              setAuthor(e.target.value);
            }}
            placeholder="Optional"
          />

          <label className="field__label" htmlFor="studio-kind">
            What kind of thing it is
          </label>
          <select
            id="studio-kind"
            className="field__input"
            value={kind}
            onChange={(e) => {
              editing();
              setKind(e.target.value as StudioKind);
            }}
          >
            {STUDIO_KINDS.map((k) => (
              <option key={k} value={k}>
                {STUDIO_KIND_LABEL[k]}
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
            onChange={(e) => {
              editing();
              setText(e.target.value);
            }}
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
        onChange={(e) => {
          editing();
          setTitle(e.target.value);
        }}
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
