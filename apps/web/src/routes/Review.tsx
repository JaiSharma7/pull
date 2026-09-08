import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Meter } from '@wap/ui';
import * as api from '../lib/api.js';
import { GRADE_LABELS, RECALL_GRADES, type RecallGrade } from '../lib/grades.js';
import { isOfflineFailure, pendingRecallPullIds, queueMutation } from '../lib/offline.js';
import {
  elapsedSince,
  mutationId as newMutationId,
  nextSubmissionStamp,
} from '../lib/submission.js';
import { getCurrentUserId } from '../lib/supabase.js';
import type { DueReview } from '../lib/types.js';
import {
  formatReviewProgress,
  resolveActiveQuestion,
  resolveEffectiveKind,
  toActivityQuestion,
} from '../lib/review-question.js';
import { gradeCloze, gradeMcq, mcqOptions, whyWrong, type WhyWrong } from '../lib/activities.js';

interface ActiveReviewCardProps {
  card: DueReview;
  grading: boolean;
  onGrade: (
    g: RecallGrade,
    latencyMs?: number,
    extra?: {
      confidence?: 'sure' | 'unsure';
      questionId?: string;
      answer?: string;
    },
  ) => void;
}

function ActiveReviewCard({ card, grading, onGrade }: ActiveReviewCardProps) {
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
  }, []);

  const activeQuestion = resolveActiveQuestion(card);
  const activityQ = useMemo(
    () => (activeQuestion ? toActivityQuestion(activeQuestion) : null),
    [activeQuestion],
  );

  const mcqChoices = useMemo(() => {
    if (!activityQ || activityQ.kind !== 'mcq') return [];
    return mcqOptions(activityQ, activityQ.id);
  }, [activityQ]);

  const effectiveKind = resolveEffectiveKind(activityQ, mcqChoices);

  return (
    <div className="pull-card">
      <p className="pull-card__chip">
        {card.workTitle}
        {card.questionSource === 'user' && ' · Your question'}
        {effectiveKind === 'mcq' && ' · Multiple choice'}
        {effectiveKind === 'cloze' && ' · Fill the blank'}
      </p>
      <hr className="pull-card__rule" />
      <h2 className="pull-card__headline">
        {activeQuestion?.prompt ?? card.question ?? card.headline}
      </h2>

      {effectiveKind === 'recall' && (
        <>
          {revealed ? (
            <>
              <p className="pull-card__body">{activeQuestion?.answer ?? card.body}</p>
              {(activeQuestion?.explanation ?? card.explanation) && (
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
                    {activeQuestion?.explanation ?? card.explanation}
                  </p>
                </div>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {RECALL_GRADES.map((g) => (
                  <button
                    key={g}
                    type="button"
                    className="btn"
                    disabled={grading}
                    onClick={() =>
                      onGrade(g, elapsedSince(revealedAt), {
                        confidence: sure ? 'sure' : 'unsure',
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
                <input
                  type="checkbox"
                  checked={sure}
                  disabled={grading}
                  onChange={(e) => setSure(e.target.checked)}
                />
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
              margin: 'var(--space-4) 0',
            }}
          >
            {mcqChoices.map((opt) => {
              const isPicked = answered?.pickedOrTyped === opt;
              const isTargetAnswer = (activeQuestion?.answer ?? '').trim() === opt.trim();
              const showCorrect = answered !== null && isTargetAnswer;
              const showIncorrect = answered !== null && isPicked && !answered.correct;

              let borderColor = 'var(--rule-strong)';
              let textColor = 'var(--text)';

              if (showCorrect) {
                borderColor = 'var(--accent)';
                textColor = 'var(--accent)';
              } else if (showIncorrect) {
                borderColor = 'var(--rule)';
                textColor = 'var(--text-muted)';
              }

              return (
                <button
                  key={opt}
                  type="button"
                  className="btn"
                  disabled={answered !== null || grading}
                  style={{
                    textAlign: 'left',
                    textTransform: 'none',
                    letterSpacing: 'normal',
                    fontFamily: 'var(--font-body)',
                    fontSize: 'var(--step-0)',
                    padding: 'var(--space-3) var(--space-4)',
                    borderColor,
                    color: textColor,
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
              <input
                type="checkbox"
                checked={sure}
                disabled={grading}
                onChange={(e) => setSure(e.target.checked)}
              />
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

              {(activeQuestion?.explanation ?? card.explanation) && (
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
                    {activeQuestion?.explanation ?? card.explanation}
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
                  disabled={grading}
                  onClick={() =>
                    onGrade(answered.grade, answered.latencyMs, {
                      confidence: sure ? 'sure' : 'unsure',
                      answer: answered.pickedOrTyped,
                    })
                  }
                >
                  Continue
                </button>
                {answered.correct && (
                  <button
                    type="button"
                    className="btn"
                    disabled={grading}
                    onClick={() =>
                      onGrade('hard', answered.latencyMs, {
                        confidence: sure ? 'sure' : 'unsure',
                        answer: answered.pickedOrTyped,
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
          {activeQuestion?.cloze && (
            <p
              className="pull-card__body"
              style={{ fontStyle: 'italic', margin: 'var(--space-3) 0 var(--space-4)' }}
            >
              {activeQuestion.cloze}
            </p>
          )}

          {answered === null ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = clozeInput.trim();
                if (!trimmed) return;
                const latencyMs = elapsedSince(displayedAtRef.current);
                const res = gradeCloze(
                  trimmed,
                  activeQuestion!.answer ?? '',
                  sure ? 'sure' : 'unsure',
                  latencyMs,
                );
                setAnswered({
                  kind: 'cloze',
                  pickedOrTyped: trimmed,
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
                margin: 'var(--space-4) 0',
              }}
            >
              <input
                type="text"
                value={clozeInput}
                disabled={grading}
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
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={!clozeInput.trim() || grading}
                >
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
                    disabled={grading}
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
                  style={{ color: 'var(--accent)', marginBottom: 'var(--space-2)' }}
                >
                  Correct
                </p>
              ) : (
                <p className="meta" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
                  Not quite
                </p>
              )}

              <p className="meta" style={{ marginBottom: 'var(--space-3)' }}>
                Answer: <strong style={{ color: 'var(--text)' }}>{activeQuestion?.answer}</strong>
              </p>

              {(activeQuestion?.explanation ?? card.explanation) && (
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
                    {activeQuestion?.explanation ?? card.explanation}
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
                  disabled={grading}
                  onClick={() =>
                    onGrade(answered.grade, answered.latencyMs, {
                      confidence: sure ? 'sure' : 'unsure',
                      answer: answered.pickedOrTyped,
                    })
                  }
                >
                  Continue
                </button>
                {answered.correct && (
                  <button
                    type="button"
                    className="btn"
                    disabled={grading}
                    onClick={() =>
                      onGrade('hard', answered.latencyMs, {
                        confidence: sure ? 'sure' : 'unsure',
                        answer: answered.pickedOrTyped,
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

      <div style={{ marginTop: 'var(--space-5)' }}>
        <p className="meta" style={{ marginBottom: 'var(--space-2)' }}>
          Strength {Math.round(card.retrievability * 100)}%
        </p>
        <Meter value={card.retrievability} label={`Recall strength for ${card.headline}`} />
      </div>
    </div>
  );
}

/**
 * The deliberate recall destination. The feed is the ambient one — most recall
 * happens there, unannounced. This page is for readers who come looking.
 */
export function Review() {
  const [due, setDue] = useState<DueReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [lostGrade, setLostGrade] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [grading, setGrading] = useState(false);
  const graded = useRef<Set<string>>(new Set());
  const [reloads, setReloads] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [sessionTotal, setSessionTotal] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const userId = getCurrentUserId();
    Promise.all([
      api.fetchDueReviews(),
      userId === null ? Promise.resolve(new Set<string>()) : pendingRecallPullIds(userId),
    ])
      .then(([rows, queuedFor]) => {
        if (cancelled) return;
        const filtered = rows.filter(
          (row) => !graded.current.has(row.pullId) && !(queuedFor?.has(row.pullId) ?? false),
        );
        setDue(filtered);
        setSessionTotal((prev) =>
          prev === null ? filtered.length : Math.max(prev, filtered.length + answeredCount),
        );
        setOffline(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error('Due reviews request failed', e);
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloads, answeredCount]);

  const retry = useCallback(() => {
    setError(null);
    setDue(null);
    setAnsweredCount(0);
    setSessionTotal(null);
    setReloads((n) => n + 1);
  }, []);

  const notices = (
    <>
      {signedOut ? (
        <p className="meta" role="alert">
          Your session ended before that grade could be saved. Sign in again and those ideas will
          come round as they were.
        </p>
      ) : lostGrade ? (
        <p className="meta" role="alert">
          That grade could not be saved, here or on this device. Those ideas will come round again.
        </p>
      ) : null}
    </>
  );

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Review</p>
        <h1>Could not check what is fading.</h1>
        {notices}
        <p>
          {offline
            ? 'You appear to be offline, so this could not be checked. It does not mean nothing is due.'
            : lostGrade || signedOut
              ? 'Something went wrong reaching your review schedule.'
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
      <section className="stack measure">
        {notices}
        <p className="meta" role="status">
          Loading…
        </p>
      </section>
    );

  if (due.length === 0) {
    return (
      <section className="stack measure">
        <p className="meta">Review</p>
        <h1>Nothing is fading.</h1>
        {notices}
        <p>
          {lostGrade || signedOut
            ? 'Nothing else is due. The idea above will come round again.'
            : 'Everything you have saved is still solid. Come back when something slips.'}
        </p>
      </section>
    );
  }

  const card = due[0]!;

  async function grade(
    g: RecallGrade,
    latencyMs?: number,
    extra?: {
      confidence?: 'sure' | 'unsure';
      questionId?: string;
      answer?: string;
    },
  ) {
    if (grading) return;
    setGrading(true);
    let mutationId: string | null = null;
    let submittedAt: number | null = null;
    const activeQuestion = resolveActiveQuestion(card);
    const qid = extra?.questionId ?? activeQuestion?.id ?? card.questionId;
    try {
      mutationId = newMutationId();
      submittedAt = nextSubmissionStamp();
      await api.gradeRecall(card.pullId, g, {
        mutationId,
        submittedAt,
        kind: 'review',
        ...(qid ? { questionId: qid } : {}),
        ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
        ...(extra?.confidence ? { confidence: extra.confidence } : {}),
        ...(extra?.answer ? { answer: extra.answer } : {}),
      });
      setSignedOut(false);
    } catch (e: unknown) {
      const userId = getCurrentUserId();
      const queued =
        mutationId !== null &&
        submittedAt !== null &&
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
            ...(qid ? { questionId: qid } : {}),
            ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
            ...(extra?.confidence ? { confidence: extra.confidence } : {}),
            ...(extra?.answer ? { answer: extra.answer } : {}),
          },
          e,
        ));

      if (!queued) {
        setLostGrade(true);
        if (userId === null) setSignedOut(true);
        console.error('Recall grade was not recorded', e);
      }
    } finally {
      setGrading(false);
      graded.current.add(card.pullId);
      setAnsweredCount((n) => n + 1);
      const rest = (due ?? []).slice(1);
      setDue(rest.length === 0 ? null : rest);
      if (rest.length === 0) setReloads((n) => n + 1);
    }
  }

  const currentNumber = answeredCount + 1;
  const totalNumber = sessionTotal ?? due.length;

  return (
    <section className="stack measure">
      <p className="meta">{formatReviewProgress(currentNumber, totalNumber)}</p>

      {notices}

      <ActiveReviewCard
        key={card.pullId}
        card={card}
        grading={grading}
        onGrade={(g, latencyMs, extra) => void grade(g, latencyMs, extra)}
      />
    </section>
  );
}
