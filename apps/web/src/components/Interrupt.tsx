import { useEffect, useMemo, useRef, useState } from 'react';
import type { InterruptKind, Stance } from '@wap/schemas';
import { GRADE_LABELS, RECALL_GRADES, type RecallGrade } from '../lib/grades.js';
import { useDictation } from '../lib/use-dictation.js';
import { DICTATION_DISCLOSURE } from '../lib/dictation.js';
import type { FeedRow, ReviewQuestion } from '../lib/types.js';
import { fetchQuestions } from '../lib/questions-api.js';
import { resolveEffectiveKind, toActivityQuestion } from '../lib/review-question.js';
import { gradeCloze, gradeMcq, mcqOptions, whyWrong, type WhyWrong } from '../lib/activities.js';
import { elapsedSince } from '../lib/submission.js';

/** What the reader gave back. Every field is optional — a conviction answer
 *  carries a stance and no grade, a recall answer the reverse. */
export interface InterruptAnswer {
  grade?: RecallGrade;
  stance?: Stance;
  explanation?: string;
  confidence?: 'sure' | 'unsure';
  questionId?: string;
  latencyMs?: number;
  answer?: string;
  kind?: string;
}

export interface InterruptProps {
  kind: InterruptKind;
  /** The card being asked about — usually one the reader met earlier. */
  pull: FeedRow;
  onAnswer: (answer: InterruptAnswer) => void;
  onDismiss: () => void;
}

interface RecallInterruptCardProps {
  pull: FeedRow;
  onAnswer: (a: InterruptAnswer) => void;
  onDismiss: () => void;
}

function RecallInterruptCard({ pull, onAnswer, onDismiss }: RecallInterruptCardProps) {
  const [question, setQuestion] = useState<ReviewQuestion | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  const [sure, setSure] = useState(false);
  const [clozeInput, setClozeInput] = useState('');

  interface AnsweredState {
    kind: 'mcq' | 'cloze';
    pickedOrTyped: string;
    correct: boolean;
    grade: RecallGrade;
    reason: WhyWrong | null;
    latencyMs?: number;
  }
  const [answered, setAnswered] = useState<AnsweredState | null>(null);
  const displayedAtRef = useRef<number | null>(null);

  useEffect(() => {
    displayedAtRef.current = Date.now();
    let cancelled = false;
    fetchQuestions(pull.id).then((qs) => {
      if (!cancelled && qs.length > 0) {
        setQuestion(qs[0]!);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pull.id]);

  const activityQ = useMemo(() => (question ? toActivityQuestion(question) : null), [question]);
  const mcqChoices = useMemo(() => {
    if (!activityQ || activityQ.kind !== 'mcq') return [];
    return mcqOptions(activityQ, activityQ.id);
  }, [activityQ]);

  const effectiveKind = resolveEffectiveKind(activityQ, mcqChoices);

  const chipLabel =
    effectiveKind === 'mcq'
      ? 'Do you still have this? · Multiple choice'
      : effectiveKind === 'cloze'
        ? 'Do you still have this? · Fill the blank'
        : 'Do you still have this?';

  return (
    <section
      className="pull-card"
      aria-labelledby={`interrupt-${pull.id}`}
      style={{ borderColor: 'var(--accent)' }}
    >
      <p className="pull-card__chip" style={{ color: 'var(--accent)' }}>
        {chipLabel}
      </p>
      <hr className="pull-card__rule" />

      <h2 className="pull-card__headline" id={`interrupt-${pull.id}`}>
        {question?.prompt ?? pull.headline}
      </h2>

      {effectiveKind === 'recall' && (
        <>
          {revealed ? (
            <>
              <p className="pull-card__body">{question?.answer ?? pull.body}</p>
              {question?.explanation && (
                <div
                  style={{
                    marginBottom: 'var(--space-4)',
                    borderLeft: '1px solid var(--rule-strong)',
                    paddingLeft: 'var(--space-3)',
                  }}
                >
                  <p className="meta" style={{ marginBottom: 'var(--space-1)' }}>
                    Explanation
                  </p>
                  <p className="meta" style={{ color: 'var(--text-soft)', margin: 0 }}>
                    {question.explanation}
                  </p>
                </div>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {RECALL_GRADES.map((g: RecallGrade) => (
                  <button
                    key={g}
                    type="button"
                    className="btn"
                    onClick={() =>
                      onAnswer({
                        grade: g,
                        confidence: sure ? 'sure' : 'unsure',
                        questionId: question?.id,
                        latencyMs: elapsedSince(revealedAt),
                        answer: question?.answer ?? pull.body,
                        kind: 'recall',
                      })
                    }
                  >
                    {GRADE_LABELS[g]}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-4)',
                flexWrap: 'wrap',
              }}
            >
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
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--step--1)',
                  color: 'var(--text-muted)',
                }}
              >
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                I’m sure
              </label>
            </div>
          )}
        </>
      )}

      {effectiveKind === 'mcq' && (
        <>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              marginBottom: 'var(--space-4)',
            }}
          >
            {mcqChoices.map((opt) => {
              const isSelected = answered?.pickedOrTyped === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  className="btn"
                  aria-pressed={isSelected}
                  disabled={answered !== null}
                  style={{
                    textAlign: 'left',
                    width: '100%',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--step--1)',
                    borderColor: isSelected ? 'var(--accent)' : undefined,
                    fontWeight: isSelected ? 600 : undefined,
                  }}
                  onClick={() => {
                    const latencyMs = elapsedSince(displayedAtRef.current);
                    const res = gradeMcq(opt, activityQ!, sure ? 'sure' : 'unsure', latencyMs);
                    const reason = whyWrong(activityQ!, opt);
                    setAnswered({
                      kind: 'mcq',
                      pickedOrTyped: opt,
                      correct: res.correct,
                      grade: res.grade,
                      reason,
                      latencyMs,
                    });
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>

          {answered === null ? (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--step--1)',
                color: 'var(--text-muted)',
                marginBottom: 'var(--space-2)',
              }}
            >
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
              I’m sure
            </label>
          ) : (
            <div style={{ margin: 'var(--space-4) 0' }}>
              {answered.correct ? (
                <p
                  className="meta"
                  style={{ color: 'var(--accent)', marginBottom: 'var(--space-3)' }}
                >
                  Correct
                </p>
              ) : (
                <p className="meta" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
                  Not quite
                </p>
              )}

              {answered.reason && answered.reason.source === 'distractor' && (
                <div
                  style={{
                    marginBottom: 'var(--space-3)',
                    borderLeft: '1px solid var(--rule-strong)',
                    paddingLeft: 'var(--space-3)',
                  }}
                >
                  <p className="meta" style={{ marginBottom: 'var(--space-1)' }}>
                    Why that’s wrong
                  </p>
                  <p className="meta" style={{ color: 'var(--text-soft)', margin: 0 }}>
                    {answered.reason.why}
                  </p>
                </div>
              )}

              {question?.explanation && (
                <div
                  style={{
                    marginBottom: 'var(--space-3)',
                    borderLeft: '1px solid var(--rule-strong)',
                    paddingLeft: 'var(--space-3)',
                  }}
                >
                  <p className="meta" style={{ marginBottom: 'var(--space-1)' }}>
                    Explanation
                  </p>
                  <p className="meta" style={{ color: 'var(--text-soft)', margin: 0 }}>
                    {question.explanation}
                  </p>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                  marginTop: 'var(--space-4)',
                }}
              >
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() =>
                    onAnswer({
                      grade: answered.grade,
                      confidence: sure ? 'sure' : 'unsure',
                      questionId: question?.id,
                      latencyMs: answered.latencyMs,
                      answer: answered.pickedOrTyped,
                      kind: 'mcq',
                    })
                  }
                >
                  Continue
                </button>
                {answered.correct && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      onAnswer({
                        grade: 'hard',
                        confidence: sure ? 'sure' : 'unsure',
                        questionId: question?.id,
                        latencyMs: answered.latencyMs,
                        answer: answered.pickedOrTyped,
                        kind: 'mcq',
                      })
                    }
                  >
                    That was hard
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {effectiveKind === 'cloze' && (
        <>
          <p
            className="pull-card__body"
            style={{
              fontStyle: 'italic',
              marginBottom: 'var(--space-4)',
            }}
          >
            {activityQ?.cloze ?? question?.cloze}
          </p>

          {answered === null ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!clozeInput.trim()) return;
                const latencyMs = elapsedSince(displayedAtRef.current);
                const res = gradeCloze(
                  clozeInput,
                  activityQ?.answer ?? '',
                  sure ? 'sure' : 'unsure',
                  latencyMs,
                );
                setAnswered({
                  kind: 'cloze',
                  pickedOrTyped: clozeInput,
                  correct: res.correct,
                  grade: res.grade,
                  reason: null,
                  latencyMs,
                });
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-3)',
              }}
            >
              <input
                type="text"
                value={clozeInput}
                placeholder="Type your answer…"
                onChange={(e) => setClozeInput(e.target.value)}
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 'var(--step-0)',
                  border: '1px solid var(--rule-strong)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'transparent',
                  color: 'var(--text)',
                  width: '100%',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-4)',
                  flexWrap: 'wrap',
                }}
              >
                <button type="submit" className="btn btn--primary" disabled={!clozeInput.trim()}>
                  Check answer
                </button>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--step--1)',
                    color: 'var(--text-muted)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={sure}
                    onChange={(e) => setSure(e.target.checked)}
                  />
                  I’m sure
                </label>
              </div>
            </form>
          ) : (
            <div style={{ margin: 'var(--space-4) 0' }}>
              {answered.correct ? (
                <p
                  className="meta"
                  style={{ color: 'var(--accent)', marginBottom: 'var(--space-3)' }}
                >
                  Correct
                </p>
              ) : (
                <div style={{ marginBottom: 'var(--space-3)' }}>
                  <p className="meta" role="alert" style={{ marginBottom: 'var(--space-1)' }}>
                    Not quite
                  </p>
                  <p className="meta" style={{ color: 'var(--text-soft)', margin: 0 }}>
                    Answer: <strong>{activityQ?.answer}</strong>
                  </p>
                </div>
              )}

              {question?.explanation && (
                <div
                  style={{
                    marginBottom: 'var(--space-3)',
                    borderLeft: '1px solid var(--rule-strong)',
                    paddingLeft: 'var(--space-3)',
                  }}
                >
                  <p className="meta" style={{ marginBottom: 'var(--space-1)' }}>
                    Explanation
                  </p>
                  <p className="meta" style={{ color: 'var(--text-soft)', margin: 0 }}>
                    {question.explanation}
                  </p>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                  marginTop: 'var(--space-4)',
                }}
              >
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() =>
                    onAnswer({
                      grade: answered.grade,
                      confidence: sure ? 'sure' : 'unsure',
                      questionId: question?.id,
                      latencyMs: answered.latencyMs,
                      answer: answered.pickedOrTyped,
                      kind: 'cloze',
                    })
                  }
                >
                  Continue
                </button>
                {answered.correct && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      onAnswer({
                        grade: 'hard',
                        confidence: sure ? 'sure' : 'unsure',
                        questionId: question?.id,
                        latencyMs: answered.latencyMs,
                        answer: answered.pickedOrTyped,
                        kind: 'cloze',
                      })
                    }
                  >
                    That was hard
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <div className="pull-card__footer">
        <span className="pull-card__trail">{pull.work.title}</span>
        <button type="button" className="btn btn--plain" onClick={onDismiss}>
          Skip
        </button>
      </div>
    </section>
  );
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
  /* The microphone, the interim preview (a preview the engine may still revise --
     shown under the field, never appended) and the reason it stopped, from the one
     hook `Path.tsx` shares. See `lib/use-dictation.ts`. */
  const dictation = useDictation((text) =>
    setExplanation((prev) => (prev ? prev + ' ' + text.trim() : text.trim())),
  );

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
    return (
      <RecallInterruptCard key={pull.id} pull={pull} onAnswer={onAnswer} onDismiss={onDismiss} />
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
            {dictation.supported && (
              <button
                type="button"
                className="btn btn--plain meta"
                style={{ textDecoration: 'underline' }}
                onClick={dictation.toggle}
              >
                {/* Typography is the ornament — docs/design.md. This read "🎤 Dictate"
                    and "● Listening (click to stop)". The label carries the state, so
                    there is no `aria-pressed` to double-encode it into "Stop, pressed". */}
                {dictation.listening ? 'Stop' : 'Dictate'}
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
          {/* Always mounted: a live region inserted at the same moment as its text is
              usually not announced at all, because there was no region to observe. */}
          <p className="meta" aria-live="polite">
            {dictation.listening ? dictation.interim || 'Listening…' : ''}
          </p>
          {dictation.error ? (
            <p className="meta" role="alert" style={{ color: 'var(--accent)' }}>
              {dictation.error}
            </p>
          ) : null}
          {/* Said where the decision is made, not only in docs/privacy.md; the sentence
              itself lives in lib/dictation.ts so both screens say the same thing. */}
          {dictation.supported ? <p className="meta">{DICTATION_DISCLOSURE}</p> : null}
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
                dictation.stop();
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
