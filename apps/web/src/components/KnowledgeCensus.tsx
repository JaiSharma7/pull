import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api.js';
import { unappliedGrades, type KnowledgeLevel } from '../lib/calibration.js';
import { isOfflineFailure, queueMutation } from '../lib/offline.js';
import { getCurrentUserId } from '../lib/supabase.js';
import type { FeedRow } from '../lib/types.js';

export type { KnowledgeLevel };

/**
 * What the reader already holds, recorded against real ideas.
 *
 * The first version of this screen was a hard-coded list of six works — five of them
 * in-copyright bestsellers — with a typed-in `hoursSavedEstimated` per entry, and it
 * threw the reader's answers away on Finish: `onComplete` set the next stage and nothing
 * wrote a row. So "establishing initial stability S₀", which is the whole justification
 * for asking, did not happen, and the running "~N hours saved on future reading" was a
 * sum of constants.
 *
 * Three things change, and they are the same change: everything shown is a real row, and
 * everything claimed is something the database did.
 *
 *   * The items are Pulls from the reader's own feed — `get_feed`, the same ranked
 *     ideas they are about to be shown — so calibration is against what the Delta will
 *     actually filter, and against the public-domain corpus rather than an invented list.
 *   * An answer is written through `grade_recall`, which creates a `knowledge_states`
 *     row and applies FSRS to it. Familiar maps to `good`, Mastered to `easy`; the
 *     difference in initial stability is the database's to compute, not ours to assert.
 *   * There is no hours figure, because nothing here measures hours. The Delta does
 *     report real minutes — `FeedResponse.minutesSaved` — but that is a property of a
 *     feed response, not of an answer given here.
 */
const CENSUS_SIZE = 6;

export interface KnowledgeCensusProps {
  /*
   * Called once the census is finished with, however it finished.
   *
   * It used to carry the ids that were recorded, documented as meaningful, and its only
   * caller discarded them — which cost three `[...map.keys()]` conversions feeding a
   * parameter nobody read. What actually matters is already on the database; the gate
   * only needs to know it can move on.
   */
  onComplete: () => void;
  onSkip: () => void;
}

export function KnowledgeCensus({ onComplete, onSkip }: KnowledgeCensusProps) {
  const [items, setItems] = useState<FeedRow[] | null>(null);
  const [levels, setLevels] = useState<Record<string, KnowledgeLevel>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * Pull ids whose grade has already been applied, or durably queued.
   *
   * `grade_recall` is not replay-safe — it *multiplies* stability and increments `reps`,
   * with no idempotency key — so a write that landed must never be sent twice. Without
   * this the "Try again" the previous round added re-sent the whole set: four ideas that
   * had already succeeded got a second `good`, taking stability 1.0 → 2.7 → 7.29 and
   * pushing them out of review for weeks. The screen whose purpose is to establish an
   * initial stability would have fabricated one instead.
   */
  const [applied, setApplied] = useState<Map<string, 'good' | 'easy'>>(new Map());

  /*
   * Whether this screen is still mounted.
   *
   * "Skip calibration" is deliberately enabled while a save is in flight — it is the
   * escape hatch for exactly that hang — so the sequential `gradeRecall` loop can outlive
   * the component. Its `onComplete` then ran `goTo('demo')`, which writes the onboarding
   * stage key; if the reader had reached the end by then, `finish()` had already cleared
   * that key and the late write resurrected it, putting them back on the demo after a
   * reload. The writes themselves must not be abandoned — they are the point of the
   * screen — so the loop runs on and only the navigation is suppressed.
   */
  const liveRef = useRef(true);
  useEffect(() => {
    return () => {
      liveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchFeed({ seed: Date.now() % 100000, page: 0, cardsBefore: 0, usedBudget: 0, limit: 20 })
      .then((res) => {
        if (!cancelled) setItems(res.rows.slice(0, CENSUS_SIZE));
      })
      .catch(() => {
        // A calibration nobody can load is a step to skip, not a wall. The reader keeps
        // their onboarding; the Delta simply starts from nothing, as it did before.
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const answered = Object.values(levels).filter((l) => l !== 'unknown').length;

  const handleLevelChange = (id: string, level: KnowledgeLevel) => {
    setLevels((prev) => ({ ...prev, [id]: level }));
    // Clears the failure, which was otherwise a one-way latch: `setError(null)` lived only
    // inside `handleFinish`, and the button stopped routing there once `error` was set. So
    // a reader who marked more ideas after a partial failure watched the counter rise,
    // pressed the button, and had those marks dropped without a request being made.
    setError(null);
  };

  /* Advance the gate only if this screen is still the one on screen — see `liveRef`. */
  const finishIfLive = () => {
    if (liveRef.current) onComplete();
  };

  const handleFinish = async () => {
    const marked = unappliedGrades(levels, new Set());
    // Anything already applied is excluded rather than retried — see `applied`.
    const claimed = unappliedGrades(levels, applied);

    if (marked.length === 0) {
      finishIfLive();
      return;
    }
    if (claimed.length === 0) {
      // Everything marked has already landed; a retry has nothing left to send.
      finishIfLive();
      return;
    }

    setSaving(true);
    setError(null);
    const recorded: [string, 'good' | 'easy'][] = [];
    const lost: string[] = [];
    const userId = getCurrentUserId();

    for (const [pullId, grade] of claimed) {
      try {
        await api.gradeRecall(pullId, grade);
        recorded.push([pullId, grade]);
      } catch (e) {
        /*
         * Queued when the request provably never left, dropped otherwise — the same rule
         * `Review.tsx` applies to this same RPC, and for the same reason: `grade_recall`
         * is not replay-safe, so a write that may already have applied must not be
         * retried. This screen is offered exactly once, and it is the only thing that
         * seeds a knowledge model, so losing it to a tunnel is not a small matter; law 3
         * puts offline among the five that stay free.
         */
        if (userId && isOfflineFailure(e)) {
          // `queueMutation` answers whether it actually persisted. It used to swallow an
          // IndexedDB failure and return normally, so in a browser with site data blocked
          // this counted a grade that had reached neither Postgres nor IndexedDB, and the
          // reader was told it was recorded.
          if (await queueMutation(userId, { kind: 'recall', pullId, grade })) {
            recorded.push([pullId, grade]);
            continue;
          }
          console.error('Could not queue calibration for', pullId);
        }
        console.error('Could not record calibration for', pullId, e);
        lost.push(pullId);
      }
    }
    setSaving(false);
    // Keyed by the grade that was actually sent, not by whatever `levels` says now: the
    // reader can change an answer while the save is in flight, and the applied line has to
    // describe the write that happened rather than the answer on screen.
    const settled = new Map([...applied, ...recorded]);
    setApplied(settled);

    if (settled.size === 0) {
      setError('Could not save your calibration just now. You can skip and do this later.');
      return;
    }
    if (lost.length > 0) {
      /*
       * A partial failure used to advance silently. Mark six, have five fail and one
       * land, and the reader was moved on having been told nothing — which is the exact
       * thing this screen was rebuilt to stop doing. "Try again" now retries only the
       * ones that did not land.
       */
      /*
       * Counted over one population, not two. `settled.size` is everything ever applied —
       * including ideas the reader has since unmarked — while `marked.length` is what is
       * marked now, so the two could disagree and print "Saved 1 of 1" directly above
       * "the 1 that did not save".
       */
      const savedOfMarked = marked.filter(([pullId]) => settled.has(pullId)).length;
      setError(
        `Saved ${savedOfMarked} of ${marked.length}. Try again to retry the ${lost.length} ` +
          `that did not — the ones that saved are not re-sent.`,
      );
      return;
    }
    finishIfLive();
  };

  return (
    <div className="stack" style={{ gap: 'var(--space-5)' }}>
      <header>
        <p className="meta">Step 2 of 3 · Prior knowledge</p>
        <h1 style={{ marginTop: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
          What do you already know?
        </h1>
        <p className="meta">
          Mark the ideas you already hold. Each one is recorded against your knowledge model, so the
          Delta can stop showing you what you already know.
        </p>

        <div
          style={{
            border: '1px solid var(--rule)',
            padding: 'var(--space-3) var(--space-4)',
            marginTop: 'var(--space-3)',
            backgroundColor: 'var(--surface-raised)',
          }}
        >
          <span className="meta" style={{ color: 'var(--accent)' }}>
            {answered} {answered === 1 ? 'idea' : 'ideas'} marked
          </span>
        </div>
      </header>

      {items === null ? (
        <p className="meta" role="status">
          Finding ideas to calibrate against…
        </p>
      ) : items.length === 0 ? (
        <p className="meta" role="status">
          Nothing to calibrate against just now — you can skip this and start reading.
        </p>
      ) : (
        <div className="stack" style={{ gap: 'var(--space-4)' }}>
          {items.map((item) => {
            const current = levels[item.id] ?? 'unknown';
            return (
              <div
                key={item.id}
                className="stack"
                style={{
                  border: '1px solid var(--rule)',
                  padding: 'var(--space-4)',
                  backgroundColor: 'var(--surface)',
                  gap: 'var(--space-2)',
                }}
              >
                <p className="meta">
                  <em>{item.work.title}</em>
                </p>

                <h2 style={{ fontSize: 'var(--step-0)', margin: 0, fontWeight: 500 }}>
                  {item.headline}
                </h2>
                <p style={{ color: 'var(--text-soft)', margin: 0 }}>{item.body}</p>

                {/*
                  Recorded answers are shown as recorded and cannot be changed.

                  `grade_recall` multiplies stability rather than setting it, so a corrected
                  grade would compound the first one instead of replacing it — which is why
                  `unappliedGrades` refuses to re-send. But refusing silently while leaving
                  the buttons live let a reader press a new answer, watch it go pressed, and
                  never learn it had been discarded. Locking them is the honest half of the
                  same rule.
                */}
                {applied.has(item.id) ? (
                  <p className="meta" style={{ marginTop: 'var(--space-2)' }}>
                    Recorded as {applied.get(item.id) === 'easy' ? 'known well' : 'familiar'}.
                  </p>
                ) : (
                  <div
                    className="library__filters"
                    role="group"
                    aria-label={`Knowledge level for ${item.headline}`}
                    style={{ marginTop: 'var(--space-2)' }}
                  >
                    <button
                      type="button"
                      className="btn btn--plain library__filter"
                      aria-pressed={current === 'unknown'}
                      disabled={saving}
                      onClick={() => handleLevelChange(item.id, 'unknown')}
                    >
                      New to me
                    </button>
                    <button
                      type="button"
                      className="btn btn--plain library__filter"
                      aria-pressed={current === 'familiar'}
                      disabled={saving}
                      onClick={() => handleLevelChange(item.id, 'familiar')}
                    >
                      Familiar
                    </button>
                    <button
                      type="button"
                      className="btn btn--plain library__filter"
                      aria-pressed={current === 'mastered'}
                      disabled={saving}
                      onClick={() => handleLevelChange(item.id, 'mastered')}
                    >
                      Know it well
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error ? (
        <p className="meta" role="alert" style={{ color: 'var(--accent)' }}>
          {error}
        </p>
      ) : null}

      {error ? (
        <button type="button" className="btn btn--plain" onClick={() => finishIfLive()}>
          {applied.size > 0 ? 'Continue without the rest' : 'Continue without saving'}
        </button>
      ) : null}

      <footer
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid var(--rule)',
          paddingTop: 'var(--space-4)',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        {/* Not disabled while saving. Six sequential RPCs with no timeout can hang for a
            long time on a bad connection, and that is precisely when a reader wants out. */}
        <button type="button" className="btn btn--plain" onClick={onSkip}>
          Skip calibration
        </button>

        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void handleFinish()}
          disabled={saving || items === null}
        >
          {saving ? 'Recording…' : error ? 'Try again' : 'Continue'}
        </button>
      </footer>
    </div>
  );
}
