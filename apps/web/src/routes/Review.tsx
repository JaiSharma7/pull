import { useCallback, useEffect, useRef, useState } from 'react';
import { Meter } from '@wap/ui';
import * as api from '../lib/api.js';
import { GRADE_LABELS, RECALL_GRADES, type RecallGrade } from '../lib/grades.js';
import { isOfflineFailure, pendingRecallPullIds, queueMutation } from '../lib/offline.js';
import { elapsedSince, nextSubmissionStamp } from '../lib/submission.js';
import { getCurrentUserId } from '../lib/supabase.js';
import type { DueReview } from '../lib/types.js';

/**
 * The deliberate recall destination. The feed is the ambient one — most recall
 * happens there, unannounced. This page is for readers who come looking.
 */
export function Review() {
  const [due, setDue] = useState<DueReview[] | null>(null);
  /*
   * Three states, not two.
   *
   * This screen used to be `.then(setDue).catch(() => setDue([]))`, so *any* failure
   * — an RLS denial, a 500, a dropped connection — rendered the success state:
   * "Nothing is fading. Everything you have saved is still solid." The reader was
   * told their memory was perfect because the request failed. On a product whose
   * entire claim is an honest account of what you know, that is the worst available
   * lie, and it is the one screen that never got the fix `lib/offline.ts` and
   * `Feed.tsx` both argue for at length.
   *
   * `null` due with no error is loading; an empty array is genuinely nothing due;
   * an error is an error. `routes/Source.tsx` makes the same three-way distinction.
   */
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [revealed, setRevealed] = useState(false);
  /*
   * When the answer was shown, so a grade can carry how long the reader took.
   *
   * Latency is measured from the reveal rather than from the card appearing:
   * the interval that means anything is between seeing the answer and judging
   * whether you had it, not how long the card sat on a screen somebody had
   * walked away from. Null until revealed, and a grade given without revealing
   * carries no latency rather than a made-up one.
   */
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  /** Set when a grade could not be sent AND could not be queued. */
  const [lostGrade, setLostGrade] = useState(false);
  /*
   * The other way a grade fails to be kept, and it is not the reader's browser.
   *
   * `queued` was `userId !== null && await queueMutation(...)`, so a session that
   * expired mid-screen — the refresh fails, `getCurrentUserId()` goes null — landed
   * on copy telling the reader their browser might be blocking site data. It is not;
   * they are signed out, and the fix is to sign in, which that sentence never
   * mentions. Two outcomes, two sentences.
   */
  const [signedOut, setSignedOut] = useState(false);
  /*
   * One grade in flight at a time.
   *
   * The buttons carried no `disabled`, and `grade()` no guard, for the whole round
   * trip — so a second tap on a slow connection graded the same card again with a
   * FRESH mutation id. The id makes a replay safe and does nothing about a genuine
   * second click: `20260905100000` de-duplicates on `(user_id, client_mutation_id)`,
   * so two ids are two grades, stability is multiplied twice, and this file's own
   * header says that "roughly squares the interval and takes the card out of review
   * for months". Both sibling screens in this change already guard it — `Feed.tsx`
   * with `handledSlots`, `KnowledgeCensus` with `disabled={saving}` — and Review, the
   * screen whose whole job is deliberate recall, had neither.
   */
  const [grading, setGrading] = useState(false);
  /*
   * Every pull graded on this screen, whether the write landed or was queued.
   *
   * The refetch below asks the server what is due, and a grade sitting in the queue
   * has not applied yet — so the card just answered comes back still due, is shown
   * again, and grading it a second time mints a new id and applies a second time.
   * The reader answered it once; that is the fact this records, and it outlives any
   * individual request's fate.
   *
   * A ref rather than state, because nothing renders from it. As state it was a
   * dependency the fetch effect had to either declare — refetching on every grade,
   * when the whole point of that effect is to run once per page of twenty — or omit
   * and carry a lint warning for. A ref is read where it is needed and is always
   * current, which is what this actually wants.
   *
   * AND IT IS ONLY HALF THE ANSWER, because a ref dies with the mount and Review is
   * a TAB. Switching to Library and back — or reloading — empties this set while the
   * queued grade is still sitting in IndexedDB undrained, so the card comes back due
   * and a second tap mints a second mutation id. Two ids are two grades, which is the
   * P1 this whole file is about, arriving by a route the ref cannot see. The durable
   * half is `pendingRecallPullIds`, read in the effect below; this set stays because
   * it is current the instant a grade is given, before anything has been written.
   */
  const graded = useRef<Set<string>>(new Set());
  /** Bumped by the retry button, so the fetch re-runs without a second effect. */
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const userId = getCurrentUserId();
    Promise.all([
      api.fetchDueReviews(),
      userId === null ? Promise.resolve(new Set<string>()) : pendingRecallPullIds(userId),
    ])
      .then(([rows, queuedFor]) => {
        if (cancelled) return;
        // Filtered rather than trusted, from both halves. A queued grade has not
        // reached the server, so it answers this request with the card the reader
        // already judged — whether they judged it a moment ago on this mount or
        // before a tab switch that emptied the ref.
        setDue(rows.filter((row) => !graded.current.has(row.pullId) && !queuedFor.has(row.pullId)));
        setOffline(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // The detail goes to the console, where it helps whoever is debugging. The
        // reader gets a sentence they can act on rather than "permission denied for
        // function get_due_reviews", which is unhelpful and leaks schema internals.
        console.error('Due reviews request failed', e);
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  // Clearing the error here rather than inside the effect: setState in an effect body
  // cascades renders, and the lint rule that says so is right.
  const retry = useCallback(() => {
    setError(null);
    setDue(null);
    setReloads((n) => n + 1);
  }, []);

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Review</p>
        <h1>Could not check what is fading.</h1>
        <p>
          {offline
            ? 'You appear to be offline, so this could not be checked. It does not mean nothing is due.'
            : 'Something went wrong reaching your review schedule. Nothing has been lost.'}
        </p>
        <p className="meta">{error}</p>
        <button type="button" className="btn btn--primary" onClick={retry}>
          Try again
        </button>
      </section>
    );
  }

  if (!due)
    return (
      <p className="meta" role="status">
        Loading…
      </p>
    );

  if (due.length === 0) {
    return (
      <section className="stack measure">
        <p className="meta">Review</p>
        <h1>Nothing is fading.</h1>
        <p>Everything you have saved is still solid. Come back when something slips.</p>
      </section>
    );
  }

  const card = due[0]!;

  /**
   * `latencyMs` is measured by the caller, not read here.
   *
   * Not a style choice: `react-hooks/purity` refuses a `Date.now()` in a function
   * declared in the component body, because it cannot tell an event handler from
   * something that runs during render — and it is right to refuse, since a value
   * read at render time would change on every re-render. The click is the moment
   * the reader answered, so the click is where the clock belongs.
   */
  async function grade(g: RecallGrade, latencyMs?: number) {
    if (grading) return;
    setGrading(true);
    /*
     * The attempt gets an identity before it is sent, and that changes what this
     * function is allowed to do with a failure.
     *
     * It used to queue only a failure it could PROVE had never left the tab.
     * `grade_recall` applied every call it received — it multiplies stability and
     * increments `reps` — so a 500, a refusal or a timeout mid-flight had to be
     * DROPPED, because the write may already have applied and double-applying one
     * roughly squares the interval and takes the card out of review for months.
     * Losing a grade was the cheaper of two bad outcomes.
     *
     * 20260905100000 removed the choice. The event is inserted first, keyed by
     * this id, and a replay finds its own row and returns the state untouched. So
     * a retry of a write that DID land is now a no-op, and there is no longer a
     * reason to drop an ambiguous failure: every failure is queued.
     */
    const mutationId = crypto.randomUUID();
    const submittedAt = nextSubmissionStamp();
    // Advance regardless. A grade that fails to reach the server is a lost
    // measurement, but leaving the card on screen with its answer already
    // revealed is worse: the reader cannot grade it honestly a second time, and
    // offline is one of the five things promised free, so this page has to keep
    // working without a connection rather than wedging on the first card.
    try {
      await api.gradeRecall(card.pullId, g, {
        mutationId,
        submittedAt,
        kind: 'review',
        // No `questionId` yet. `get_due_reviews` returns the prompt and not the id
        // it came from, so there is nothing truthful to send; 2b is the PR that
        // adds `questionId` and `questionSource` to that shape, and the screen
        // starts sending it in the same change that starts receiving it.
        ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
      });
      /*
       * A write that lands proves the reader is signed in, so the banner saying they
       * are not stops being true and goes.
       *
       * `getCurrentUserId()` returning null is not always a session that ended — a
       * token refresh in flight reads the same way — so this flag could be raised by
       * a blip and then contradicted by the very next card, leaving a reader who is
       * signed in reading that their session ended. `lostGrade` is left alone on
       * purpose: a later success does not un-lose the earlier grade.
       */
      setSignedOut(false);
    } catch (e: unknown) {
      /*
       * Read from the live auth session rather than a prop: this screen takes none,
       * and a queued write has to belong to someone or the drain cannot tell whose
       * it is. The queue is drained by `Feed.tsx`, which stays mounted.
       */
      const userId = getCurrentUserId();
      const queued =
        userId !== null &&
        (await queueMutation(
          userId,
          {
            kind: 'recall',
            pullId: card.pullId,
            grade: g,
            mutationId,
            submittedAt,
            recallKind: 'review',
            ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
          },
          // The refusal decides whether queueing is worth anything. A grade the
          // server will refuse identically on every replay is dropped by the first
          // drain, so queueing it silently loses it; declined here, `lostGrade`
          // says so to the reader instead.
          e,
        ));

      /*
       * And when even the queue could not take it, the reader is told.
       *
       * `queueMutation` returns false when the store is unavailable — a browser
       * blocking site data, a private window out of quota, an older tab holding
       * the database at the previous version. That return was being ignored here,
       * so a grade could vanish between the network and the disk with the card
       * advancing as though it had been recorded. One line of copy is not much,
       * but it is the difference between a lost measurement and a silent one.
       */
      if (!queued) {
        if (userId === null) setSignedOut(true);
        else setLostGrade(true);
        console.error('Recall grade was not recorded', e);
      }
    } finally {
      /*
       * IN A `finally`, because everything after it is what lets the reader carry on.
       *
       * `setGrading(false)` sat after the catch block, so anything the RECOVERY path
       * threw — `getCurrentUserId` on a torn-down client, `queueMutation` rejecting
       * rather than returning false — left `grading` true forever. The guard at the
       * top of this function then refused every subsequent tap, and the screen was
       * wedged on one card with its answer showing: a reader who cannot grade and
       * cannot move on. The failure that gets there is rare; being unable to review
       * until a reload is not a rare consequence.
       */
      setGrading(false);
    }
    // Answered, whatever became of the write. See `graded`.
    graded.current.add(card.pullId);
    setRevealed(false);
    setRevealedAt(null);
    /*
     * When the page empties, ask for the next one instead of declaring victory.
     *
     * `fetchDueReviews` takes `limit = 20` (api.ts). Grading the twentieth card left
     * `due` empty, and the empty state below says "Nothing is fading. Everything you
     * have saved is still solid" — to a reader who may have fifty more due. That is
     * the exact lie this file's header comment was written about, arriving from the
     * other direction: the original bug rendered it on a failed request, and this one
     * rendered it on a successful but partial one.
     *
     * Bumping `reloads` reuses the effect rather than adding a second fetch path, so
     * the cancellation and the offline handling stay in one place. The refetch is
     * cheap and only happens once per twenty cards; if it comes back empty, the empty
     * state is finally telling the truth.
     *
     * Computed from `due` and applied outside the updater, not inside it. A functional
     * `setDue` may be invoked more than once for one update — StrictMode does it
     * deliberately — so a `setReloads` in there would fire twice and fetch twice. An
     * updater has to be pure; this is the reason why.
     */
    const rest = (due ?? []).slice(1);
    setDue(rest);
    if (rest.length === 0) setReloads((n) => n + 1);
  }

  return (
    <section className="stack measure">
      <p className="meta">
        Review · {due.length} {due.length === 1 ? 'idea' : 'ideas'} fading
      </p>

      {/*
        Said once, and it stays said for as long as this screen is open.

        Not "for the rest of the session", which the earlier comment claimed and the
        code has never done: Review is a tab, so both of these die on the next tab
        switch along with everything else in this component. Saying what actually
        happens is worth more than a promise the screen cannot keep.

        A grade that reaches neither the server nor the queue is gone, and the
        screen used to advance as though it had been recorded. This is the only
        outcome in this file the reader cannot recover from by carrying on, so it
        is the only one worth interrupting them about — and it is deliberately not
        a blocking dialogue, because the session is still worth finishing.
      */}
      {signedOut ? (
        <p className="meta" role="alert">
          Your session ended before that grade could be saved. Sign in again and those ideas will
          come round as they were.
        </p>
      ) : null}

      {lostGrade ? (
        <p className="meta" role="alert">
          Something went wrong saving a grade, and this device could not hold on to it either — your
          browser may be blocking site data. Those ideas will come round again.
        </p>
      ) : null}

      <div className="pull-card">
        <p className="pull-card__chip">{card.workTitle}</p>
        <hr className="pull-card__rule" />
        <h2 className="pull-card__headline">{card.question ?? card.headline}</h2>

        {revealed ? (
          <>
            <p className="pull-card__body">{card.body}</p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {RECALL_GRADES.map((g) => (
                <button
                  key={g}
                  type="button"
                  className="btn"
                  disabled={grading}
                  onClick={() => void grade(g, elapsedSince(revealedAt))}
                >
                  {GRADE_LABELS[g]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setRevealed(true);
              setRevealedAt(Date.now());
            }}
          >
            Show answer
          </button>
        )}

        <div style={{ marginTop: 'var(--space-5)' }}>
          <p className="meta" style={{ marginBottom: 'var(--space-2)' }}>
            Strength {Math.round(card.retrievability * 100)}%
          </p>
          <Meter value={card.retrievability} label={`Recall strength for ${card.headline}`} />
        </div>
      </div>
    </section>
  );
}
