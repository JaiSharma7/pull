import { useState } from 'react';
import { CURATED_PATHS, type LearningPath, type PathStep } from '../lib/paths.js';

export interface PathsProps {
  onOpenPull?: (pullId: string) => void;
}

export function Paths({ onOpenPull }: PathsProps) {
  const [selectedPath, setSelectedPath] = useState<LearningPath | null>(null);

  if (selectedPath) {
    return (
      <div className="shell__column" style={{ padding: 'var(--space-4) 0' }}>
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <button
            type="button"
            className="btn btn--plain meta"
            style={{ padding: 0, textDecoration: 'underline', marginBottom: 'var(--space-2)' }}
            onClick={() => setSelectedPath(null)}
          >
            ← All Mastery Curricula
          </button>
          <span className="pull-card__chip" style={{ color: 'var(--accent)' }}>
            {selectedPath.category}
          </span>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, margin: 'var(--space-2) 0' }}>
            {selectedPath.title}
          </h1>
          <p className="meta">{selectedPath.subtitle}</p>
          <p className="meta" style={{ marginTop: 'var(--space-1)' }}>
            {selectedPath.steps.length} steps · ~{selectedPath.estimatedMinutes} min total
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {selectedPath.steps.map((step: PathStep) => (
            <article
              key={step.id}
              className="pull-card"
              style={{ borderLeft: '3px solid var(--accent)' }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                }}
              >
                <span className="pull-card__chip">Step {step.order}</span>
                <span className="meta">~{step.estimatedMinutes} min</span>
              </div>
              <h2 className="pull-card__headline" style={{ fontSize: '1.25rem' }}>
                {step.headline}
              </h2>
              <p
                className="meta"
                style={{
                  margin: 'var(--space-2) 0',
                  padding: 'var(--space-2)',
                  background: 'var(--surface)',
                }}
              >
                <strong>Why this step:</strong> {step.rationale}
              </p>
              <div className="pull-card__footer">
                <span className="pull-card__trail">{step.workTitle}</span>
                {onOpenPull && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => onOpenPull(step.id)}
                  >
                    Open Pull →
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="shell__column" style={{ padding: 'var(--space-4) 0' }}>
      <header style={{ marginBottom: 'var(--space-4)' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, marginBottom: 'var(--space-2)' }}>
          Mastery Curricula
        </h1>
        <p className="meta">
          Scaffolded concept progressions. Rather than disconnected summaries, study ideas sequenced
          from foundations to edge cases.
        </p>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {CURATED_PATHS.map((path) => (
          <article key={path.slug} className="pull-card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <span className="pull-card__chip" style={{ color: 'var(--accent)' }}>
                {path.category}
              </span>
              <span className="meta">~{path.estimatedMinutes} min</span>
            </div>
            <h2 className="pull-card__headline" style={{ fontSize: '1.35rem' }}>
              {path.title}
            </h2>
            <p className="pull-card__body" style={{ color: 'var(--text-muted)' }}>
              {path.subtitle}
            </p>
            <div className="pull-card__footer">
              <span className="meta">{path.steps.length} sequenced ideas</span>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setSelectedPath(path)}
              >
                Explore Curricula →
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
