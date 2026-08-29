import { useCallback, useEffect, useState } from 'react';
import { Meter } from '@wap/ui';
import * as api from '../lib/api.js';
import { GRADE_LABELS, RECALL_GRADES, type RecallGrade } from '../lib/grades.js';
import type { DueReview } from '../lib/types.js';

/**
 * The deliberate recall destination. The feed is the ambient one — most recall
 * happens there, unannounced. This page is for readers who come looking.
 */
export function Review() {
  const [due, setDue] = useState<DueReview[] | null>(null);
  const [revealed, setRevealed] = useState(false);

  const load = useCallback(() => {
    api
      .fetchDueReviews()
      .then(setDue)
      .catch(() => setDue([]));
  }, []);

  useEffect(load, [load]);

  if (!due) return <p className="meta">Loading…</p>;

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
    await api.gradeRecall(card.pullId, g);
    setRevealed(false);
    setDue((d) => (d ?? []).slice(1));
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
