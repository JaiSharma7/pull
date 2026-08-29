import { useState } from 'react';
import type { InterruptKind, Stance } from '@wap/schemas';
import { GRADE_LABELS, RECALL_GRADES, type RecallGrade } from '../lib/grades.js';
import type { FeedRow } from '../lib/types.js';

/** What the reader gave back. Every field is optional — a conviction answer
 *  carries a stance and no grade, a recall answer the reverse. */
export interface InterruptAnswer {
  grade?: RecallGrade;
  stance?: Stance;
  explanation?: string;
}

export interface InterruptProps {
  kind: InterruptKind;
  /** The card being asked about — usually one the reader met earlier. */
  pull: FeedRow;
  onAnswer: (answer: InterruptAnswer) => void;
  onDismiss: () => void;
}

/**
 * A question, appearing inside the feed rather than in a Review tab.
 *
 * Every variant is dismissible in one action, and dismissals are recorded:
 * `dismissal_damping` reads them back and lowers the question rate, so a reader
 * who keeps skipping gets asked less. The system backs off rather than nags.
 */
export function Interrupt({ kind, pull, onAnswer, onDismiss }: InterruptProps) {
  const [revealed, setRevealed] = useState(false);
  const [explanation, setExplanation] = useState('');

  const shell = (label: string, children: React.ReactNode) => (
    <section
      className="pull-card"
      aria-labelledby={`interrupt-${pull.id}`}
      style={{ borderColor: 'var(--accent)' }}
    >
      <p className="pull-card__chip" style={{ color: 'var(--accent)' }}>
        {label}
      </p>
      <hr className="pull-card__rule" />
      {children}
      <div className="pull-card__footer">
        <span className="pull-card__trail">{pull.work.title}</span>
        <button type="button" className="btn btn--plain" onClick={onDismiss}>
          Skip
        </button>
      </div>
    </section>
  );

  if (kind === 'recall') {
    return shell(
      'Do you still have this?',
      <>
        <h2 className="pull-card__headline" id={`interrupt-${pull.id}`}>
          {pull.headline}
        </h2>
        {!revealed ? (
          <button type="button" className="btn btn--primary" onClick={() => setRevealed(true)}>
            Show answer
          </button>
        ) : (
          <>
            <p className="pull-card__body">{pull.body}</p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {RECALL_GRADES.map((g: RecallGrade) => (
                <button
                  key={g}
                  type="button"
                  className="btn"
                  onClick={() => onAnswer({ grade: g })}
                >
                  {GRADE_LABELS[g]}
                </button>
              ))}
            </div>
          </>
        )}
      </>,
    );
  }

  if (kind === 'say_it_back') {
    return shell(
      'Say it back',
      <>
        <h2 className="pull-card__headline" id={`interrupt-${pull.id}`}>
          {pull.headline}
        </h2>
        <label className="field">
          <span className="field__label">In your own words</span>
          <textarea
            className="field__textarea"
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            placeholder="What does this actually claim, and why would it matter?"
          />
        </label>
        {revealed && <p className="pull-card__body">{pull.body}</p>}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={explanation.trim().length < 10}
            onClick={() => {
              setRevealed(true);
              onAnswer({ grade: 'good', explanation: explanation.trim() });
            }}
          >
            Compare with the card
          </button>
        </div>
      </>,
    );
  }

  if (kind === 'conviction') {
    return shell(
      'Do you buy this?',
      <>
        <h2 className="pull-card__headline" id={`interrupt-${pull.id}`}>
          {pull.headline}
        </h2>
        <p className="pull-card__body">{pull.body}</p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {(
            [
              ['agree', 'Agree'],
              ['disagree', 'Disagree'],
              ['unsure', 'Not sure'],
            ] as const
          ).map(([stance, label]) => (
            <button key={stance} type="button" className="btn" onClick={() => onAnswer({ stance })}>
              {label}
            </button>
          ))}
        </div>
      </>,
    );
  }

  if (kind === 'counterpull') {
    return shell(
      'The other side',
      <>
        <h2 className="pull-card__headline" id={`interrupt-${pull.id}`}>
          {pull.headline}
        </h2>
        <p className="pull-card__body">{pull.body}</p>
        <p className="meta">Which do you find more convincing?</p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {(
            [
              ['agree', 'This one'],
              ['disagree', 'The other'],
              ['unsure', 'Both, in different cases'],
            ] as const
          ).map(([stance, label]) => (
            <button key={stance} type="button" className="btn" onClick={() => onAnswer({ stance })}>
              {label}
            </button>
          ))}
        </div>
      </>,
    );
  }

  // delta_probe — the cheapest possible calibration of the knowledge model.
  return shell(
    'Quick check',
    <>
      <h2 className="pull-card__headline" id={`interrupt-${pull.id}`}>
        {pull.headline}
      </h2>
      <p className="meta">Did you already know this?</p>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={() => onAnswer({ grade: 'easy' })}>
          Already knew it
        </button>
        <button type="button" className="btn" onClick={() => onAnswer({ grade: 'good' })}>
          Roughly
        </button>
        <button type="button" className="btn" onClick={() => onAnswer({ grade: 'forgot' })}>
          New to me
        </button>
      </div>
    </>,
  );
}
