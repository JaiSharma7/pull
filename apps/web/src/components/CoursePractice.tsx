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
import {
  confirmFirst,
  firstAnswer,
  type PlacementAnswer,
  type StudyQuestion,
} from '../lib/study-practice.js';
import {
  flushJudging,
  holdJudging,
  releaseJudging,
  sendAnswer,
  sendProgress,
} from '../lib/study-sync.js';
import { mutationId } from '../lib/submission.js';

export type PracticeMode = 'practice' | 'placement' | 'review';

/** How long finishing waits for answers still on their way before it goes on without them. */
const FINISH_WAIT_MS = 8000;

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
  // The form on screen, for a failure that lands after the reader closed it.
  const fixShown = useRef<null | 'report' | 'withdraw'>(null);
  useEffect(() => {
    fixShown.current = fix;
  }, [fix]);
  const [fixError, setFixError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [hints, setHints] = useState<Record<string, LessonClaim[] | 'loading' | 'failed'>>({});
  const first = useRef(new Map<string, PlacementAnswer>());
  const shown = useRef(new Set<string>());
  // Answers on their way: a placement run's suggestion waits for the server's grades.
  const sending = useRef(new Set<Promise<unknown>>());
  // The event id of the answer held while its reader judges it: the judgement is sent under
  // it, so a hold sent meanwhile and the judgement are one answer to the server.
  const heldId = useRef<string | null>(null);
  const fixPanel = useRef<HTMLDetailsElement>(null);
  const [finishing, setFinishing] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The run as it stands now, for a report or a withdrawal that lands after the reader moved on.
  const latest = useRef<{ questions: StudyQuestion[] | null; index: number }>({
    questions: null,
    index: 0,
  });

  // An answer left unjudged -- by a page that closed while its reader judged it, or by this
  // run when it ends -- is recorded as not had (`study-sync.ts`).
  useEffect(() => {
    void flushJudging(userId);
    return () => {
      void flushJudging(userId, { own: true });
    };
  }, [userId]);

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
  // The run starts at its heading, as the course's other screens do, and a failure to open it
  // is said where focus is.
  useEffect(() => {
    document.getElementById('practice-title')?.focus();
  }, []);
  useEffect(() => {
    if (error) document.getElementById('practice-error')?.focus();
  }, [error]);
  // A run emptied by reports and withdrawals says so where focus is, rather than leaving it on
  // the page when the last question goes.
  const empty = questions !== null && current === null;
  useEffect(() => {
    if (empty) document.getElementById('practice-empty')?.focus();
  }, [empty]);
  // Withdrawing asks first, and the question it asks is where focus goes.
  useEffect(() => {
    if (fix === 'withdraw') document.getElementById('practice-withdraw-warning')?.focus();
  }, [fix]);
  useEffect(() => {
    latest.current = { questions, index };
  }, [questions, index]);

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

  const finish = () => {
    if (finishing) return;
    setFinishing(true);
    // What a first answer shows is the server's grade, so the answers still on their way are
    // waited for -- a while, and said: one that never comes has no grade, and counts for
    // nothing either way. In every mode, not only placement: the course reads its questions
    // again as the run hands back, and what it shows next should follow these answers.
    if (sending.current.size > 0) setNote('Waiting for your answers to be recorded…');
    void Promise.race([
      Promise.allSettled([...sending.current]),
      new Promise((resolve) => setTimeout(resolve, FINISH_WAIT_MS)),
    ]).then(() => {
      if (alive.current) onDone([...first.current.values()]);
    });
  };

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

  /**
   * Take a question out of this run -- reported or withdrawn -- and go on. Judged against the
   * run as it is when the request lands: the reader may have gone on to another question since.
   * Its first answer goes too, so a question the reader said is wrong cannot make a lesson
   * look known.
   */
  const drop = (itemId: string, message: string) => {
    const { questions: qs, index: at } = latest.current;
    if (!qs) return;
    const where = qs.findIndex((q) => q.itemId === itemId);
    if (where < 0) return;
    const rest = qs.filter((q) => q.itemId !== itemId);
    first.current.delete(itemId);
    if (where === at) {
      setFix(null);
      setFixError(null);
      // Reported while being judged: the reader said the question is wrong, so it is not
      // recorded as not had. Only its own hold: one the question before it left, a judgement
      // still on its way, stays until that lands.
      if (heldId.current) releaseJudging(userId, heldId.current);
      heldId.current = null;
    }
    setNote(message);
    setQuestions(rest);
    // Past the last question, the run says there are none left -- with the note beside it --
    // rather than ending before the reader has heard why.
    setIndex(where < at ? at - 1 : at);
  };

  const answer = (q: StudyQuestion, sub: SubmittedAnswer) => {
    // A judgement is sent under its hold's id, and replaces the hold until it is recorded or
    // queued: a page closed in between still sends it -- as judged, and as the same answer.
    const held = sub.selfGrade ? heldId.current : null;
    heldId.current = null;
    const event = {
      clientEventId: held ?? mutationId(),
      itemId: q.itemId,
      response: sub.response,
      hinted: sub.hinted,
      ...(sub.selfGrade ? { selfGrade: sub.selfGrade } : {}),
    };
    if (held) holdJudging(userId, event);
    if (!first.current.has(q.itemId)) {
      first.current.set(
        q.itemId,
        firstAnswer(
          q,
          { correct: sub.graded.correct, grading: sub.graded.grading, hinted: sub.hinted },
          event.clientEventId,
        ),
      );
    }
    const sent = sendAnswer(userId, event).then(({ sent, result }) => {
      if (held) releaseJudging(userId, held);
      // The server's grade is the one kept, and a first answer counts only once it has one --
      // its own, not a retry's.
      const kept = first.current.get(q.itemId);
      if (result && kept) first.current.set(q.itemId, confirmFirst(kept, result));
      // Said only when there is something to say: an answer recorded as expected is silent,
      // and clearing the line then wiped whatever it said meanwhile -- a report's "Reported".
      const said =
        sent === 'queued'
          ? 'Saved on this device. It will be recorded when you reconnect.'
          : sent === 'full'
            ? 'Today’s record of answers is full. This one is kept on this device and recorded tomorrow.'
            : sent === 'refused'
              ? 'This question is no longer in your course, so the answer was not kept.'
              : sent === 'failed'
                ? 'This answer could not be saved.'
                : null;
      if (said) setNote(said);
    });
    sending.current.add(sent);
    void sent.finally(() => sending.current.delete(sent));
  };

  /** Fetch a question's passage when the reader opens it: from the press, not from a render. */
  const loadHint = (q: StudyQuestion) => {
    if (hints[q.itemId] !== undefined && hints[q.itemId] !== 'failed') return;
    setHints((h) => ({ ...h, [q.itemId]: 'loading' }));
    fetchItemClaims(q.itemId)
      .then((cs) => setHints((h) => ({ ...h, [q.itemId]: cs })))
      .catch(() => setHints((h) => ({ ...h, [q.itemId]: 'failed' })));
  };

  const hint = (q: StudyQuestion) => {
    const claims = hints[q.itemId];
    if (claims === undefined || claims === 'loading') {
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

  // Said beside the form while it is on screen; with the form gone -- the panel folded, or
  // opened again on its choices -- in the note line, which is always there to say it.
  const failed = (e: unknown) => {
    const why = isOfflineFailure(e)
      ? 'That has not reached your account — you look offline.'
      : (reportRefusal(sqlState(e)) ?? asSentence(e instanceof Error ? e.message : String(e)));
    if (fixPanel.current?.open && fixShown.current !== null) setFixError(why);
    else setNote(why);
  };

  const report = async (q: StudyQuestion, reason: ReportReason, text: string | null) => {
    if (working) return;
    setWorking(true);
    try {
      await reportContent('item', q.itemId, reason, text);
      drop(
        q.itemId,
        'Reported. The question is held back until you restore it on the course page.',
      );
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
      drop(q.itemId, 'Withdrawn from this course.');
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
  // A run is a screen of its own, and starts at a heading as the course's others do.
  const title = (
    <h1 className="course__lesson-heading" id="practice-title" tabIndex={-1}>
      {heading}
    </h1>
  );
  // Always drawn, empty or not: a live region added together with its text is not reliably
  // announced.
  const noteLine = (
    <p className={note ? 'meta course__notice' : 'sr-only'} role="status">
      {note}
    </p>
  );

  if (error) {
    return (
      <section className="stack measure course">
        <div className="course__bar">{leave}</div>
        {title}
        {/* Focused when it appears, which says it; an alert as well said it twice. */}
        <p className="remember__error" id="practice-error" tabIndex={-1}>
          {error}
        </p>
        {/* After a lesson the questions are a detour: going on is the way forward. */}
        {mode === 'practice' && (
          <p>
            <button type="button" className="btn btn--primary" onClick={onLeave}>
              Go on
            </button>
          </p>
        )}
      </section>
    );
  }
  if (!questions) {
    return (
      <section className="stack measure course">
        <div className="course__bar">{leave}</div>
        {title}
        <p className="meta" role="status">
          Loading the questions…
        </p>
      </section>
    );
  }
  if (!current) {
    return (
      <section className="stack measure course">
        <div className="course__bar">{leave}</div>
        {title}
        {noteLine}
        <p id="practice-empty" tabIndex={-1}>
          There are no questions to ask here any more.
        </p>
        <p>
          <button
            type="button"
            className="btn btn--primary"
            aria-disabled={finishing}
            onClick={finish}
          >
            {doneLabel}
          </button>
        </p>
      </section>
    );
  }

  const closeFix = () => {
    if (working) return;
    setFix(null);
    setFixError(null);
    document.getElementById('practice-fix-summary')?.focus();
  };

  return (
    <section className="stack measure course">
      <div className="course__bar">{leave}</div>
      {title}
      {noteLine}
      <StudyQuestionCard
        key={current.itemId}
        question={current}
        label={`Question ${index + 1} of ${questions.length}`}
        onAnswer={(sub) => answer(current, sub)}
        onJudging={(held) => {
          // Judged: `answer` takes the hold over.
          if (held === null) return;
          heldId.current = mutationId();
          holdJudging(userId, {
            clientEventId: heldId.current,
            itemId: current.itemId,
            response: held.response,
            selfGrade: 'incorrect',
            ...(held.hinted ? { hinted: true } : {}),
          });
        }}
        nextBusy={finishing}
        onHintOpen={() => loadHint(current)}
        onNext={next}
        nextLabel={index + 1 < questions.length ? 'Next question' : doneLabel}
        renderHint={() => hint(current)}
        renderFixes={() => (
          // Not controlled: Cancel closes a form, not the section the reader opened, and
          // focus goes back to its summary rather than to the page.
          <details
            ref={fixPanel}
            className="course__sources course__fix"
            onToggle={(e) => {
              if (!(e.currentTarget as HTMLDetailsElement).open) {
                setFix(null);
                setFixError(null);
              }
            }}
          >
            <summary id="practice-fix-summary">Something wrong with this question?</summary>
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
                onCancel={closeFix}
              />
            )}
            {fix === 'withdraw' && (
              <div className="stack course__fix-form">
                <p id="practice-withdraw-warning" tabIndex={-1}>
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
                  <button
                    type="button"
                    className="btn btn--plain"
                    aria-disabled={working}
                    onClick={closeFix}
                  >
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
