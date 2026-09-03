import { useEffect, useState } from 'react';
import * as api from '../lib/api.js';
import { gradeForLevel, type KnowledgeLevel } from '../lib/calibration.js';
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
  /** Called with the Pull ids that were successfully recorded. */
  onComplete: (calibratedIds: string[]) => void;
  onSkip: () => void;
}

export function KnowledgeCensus({ onComplete, onSkip }: KnowledgeCensusProps) {
  const [items, setItems] = useState<FeedRow[] | null>(null);
  const [levels, setLevels] = useState<Record<string, KnowledgeLevel>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  };

  const handleFinish = async () => {
    const claimed = Object.entries(levels).flatMap(([pullId, lvl]) => {
      const grade = gradeForLevel(lvl);
      return grade ? [[pullId, grade] as const] : [];
    });
    if (claimed.length === 0) {
      onComplete([]);
      return;
    }

    setSaving(true);
    setError(null);
    const recorded: string[] = [];
    for (const [pullId, grade] of claimed) {
      try {
        await api.gradeRecall(pullId, grade);
        recorded.push(pullId);
      } catch (e) {
        // Reported, not swallowed. The previous version could not fail because it never
        // wrote; this one can, and a reader told "calibrated" over a failed write is back
        // to the problem this screen was rebuilt to fix.
        console.error('Could not record calibration for', pullId, e);
      }
    }
    setSaving(false);

    if (recorded.length === 0) {
      setError('Could not save your calibration just now. You can skip and do this later.');
      return;
    }
    onComplete(recorded);
  };

  return (
    <div className="stack" style={{ gap: 'var(--space-5)' }}>
      <header>
        <p className="meta">Step 1 of 2 · Prior Knowledge Calibration</p>
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
                    onClick={() => handleLevelChange(item.id, 'unknown')}
                  >
                    New to me
                  </button>
                  <button
                    type="button"
                    className="btn btn--plain library__filter"
                    aria-pressed={current === 'familiar'}
                    onClick={() => handleLevelChange(item.id, 'familiar')}
                  >
                    Familiar
                  </button>
                  <button
                    type="button"
                    className="btn btn--plain library__filter"
                    aria-pressed={current === 'mastered'}
                    onClick={() => handleLevelChange(item.id, 'mastered')}
                  >
                    Know it well
                  </button>
                </div>
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
        <button type="button" className="btn btn--plain" onClick={onSkip} disabled={saving}>
          Skip calibration
        </button>

        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void handleFinish()}
          disabled={saving || items === null}
        >
          {saving ? 'Recording…' : 'Continue →'}
        </button>
      </footer>
    </div>
  );
}
