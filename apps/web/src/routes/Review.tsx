import { useCallback, useEffect, useState } from 'react';
import { Meter } from '@wap/ui';
import * as api from '../lib/api.js';
import { GRADE_LABELS, RECALL_GRADES, type RecallGrade } from '../lib/grades.js';
import { isOfflineFailure, queueMutation } from '../lib/offline.js';
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
  /** Bumped by the retry button, so the fetch re-runs without a second effect. */
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchDueReviews()
      .then((rows) => {
        if (cancelled) return;
        setDue(rows);
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

  async function grade(g: RecallGrade) {
    // Advance regardless. A grade that fails to reach the server is a lost
    // measurement, but leaving the card on screen with its answer already
    // revealed is worse: the reader cannot grade it honestly a second time, and
    // offline is one of the five things promised free, so this page has to keep
    // working without a connection rather than wedging on the first card.
    try {
      await api.gradeRecall(card.pullId, g);
    } catch (e: unknown) {
      /*
       * Queued only when the request demonstrably never reached the server.
       *
       * `grade_recall` is not replay-safe — it multiplies stability and increments
       * `reps`, so applying one grade twice roughly squares the interval and the card
       * silently drops out of review for months. There is no unique index and no
       * mutation id to catch a replay with. So a 500, a refusal, or a timeout
       * mid-flight is *dropped* rather than queued: the write may already have
       * applied, and losing a grade is self-correcting where double-applying one is
       * invisible. `isOfflineFailure` is the one condition under which the call
       * provably did not land. The full argument is on `PendingWrite` in
       * `lib/offline.ts`.
       *
       * Read from the live auth session rather than a prop: this screen takes none,
       * and a queued write has to belong to someone or the drain cannot tell whose
       * it is. The queue is drained by `Feed.tsx`, which stays mounted.
       */
      const userId = getCurrentUserId();
      if (userId && isOfflineFailure(e)) {
        await queueMutation(userId, { kind: 'recall', pullId: card.pullId, grade: g });
      } else {
        console.error('Recall grade was not recorded', e);
      }
    }
    setRevealed(false);
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

      <div className="pull-card">
        <p className="pull-card__chip">{card.workTitle}</p>
        <hr className="pull-card__rule" />
        <h2 className="pull-card__headline">{card.question ?? card.headline}</h2>

        {revealed ? (
          <>
            <p className="pull-card__body">{card.body}</p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {RECALL_GRADES.map((g) => (
                <button key={g} type="button" className="btn" onClick={() => void grade(g)}>
                  {GRADE_LABELS[g]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <button type="button" className="btn btn--primary" onClick={() => setRevealed(true)}>
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
