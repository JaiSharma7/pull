import { useEffect, useMemo, useRef, useState } from 'react';
import type { InterruptKind, Stance } from '@wap/schemas';
import { GRADE_LABELS, RECALL_GRADES, type RecallGrade } from '../lib/grades.js';
import { recognitionSupported, startRecognition } from '../lib/speech.js';
import type { FeedRow, ReviewQuestion } from '../lib/types.js';
import { fetchQuestions } from '../lib/questions-api.js';
import {
  mcqOptionMarker,
  resolveEffectiveKind,
  toActivityQuestion,
} from '../lib/review-question.js';
import { gradeCloze, gradeMcq, mcqOptions, whyWrong, type WhyWrong } from '../lib/activities.js';
import { elapsedSince } from '../lib/submission.js';
import { onceInView } from '../lib/in-view.js';

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
  /*
   * WHEN THE QUESTION WAS ACTUALLY PUT TO THE READER.
   *
   * This was set as the first statement of the mount effect, before `fetchQuestions`
   * resolved -- and `Feed.tsx` mounts every interrupt at once, including cards far
   * below the fold. So the clock started while the question was still in flight and
   * the card still off screen, and the "latency" the MCQ and cloze graders split
   * `easy` from `good` on included the fetch and however long the reader spent on the
   * cards above. Those are exactly the two deterministic graders, so this corrupted the
   * memory model's inputs on both kinds Package 3 introduced.
   *
   * Started once the question has arrived AND the card is in view -- `onceInView` in
   * `lib/in-view.ts` says what "in view" means and why the flag alone was not enough.
   * Where there is no `IntersectionObserver` it starts when the question arrives, which
   * is still after the fetch. Left `null` until then, and `elapsedSince(null)` is
   * `undefined`: no measurement rather than a false one, which is the rule
   * `lib/submission.ts` already states for the column.
   */
  const displayedAtRef = useRef<number | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
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

  useEffect(() => {
    if (!question) return;
    const el = cardRef.current;
    if (!el) {
      displayedAtRef.current ??= Date.now();
      return;
    }
    return onceInView(el, () => {
      displayedAtRef.current ??= Date.now();
    });
  }, [question]);

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
      ref={cardRef}
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
                    /* No `answer`. Free recall is self-graded with no text input, so
                       there is nothing the reader wrote -- and this used to send the
                       stored reference answer, or failing that the card's own body, into
                       the one column that holds what a reader actually said. */
                    onClick={() =>
                      onAnswer({
                        grade: g,
                        confidence: sure ? 'sure' : 'unsure',
                        questionId: question?.id,
                        latencyMs: elapsedSince(revealedAt),
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
              /* Law 5: the word carries the verdict, and the colour agrees with it. */
              const marker = mcqOptionMarker(
                opt,
                activityQ?.answer,
                answered?.pickedOrTyped ?? null,
              );
              return (
                <button
                  key={opt}
                  type="button"
                  className="btn"
                  aria-pressed={isSelected}
                  disabled={answered !== null}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 'var(--space-3)',
                    textAlign: 'left',
                    width: '100%',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--step--1)',
                    /* The colour agrees with the word: the correct option in the accent,
                       a wrong pick muted, exactly as Review.tsx has it. Before this the
                       wrong pick was the most emphasised button on the screen. */
                    borderColor:
                      marker === 'Correct answer'
                        ? 'var(--accent)'
                        : marker === 'Your answer'
                          ? 'var(--rule)'
                          : undefined,
                    color: marker === 'Your answer' ? 'var(--text-muted)' : undefined,
                    fontWeight: marker === 'Correct answer' ? 600 : undefined,
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
                  <span>{opt}</span>
                  {marker ? <span className="meta">{marker}</span> : null}
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
  const [listening, setListening] = useState(false);
  /* Shown under the field, never appended. `startRecognition` hands interim words over
     separately for exactly this: they are a preview the engine may still revise. */
  const [interim, setInterim] = useState('');
  /* A refused microphone, or an engine that would not start. Silence here read as a
     button that flicked back to "Dictate" for no stated reason. */
  const [dictationError, setDictationError] = useState<string | null>(null);
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
      return;
    }

    let failed = false;
    setDictationError(null);
    const teardown = startRecognition({
      onResult: (text) => setExplanation((prev) => (prev ? prev + ' ' + text.trim() : text.trim())),
      onInterim: setInterim,
      onEnd: () => {
        setListening(false);
        setInterim('');
      },
      onError: () => {
        failed = true;
        setListening(false);
        setInterim('');
        setDictationError(
          'Could not start dictation — your browser may have refused the microphone.',
        );
      },
    });
    stopListeningRef.current = teardown;
    if (!failed) setListening(true);
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
            {recognitionSupported() && (
              <button
                type="button"
                className="btn btn--plain meta"
                style={{ textDecoration: 'underline' }}
                onClick={toggleListening}
              >
                {/* Typography is the ornament — docs/design.md. This read "🎤 Dictate"
                    and "● Listening (click to stop)". The label carries the state, so
                    there is no `aria-pressed` to double-encode it into "Stop, pressed". */}
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
          {/* Always mounted: a live region inserted at the same moment as its text is
              usually not announced at all, because there was no region to observe. */}
          <p className="meta" aria-live="polite">
            {listening ? interim || 'Listening…' : ''}
          </p>
          {dictationError ? (
            <p className="meta" role="alert" style={{ color: 'var(--accent)' }}>
              {dictationError}
            </p>
          ) : null}
          {recognitionSupported() ? (
            /* Said where the decision is made, not only in docs/privacy.md. In most
               browsers speech recognition is not on the device — the audio goes to the
               browser's own vendor. It never reaches us, but it does leave
               the reader's machine, and they are about to press the button that does it. */
            <p className="meta">
              Dictation uses your browser's speech recognition, which in most browsers sends the
              audio to your browser's vendor. We never receive it. Typing sends nothing.
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
