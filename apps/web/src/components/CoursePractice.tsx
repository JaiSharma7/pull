/**
 * A run of a study course's questions: after a lesson (practice), before the course starts
 * (placement) or across it (review). It fetches the questions' text from the visible view,
 * records that each was shown, and sends every answer to be graded on the server -- queued
 * on the device when the connection is gone (`study-sync.ts`).
 *
 * A placement run reports each question's FIRST answer, so a retry after the feedback showed
 * the answer can never make a lesson look known.
 */
import { useEffect, useRef, useState } from 'react';
import { ReportForm } from './CourseFixes.js';
import { LessonSources } from './CourseParts.js';
import { StudyQuestionCard, type SubmittedAnswer } from './StudyQuestionCard.js';
import { isOfflineFailure } from '../lib/offline.js';
import { sqlState } from '../lib/rpc-error.js';
import {
  asSentence,
  reportRefusal,
  type LessonClaim,
  type ReportReason,
} from '../lib/study-course.js';
import {
  fetchItemClaims,
  fetchQuestions,
  reportContent,
  retireContent,
} from '../lib/study-course-api.js';
import type { PlacementAnswer, StudyQuestion } from '../lib/study-practice.js';
import { sendAnswer, sendProgress } from '../lib/study-sync.js';
import { mutationId } from '../lib/submission.js';

export type PracticeMode = 'practice' | 'placement' | 'review';

export function CoursePractice({
  userId,
  itemIds,
  mode,
  heading,
  doneLabel,
  onDone,
  onLeave,
}: {
  userId: string;
  itemIds: readonly string[];
  mode: PracticeMode;
  heading: string;
  doneLabel: string;
  onDone: (firstAnswers: PlacementAnswer[]) => void;
  onLeave: () => void;
}) {
  const [questions, setQuestions] = useState<StudyQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [fix, setFix] = useState<null | 'report' | 'withdraw'>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [hints, setHints] = useState<Record<string, LessonClaim[] | 'loading' | 'failed'>>({});
  const first = useRef(new Map<string, PlacementAnswer>());
  const shown = useRef(new Set<string>());

  useEffect(() => {
    const controller = new AbortController();
    fetchQuestions(itemIds, controller.signal)
      .then((qs) => {
        if (!controller.signal.aborted) setQuestions(qs);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          isOfflineFailure(e)
            ? 'You look offline. These questions need a connection to open.'
            : 'These questions could not be opened.',
        );
      });
    return () => controller.abort();
  }, [itemIds]);

  const current = questions?.[index] ?? null;

  // Shown once each, when it is on screen: exposure, never proof.
  useEffect(() => {
    if (!current || shown.current.has(current.itemId)) return;
    shown.current.add(current.itemId);
    void sendProgress(userId, {
      clientEventId: mutationId(),
      kind: 'item_shown',
      itemId: current.itemId,
      occurredAt: new Date().toISOString(),
    });
    // After the commit that drew it, so the prompt is there to take focus.
    document.querySelector<HTMLElement>('.study-q__prompt')?.focus();
  }, [current, userId]);

  const finish = () => onDone([...first.current.values()]);

  const next = () => {
    setFix(null);
    setFixError(null);
    setNote(null);
    if (!questions || index + 1 >= questions.length) {
      finish();
      return;
    }
    setIndex(index + 1);
  };

  /** Take the question on screen out of this run -- reported or withdrawn -- and go on. */
  const dropCurrent = (message: string) => {
    if (!questions || !current) return;
    const rest = questions.filter((q) => q.itemId !== current.itemId);
    setFix(null);
    setFixError(null);
    setNote(message);
    setQuestions(rest);
    if (index >= rest.length) finish();
  };

  const answer = (q: StudyQuestion, sub: SubmittedAnswer) => {
    if (!first.current.has(q.itemId)) {
      first.current.set(q.itemId, {
        itemId: q.itemId,
        lessonId: q.lessonId,
        correct: sub.graded.correct,
        grading: sub.graded.grading,
        hinted: sub.hinted,
      });
    }
    const event = {
      clientEventId: mutationId(),
      itemId: q.itemId,
      response: sub.response,
      hinted: sub.hinted,
      ...(sub.selfGrade ? { selfGrade: sub.selfGrade } : {}),
    };
    void sendAnswer(userId, event).then(({ sent, result }) => {
      // The server's grade is the one kept; a first answer takes it when it differs.
      const kept = first.current.get(q.itemId);
      if (result && kept && kept.itemId === result.itemId) {
        first.current.set(q.itemId, {
          ...kept,
          correct: result.correct,
          grading: result.grading,
          hinted: kept.hinted || result.hinted,
        });
      }
      setNote(
        sent === 'queued'
          ? 'Saved on this device. It will be recorded when you reconnect.'
          : sent === 'refused'
            ? 'This question is no longer in your course, so the answer was not kept.'
            : sent === 'failed'
              ? 'This answer could not be saved.'
              : null,
      );
    });
  };

  const hint = (q: StudyQuestion) => {
    const claims = hints[q.itemId];
    if (claims === undefined) {
      setHints((h) => ({ ...h, [q.itemId]: 'loading' }));
      fetchItemClaims(q.itemId)
        .then((cs) => setHints((h) => ({ ...h, [q.itemId]: cs })))
        .catch(() => setHints((h) => ({ ...h, [q.itemId]: 'failed' })));
      return (
        <p className="meta" role="status">
          Loading the passage…
        </p>
      );
    }
    if (claims === 'loading') {
      return (
        <p className="meta" role="status">
          Loading the passage…
        </p>
      );
    }
    if (claims === 'failed' || claims.length === 0) {
      return <p className="meta">The passage is not available just now.</p>;
    }
    return <LessonSources claims={claims} />;
  };

  const failed = (e: unknown) =>
    setFixError(
      isOfflineFailure(e)
        ? 'That has not reached your account — you look offline.'
        : (reportRefusal(sqlState(e)) ?? asSentence(e instanceof Error ? e.message : String(e))),
    );

  const report = async (q: StudyQuestion, reason: ReportReason, text: string | null) => {
    if (working) return;
    setWorking(true);
    try {
      await reportContent('item', q.itemId, reason, text);
      dropCurrent('Reported. The question is held back until you restore it on the course page.');
    } catch (e: unknown) {
      failed(e);
    } finally {
      setWorking(false);
    }
  };

  const withdraw = async (q: StudyQuestion) => {
    if (working) return;
    setWorking(true);
    try {
      await retireContent('item', q.itemId);
      dropCurrent('Withdrawn from this course.');
    } catch (e: unknown) {
      failed(e);
    } finally {
      setWorking(false);
    }
  };

  const leave = (
    <button type="button" className="btn btn--plain meta" onClick={onLeave}>
      {mode === 'placement' ? 'Skip the check' : 'Stop practising'}
    </button>
  );

  if (error) {
    return (
      <section className="stack measure course">
        <div className="course__bar">{leave}</div>
        <p className="remember__error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!questions) {
    return (
      <p className="meta" role="status">
        Loading the questions…
      </p>
    );
  }
  if (!current) {
    return (
      <section className="stack measure course">
        <div className="course__bar">{leave}</div>
        <p>There are no questions to ask here any more.</p>
        <p>
          <button type="button" className="btn btn--primary" onClick={finish}>
            {doneLabel}
          </button>
        </p>
      </section>
    );
  }

  return (
    <section className="stack measure course">
      <div className="course__bar">
        {leave}
        <span className="meta">{heading}</span>
      </div>
      {note && (
        <p className="meta course__notice" role="status">
          {note}
        </p>
      )}
      <StudyQuestionCard
        key={current.itemId}
        question={current}
        label={`Question ${index + 1} of ${questions.length}`}
        onAnswer={(sub) => answer(current, sub)}
        onNext={next}
        nextLabel={index + 1 < questions.length ? 'Next question' : doneLabel}
        renderHint={() => hint(current)}
        renderFixes={() => (
          <details
            className="course__sources course__fix"
            open={fix !== null}
            onToggle={(e) => {
              if (!(e.currentTarget as HTMLDetailsElement).open) {
                setFix(null);
                setFixError(null);
              }
            }}
          >
            <summary>Something wrong with this question?</summary>
            {fix === null && (
              <div className="course__actions">
                <button type="button" className="btn" onClick={() => setFix('report')}>
                  Report it
                </button>
                <button type="button" className="btn btn--plain" onClick={() => setFix('withdraw')}>
                  Withdraw it
                </button>
              </div>
            )}
            {fix === 'report' && (
              <ReportForm
                kind="item"
                working={working}
                error={fixError}
                onSubmit={(reason, text) => void report(current, reason, text)}
                onCancel={() => setFix(null)}
              />
            )}
            {fix === 'withdraw' && (
              <div className="stack course__fix-form">
                <p>
                  Withdrawing this question takes it out of the course for good. Reporting it
                  instead holds it back until you decide.
                </p>
                {fixError && (
                  <p className="remember__error" role="alert">
                    {fixError}
                  </p>
                )}
                <div className="course__actions">
                  <button
                    type="button"
                    className="btn"
                    aria-disabled={working}
                    onClick={() => void withdraw(current)}
                  >
                    {working ? 'Withdrawing…' : 'Withdraw the question'}
                  </button>
                  <button type="button" className="btn btn--plain" onClick={() => setFix(null)}>
                    Keep it
                  </button>
                </div>
              </div>
            )}
          </details>
        )}
      />
    </section>
  );
}
