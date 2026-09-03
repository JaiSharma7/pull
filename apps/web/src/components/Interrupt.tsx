import { useEffect, useRef, useState } from 'react';
import type { InterruptKind, Stance } from '@wap/schemas';
import { GRADE_LABELS, RECALL_GRADES, type RecallGrade } from '../lib/grades.js';
import { recognitionSupported, startRecognition } from '../lib/speech.js';
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
  const [listening, setListening] = useState(false);
  /* Shown under the field, never appended. `startRecognition` hands interim words over
     separately for exactly this: they are a preview the engine may still revise. */
  const [interim, setInterim] = useState('');
  const stopListeningRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      stopListeningRef.current?.();
    };
  }, []);

  const toggleListening = () => {
    if (listening) {
      stopListeningRef.current?.();
      setListening(false);
      setInterim('');
    } else {
      const teardown = startRecognition({
        onResult: (text) =>
          setExplanation((prev) => (prev ? prev + ' ' + text.trim() : text.trim())),
        onInterim: setInterim,
        onEnd: () => {
          setListening(false);
          setInterim('');
        },
        onError: () => {
          setListening(false);
          setInterim('');
        },
      });
      stopListeningRef.current = teardown;
      setListening(true);
    }
  };

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
        {/*
          A div, not a label, and the association is explicit.

          The dictate button was placed inside the wrapping `<label>`, where it became the
          first labelable descendant — so the implicit association bound the label to the
          button, and the textarea was left with a placeholder and no accessible name.
          `htmlFor`/`id` says which control the text names, and works with the button
          wherever it sits.
        */}
        <div className="field">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
            }}
          >
            <label className="field__label" htmlFor={`explain-${pull.id}`}>
              In your own words
            </label>
            {recognitionSupported() && (
              <button
                type="button"
                className="btn btn--plain meta"
                style={{ padding: 0, textDecoration: 'underline' }}
                aria-pressed={listening}
                onClick={toggleListening}
              >
                {/* Typography is the ornament — docs/design.md. This read "🎤 Dictate"
                    and "● Listening (click to stop)"; `aria-pressed` carries the state
                    that the bullet was standing in for. */}
                {listening ? 'Stop' : 'Dictate'}
              </button>
            )}
          </div>
          <textarea
            id={`explain-${pull.id}`}
            className="field__textarea"
            // `explanations_text_length` refuses more; a queued explanation that long
            // would be dropped on drain rather than shown back to the reader.
            maxLength={20000}
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            placeholder="What does this actually claim, and why would it matter?"
          />
          {listening ? (
            <p className="meta" aria-live="polite">
              {interim || 'Listening…'}
            </p>
          ) : null}
        </div>
        {revealed ? (
          <>
            <p className="meta">The card said</p>
            <p className="pull-card__body">{pull.body}</p>
            <div
              style={{
                marginTop: 'var(--space-2)',
                marginBottom: 'var(--space-3)',
                padding: 'var(--space-2)',
                borderLeft: '2px solid var(--accent)',
              }}
            >
              {/*
                Called "One more question", not "Socratic Self-Audit". It is one fixed
                sentence shown to every reader on every card — a prompt, which is a
                perfectly good thing to be, and not an audit of anything, which is what
                the heading claimed. A real per-Pull question would be generated once at
                generation time and stored, which law 2 permits and nothing here does.
              */}
              <p className="meta" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                One more question
              </p>
              <p className="meta">
                Did your formulation identify the boundary condition where this idea fails?
              </p>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {RECALL_GRADES.map((g: RecallGrade) => (
                <button
                  key={g}
                  type="button"
                  className="btn"
                  onClick={() => onAnswer({ grade: g, explanation: explanation.trim() })}
                >
                  {GRADE_LABELS[g]}
                </button>
              ))}
            </div>
          </>
        ) : (
          /*
            Revealing and submitting are two steps on purpose. The whole point of
            this variant is seeing your own words next to the card's, so the card
            has to stay on screen after the comparison — submitting here would
            retire the question before the reader had read the thing they asked for.
          */
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={explanation.trim().length < 10}
              onClick={() => {
                if (listening) {
                  stopListeningRef.current?.();
                  setListening(false);
                  setInterim('');
                }
                setRevealed(true);
              }}
            >
              Compare with the card
            </button>
          </div>
        )}
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
  //
  // Only the two answers that claim prior knowledge carry a grade. "New to me"
  // deliberately carries none: it is not a failed retrieval, and sending it as
  // `forgot` would run the FSRS lapse path against a card the reader has never
  // seen — shrinking its stability, permanently raising its difficulty and
  // counting a lapse for honestly saying the idea is new.
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
        <button type="button" className="btn" onClick={() => onAnswer({})}>
          New to me
        </button>
      </div>
    </>,
  );
}
