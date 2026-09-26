import { Meter } from '@wap/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CourseOutline,
  CourseRecap,
  LessonBody,
  LessonSources,
  Paragraphs,
  PassageInContext,
  StoppingPoint,
} from '../components/CourseParts.js';
import { HeldBackList, LessonCorrectionForm, ReportForm } from '../components/CourseFixes.js';
import { isOfflineFailure } from '../lib/offline.js';
import { sqlDetail, sqlState } from '../lib/rpc-error.js';
import {
  localVoiceURI,
  onVoicesChanged,
  speak,
  speechSupported,
  stopSpeaking,
} from '../lib/speech.js';
import {
  allLessons,
  applyProgress,
  asSentence,
  awaitingPreparation,
  courseProgressLabel,
  correctionRefusal,
  courseStatus,
  courseTitle,
  lessonDraft,
  lessonRevision,
  newerPreparationFailed,
  nextLesson,
  passageWindow,
  planSession,
  preparationRefusal,
  reportRefusal,
  type CourseSummary,
  type LessonClaim,
  type LessonContent,
  type LessonDraft,
  type OutlineLesson,
  type OutlineUnit,
  type ProgressEvent,
  type ProgressKind,
  type ReportReason,
} from '../lib/study-course.js';
import {
  deleteCourse,
  dismissReport,
  fetchCourse,
  fetchHeldBack,
  fetchLesson,
  fetchOutline,
  fetchSourceText,
  recordProgress,
  regenerateCourse,
  reportContent,
  retireContent,
  reviseLesson,
  type HeldBack,
} from '../lib/study-course-api.js';
import { mutationId } from '../lib/submission.js';

/** How often a course being prepared is looked at again. */
const PREPARING_POLL_MS = 15_000;

type View =
  | { kind: 'overview' }
  | { kind: 'session'; plan: string[]; index: number }
  | { kind: 'stop'; plan: string[] };

export function Course({
  courseId,
  onNavigate,
  onTitle,
}: {
  courseId: string;
  onNavigate: (to: string) => void;
  onTitle?: (title: string | null) => void;
}) {
  const [course, setCourse] = useState<CourseSummary | null>(null);
  const [units, setUnits] = useState<OutlineUnit[]>([]);
  const [settled, setSettled] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>({ kind: 'overview' });
  const [lesson, setLesson] = useState<LessonContent | null>(null);
  const [lessonError, setLessonError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<Pick<ProgressEvent, 'kind' | 'lessonId'>[]>([]);
  const [progressNote, setProgressNote] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [listening, setListening] = useState(false);
  const [recaps, setRecaps] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [armed, setArmed] = useState(false);
  // Fixing the lesson on screen: which form is open, and a claim being reported.
  const [fix, setFix] = useState<null | 'report' | 'correct' | 'withdraw'>(null);
  const [claimReport, setClaimReport] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo: string | null } | null>(null);
  const [held, setHeld] = useState<HeldBack[]>([]);
  const pending = useRef<ProgressEvent[]>([]);
  const regeneration = useRef<string | null>(null);
  const shownFor = useRef<string | null>(null);

  // ---------------------------------------------------------------- loading
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const summary = await fetchCourse(courseId, controller.signal);
      if (controller.signal.aborted) return;
      if (!summary) {
        setMissing(true);
        setSettled(true);
        onTitle?.(null);
        return;
      }
      const [outline, heldBack] = summary.generationId
        ? await Promise.all([
            fetchOutline(courseId, controller.signal),
            fetchHeldBack(summary.generationId, controller.signal),
          ])
        : [[], []];
      if (controller.signal.aborted) return;
      setCourse(summary);
      setUnits(outline);
      setHeld(heldBack);
      setMissing(false);
      setError(null);
      setSettled(true);
      onTitle?.(courseTitle(summary));
    };
    load().catch((e: unknown) => {
      if (controller.signal.aborted) return;
      console.error('Course request failed', e);
      setOffline(isOfflineFailure(e));
      setError(e instanceof Error ? e.message : String(e));
      setSettled(true);
    });
    return () => controller.abort();
  }, [courseId, attempt, onTitle]);

  // A course being prepared is looked at again until it is ready, or has failed. That
  // includes a finished job whose validation has not yet settled.
  const preparing = course !== null && awaitingPreparation(course);
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setTimeout(() => setAttempt((n) => n + 1), PREPARING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [preparing, attempt]);

  // Nothing spoken outlives the screen.
  useEffect(() => () => stopSpeaking(), []);

  // A lesson is the reader's own material, so it is read only by a voice on this device;
  // voices arrive after the page does, so the answer is read again when they change.
  const [localVoice, setLocalVoice] = useState<string | null>(() => localVoiceURI());
  useEffect(() => onVoicesChanged(() => setLocalVoice(localVoiceURI())), []);

  // ---------------------------------------------------------------- progress
  const shownUnits = applyProgress(units, recorded);

  /*
   * Every event is sent with its own client id, and anything not yet accepted is sent
   * again with the next one, when the connection returns, and as the screen closes:
   * `record_study_progress` records each id once, so a retry after a lost response is
   * harmless. A durable offline queue is the practice change's.
   */
  const flush = useCallback(() => {
    const batch = pending.current;
    if (batch.length === 0) return;
    recordProgress(batch)
      .then((result) => {
        const retry = new Set(
          result.refused.filter((x) => x.reason === 'limit').map((x) => x.clientEventId),
        );
        pending.current = pending.current.filter(
          (e) => !batch.includes(e) || retry.has(e.clientEventId),
        );
        setProgressNote(
          retry.size > 0
            ? 'Today’s reading record is full; it will be saved tomorrow if this page stays open.'
            : null,
        );
      })
      .catch((e: unknown) => {
        console.error('Recording progress failed', e);
        setProgressNote(
          isOfflineFailure(e)
            ? 'You look offline. Your place in the course will be saved when you reconnect.'
            : 'Your place in the course could not be saved just now; it will be tried again.',
        );
      });
  }, []);

  const send = useCallback(
    (kind: ProgressKind, lessonId: string) => {
      setRecorded((r) => [...r, { kind, lessonId }]);
      pending.current = [
        ...pending.current,
        { clientEventId: mutationId(), kind, lessonId, occurredAt: new Date().toISOString() },
      ].slice(-100);
      flush();
    },
    [flush],
  );

  // What has not been accepted is sent again when the connection returns, and once more
  // as the screen closes -- the request outlives the component.
  useEffect(() => {
    window.addEventListener('online', flush);
    return () => {
      window.removeEventListener('online', flush);
      flush();
    };
  }, [flush]);

  // ---------------------------------------------------------------- the lesson on screen
  const currentId = view.kind === 'session' ? (view.plan[view.index] ?? null) : null;
  useEffect(() => {
    if (!currentId) return;
    const controller = new AbortController();
    fetchLesson(currentId, controller.signal)
      .then((content) => {
        if (controller.signal.aborted) return;
        setLesson(content);
        setLessonError(content ? null : 'This lesson is no longer available.');
        if (content) {
          setRecaps((r) => ({ ...r, [currentId]: content.recap }));
          window.requestAnimationFrame(() =>
            document.getElementById('course-lesson-title')?.focus(),
          );
        }
        if (content && shownFor.current !== currentId) {
          shownFor.current = currentId;
          send('lesson_shown', currentId);
        }
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setLessonError(
          isOfflineFailure(e)
            ? 'You look offline. This lesson needs a connection to open.'
            : 'This lesson could not be opened.',
        );
      });
    return () => controller.abort();
  }, [currentId, send]);

  // The end of a session is a new screen: a keyboard or screen-reader reader starts at its
  // heading, as they do at a lesson's.
  useEffect(() => {
    if (view.kind === 'stop') document.getElementById('course-stop-title')?.focus();
  }, [view.kind]);

  const lessons = allLessons(shownUnits);
  const lessonById = new Map(lessons.map((l) => [l.lessonId, l]));

  const closeFixes = () => {
    setFix(null);
    setClaimReport(null);
    setFixError(null);
  };

  /** Take the lesson on screen out of this session -- reported or withdrawn -- and go on. */
  const dropCurrent = () => {
    if (view.kind !== 'session') return;
    const plan = view.plan.filter((_, i) => i !== view.index);
    stopSpeaking();
    setListening(false);
    setLesson(null);
    setLessonError(null);
    closeFixes();
    setView(view.index < plan.length ? { ...view, plan } : { kind: 'stop', plan });
    window.scrollTo(0, 0);
  };

  const fixFailed = (e: unknown, refusal: string | null) => {
    setFixError(
      isOfflineFailure(e)
        ? 'That has not reached your account — you look offline. Try again when you reconnect.'
        : (refusal ?? asSentence(e instanceof Error ? e.message : String(e))),
    );
  };

  const report = async (
    kind: 'lesson' | 'claim',
    id: string,
    reason: ReportReason,
    note: string | null,
  ) => {
    if (working || !lesson) return;
    setWorking(true);
    setFixError(null);
    try {
      const reportId = await reportContent(kind, id, reason, note);
      setNotice({
        text:
          kind === 'lesson'
            ? `Reported “${lesson.title}”. It is held back from this course until you restore it.`
            : 'Reported the claim. The lessons that rest on it are held back until you restore it.',
        undo: reportId,
      });
      dropCurrent();
      setAttempt((n) => n + 1);
    } catch (e: unknown) {
      fixFailed(e, reportRefusal(sqlState(e)));
    } finally {
      setWorking(false);
    }
  };

  const withdraw = async () => {
    if (working || !lesson) return;
    setWorking(true);
    setFixError(null);
    try {
      await retireContent('lesson', lesson.lessonId);
      setNotice({
        text: `Withdrew “${lesson.title}” from this course. Its questions stay for review.`,
        undo: null,
      });
      dropCurrent();
      setAttempt((n) => n + 1);
    } catch (e: unknown) {
      fixFailed(e, reportRefusal(sqlState(e)));
    } finally {
      setWorking(false);
    }
  };

  const correct = async (before: LessonDraft, after: LessonDraft) => {
    if (working || !lesson || view.kind !== 'session') return;
    const revision = lessonRevision(before, after);
    if (!revision) {
      setFixError('Nothing has changed yet.');
      return;
    }
    setWorking(true);
    setFixError(null);
    try {
      const newId = await reviseLesson(lesson.lessonId, revision);
      // The new version takes the old one's place in the session. The reader's place in
      // it follows the lesson's lineage, so it is not shown again as new.
      shownFor.current = newId;
      closeFixes();
      setLesson(null);
      setView({ ...view, plan: view.plan.map((id, i) => (i === view.index ? newId : id)) });
      setNotice({
        text: 'Saved your correction. The lesson now reads as you wrote it.',
        undo: null,
      });
      setAttempt((n) => n + 1);
    } catch (e: unknown) {
      fixFailed(e, correctionRefusal(sqlState(e), sqlDetail(e)));
    } finally {
      setWorking(false);
    }
  };

  const restore = async (reportId: string) => {
    if (working) return;
    setWorking(true);
    try {
      await dismissReport(reportId);
      setNotice({ text: 'Restored. It is back in the course.', undo: null });
      setAttempt((n) => n + 1);
    } catch (e: unknown) {
      // Said where the reader is -- in a session or on the course -- with the undo kept.
      setNotice({
        text: isOfflineFailure(e)
          ? 'Could not restore it — you look offline.'
          : `Could not restore it: ${
              reportRefusal(sqlState(e)) ?? asSentence(e instanceof Error ? e.message : String(e))
            }`,
        undo: reportId,
      });
    } finally {
      setWorking(false);
    }
  };

  const startSession = (from: OutlineLesson | null) => {
    const plan = planSession(shownUnits, from?.lessonId ?? null).map((l) => l.lessonId);
    if (plan.length === 0) return;
    stopSpeaking();
    setListening(false);
    setLesson(null);
    setLessonError(null);
    closeFixes();
    setNotice(null);
    setView({ kind: 'session', plan, index: 0 });
    window.scrollTo(0, 0);
  };

  const advance = (kind: 'lesson_read' | 'lesson_skipped') => {
    if (view.kind !== 'session' || !currentId) return;
    send(kind, currentId);
    closeFixes();
    setNotice(null);
    stopSpeaking();
    setListening(false);
    setLesson(null);
    setLessonError(null);
    if (view.index + 1 < view.plan.length) {
      setView({ ...view, index: view.index + 1 });
    } else {
      setView({ kind: 'stop', plan: view.plan });
    }
    window.scrollTo(0, 0);
  };

  const toggleListen = () => {
    if (!lesson) return;
    if (listening) {
      stopSpeaking();
      setListening(false);
      return;
    }
    const text = [lesson.title, lesson.objective, lesson.explanation, lesson.example, lesson.recap]
      .filter(Boolean)
      .join('\n\n');
    // `speak` directly, not through the player's queue, which is stored on the device and
    // would keep the lesson there; and only with a local voice, so the reader's material
    // is not sent to a speech service.
    if (!localVoice) return;
    speak(text, { voiceURI: localVoice, localOnly: true, onEnd: () => setListening(false) });
    setListening(true);
  };

  const showContext = (claim: LessonClaim, ordinal: number) => {
    const key = `${claim.claimId}:${ordinal}`;
    setOpened((o) => ({ ...o, [key]: !o[key] }));
    if (texts[claim.versionId] !== undefined) return;
    fetchSourceText(claim.versionId)
      .then((text) => setTexts((t) => ({ ...t, [claim.versionId]: text })))
      .catch(() => setTexts((t) => ({ ...t, [claim.versionId]: '' })));
  };

  const renderContext = (claim: LessonClaim, ordinal: number) => {
    const key = `${claim.claimId}:${ordinal}`;
    const evidence = claim.evidence.find((e) => e.ordinal === ordinal);
    const text = texts[claim.versionId];
    const open = Boolean(opened[key]);
    const passage = evidence && text ? passageWindow(text, evidence) : null;
    return (
      <div>
        <button
          type="button"
          className="btn btn--plain meta"
          aria-expanded={open}
          aria-controls={`context-${key}`}
          onClick={() => showContext(claim, ordinal)}
        >
          {open ? 'Hide the surrounding text' : 'Show it in your text'}
        </button>
        {open && (
          <div id={`context-${key}`}>
            {text === undefined ? (
              <p className="meta" role="status">
                Loading your text…
              </p>
            ) : passage ? (
              <PassageInContext passage={passage} />
            ) : (
              <p className="meta">
                The surrounding text is not available: this version of your source may have changed.
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  // ---------------------------------------------------------------- course actions
  const regenerate = async () => {
    if (!course || working) return;
    setActionError(null);
    if (!consent) {
      setActionError('Confirm first that your text may be sent to the model provider again.');
      return;
    }
    setWorking(true);
    regeneration.current ??= mutationId();
    try {
      await regenerateCourse({
        courseId: course.courseId,
        mutationId: regeneration.current,
        consent,
      });
      regeneration.current = null;
      setConsent(false);
      setAttempt((n) => n + 1);
    } catch (e: unknown) {
      const state = sqlState(e);
      // As in the builder: only a refusal ends this request, and a new request is agreed
      // to anew.
      if (state !== undefined) {
        regeneration.current = null;
        setConsent(false);
      }
      setActionError(
        isOfflineFailure(e)
          ? 'That has not reached your account — you look offline. Try again when you reconnect.'
          : (preparationRefusal(state, sqlDetail(e)) ??
              asSentence(e instanceof Error ? e.message : String(e))),
      );
      // A refusal because one is already on its way, or because the course is gone, means
      // the screen is out of date: read it again.
      if (state === '55000' || state === 'P0002') setAttempt((n) => n + 1);
    } finally {
      setWorking(false);
    }
  };

  /*
   * Armed, then done, as every destructive action in `Account.tsx` is: the first press
   * says what goes, beside the control, and the second does it.
   */
  const remove = async () => {
    if (!course || working) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setWorking(true);
    setActionError(null);
    try {
      await deleteCourse(course.courseId);
      onNavigate('/courses');
    } catch (e: unknown) {
      // Already gone -- deleted in another tab, or with its last source -- is done.
      if (sqlState(e) === 'P0002') {
        onNavigate('/courses');
        return;
      }
      setActionError(
        isOfflineFailure(e)
          ? 'That has not reached your account — you look offline.'
          : asSentence(e instanceof Error ? e.message : String(e)),
      );
      setWorking(false);
    }
  };

  // ---------------------------------------------------------------- rendering
  const noticeLine = notice && (
    <p className="meta course__notice" role="status">
      {notice.text}{' '}
      {notice.undo && (
        <button
          type="button"
          className="btn btn--plain"
          aria-disabled={working}
          onClick={() => {
            const reportId = notice.undo;
            if (reportId) void restore(reportId);
          }}
        >
          Undo
        </button>
      )}
    </p>
  );

  const back = (
    <button type="button" className="btn btn--plain meta" onClick={() => onNavigate('/courses')}>
      ← Courses
    </button>
  );

  if (!settled) {
    return (
      <p className="meta" role="status">
        Loading…
      </p>
    );
  }

  if (error && !course) {
    return (
      <section className="stack measure" role="alert">
        {back}
        <h1>Could not load this course.</h1>
        <p>{offline ? 'You appear to be offline. Courses need an active connection.' : error}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setError(null);
            setSettled(false);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  if (missing || !course) {
    return (
      <section className="stack measure">
        {back}
        <h1>No such course.</h1>
        <p>It may have been deleted, or its last source was.</p>
      </section>
    );
  }

  const status = courseStatus(course);
  const title = courseTitle(course);

  if (view.kind === 'session' && currentId) {
    const outlineLesson = lessonById.get(currentId);
    const unit = shownUnits.find((u) => u.unitNo === outlineLesson?.unitNo);
    return (
      <section className="stack measure course">
        <div className="course__bar">
          <button
            type="button"
            className="btn btn--plain meta"
            onClick={() => {
              stopSpeaking();
              setListening(false);
              setView({ kind: 'overview' });
            }}
          >
            ← {title}
          </button>
          <span className="meta">
            Lesson {view.index + 1} of {view.plan.length} this session
          </span>
        </div>
        {noticeLine}
        {lessonError && (
          <p className="remember__error" role="alert">
            {lessonError}
          </p>
        )}
        {!lesson && !lessonError && (
          <p className="meta" role="status">
            Loading the lesson…
          </p>
        )}
        {lesson && (
          <>
            <LessonBody lesson={lesson} unitTitle={unit?.title ?? ''} />
            {speechSupported() &&
              (localVoice ? (
                <p>
                  <button type="button" className="btn btn--plain" onClick={toggleListen}>
                    {listening ? 'Stop listening' : 'Listen to this lesson'}
                  </button>
                </p>
              ) : (
                <p className="meta">
                  Listening needs a voice installed on this device, so that your material is not
                  sent to a speech service.
                </p>
              ))}
            <details className="course__sources">
              <summary>Where this comes from in your material</summary>
              <LessonSources
                claims={lesson.claims}
                renderContext={renderContext}
                renderClaimActions={(claim) =>
                  claimReport === claim.claimId ? (
                    <ReportForm
                      kind="claim"
                      working={working}
                      error={fixError}
                      onSubmit={(reason, note) => void report('claim', claim.claimId, reason, note)}
                      onCancel={closeFixes}
                    />
                  ) : (
                    <button
                      type="button"
                      className="btn btn--plain meta"
                      onClick={() => {
                        closeFixes();
                        setClaimReport(claim.claimId);
                      }}
                    >
                      Report this claim
                    </button>
                  )
                }
              />
            </details>
            <details
              className="course__sources course__fix"
              open={fix !== null}
              onToggle={(e) => {
                if (!(e.currentTarget as HTMLDetailsElement).open) closeFixes();
              }}
            >
              <summary>Something wrong with this lesson?</summary>
              {fix === null && (
                <>
                  <p>
                    Report it and it is held back at once; correct it and it reads as you write it;
                    or withdraw it from the course for good.
                  </p>
                  <div className="course__actions">
                    <button type="button" className="btn" onClick={() => setFix('report')}>
                      Report it
                    </button>
                    <button type="button" className="btn" onClick={() => setFix('correct')}>
                      Correct it
                    </button>
                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => setFix('withdraw')}
                    >
                      Withdraw it
                    </button>
                  </div>
                </>
              )}
              {fix === 'report' && (
                <ReportForm
                  kind="lesson"
                  working={working}
                  error={fixError}
                  onSubmit={(reason, note) => void report('lesson', lesson.lessonId, reason, note)}
                  onCancel={closeFixes}
                />
              )}
              {fix === 'correct' && (
                <LessonCorrectionForm
                  initial={lessonDraft(lesson, unit?.title ?? '')}
                  working={working}
                  error={fixError}
                  onSave={(draft) => void correct(lessonDraft(lesson, unit?.title ?? ''), draft)}
                  onCancel={closeFixes}
                />
              )}
              {fix === 'withdraw' && (
                <div className="stack course__fix-form">
                  <p>
                    Withdrawing “{lesson.title}” takes it out of this course for good. Its questions
                    stay for review. Reporting it instead holds it back until you decide.
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
                      onClick={() => void withdraw()}
                    >
                      {working ? 'Withdrawing…' : 'Withdraw the lesson'}
                    </button>
                    <button type="button" className="btn btn--plain" onClick={closeFixes}>
                      Keep it
                    </button>
                  </div>
                </div>
              )}
            </details>
          </>
        )}
        {progressNote && (
          <p className="meta" role="status">
            {progressNote}
          </p>
        )}
        <div className="course__actions">
          <button
            type="button"
            className="btn btn--primary"
            aria-disabled={!lesson}
            onClick={() => lesson && advance('lesson_read')}
          >
            {view.index + 1 < view.plan.length ? 'Done — next lesson' : 'Done'}
          </button>
          <button type="button" className="btn" onClick={() => advance('lesson_skipped')}>
            Skip this lesson
          </button>
        </div>
      </section>
    );
  }

  if (view.kind === 'stop') {
    const covered = view.plan
      .map((id) => lessonById.get(id))
      .filter((l): l is OutlineLesson => l !== undefined && l.state === 'read')
      .map((l) => ({ title: l.title, recap: recaps[l.lessonId] ?? null }));
    const remaining = lessons.filter((l) => l.state !== 'read' && l.state !== 'skipped').length;
    const next = nextLesson(shownUnits);
    return (
      <section className="stack measure course">
        <div className="course__bar">{back}</div>
        {noticeLine}
        <StoppingPoint
          covered={covered}
          remaining={remaining}
          onDone={() => setView({ kind: 'overview' })}
          onContinue={next ? () => startSession(next) : null}
        />
      </section>
    );
  }

  const next = nextLesson(shownUnits);
  const everyLessonRead = status === 'ready' && lessons.length > 0 && next === null;
  const readCount = lessons.filter((l) => l.state === 'read').length;

  return (
    <section className="stack measure course">
      <div className="course__bar">{back}</div>
      <p className="meta">Your private course</p>
      <h1 className="display">{title}</h1>
      {course.title && course.goal && <p className="meta">Goal: {course.goal}</p>}
      {noticeLine}

      {status === 'preparing' && (
        <p role="status">
          This course is being prepared from your sources. It usually takes a few minutes; this page
          checks again on its own.
        </p>
      )}
      {status === 'failed' && (
        <p role="status">
          This course could not be prepared. Nothing from it was published or shared. You can try
          preparing it again below, or delete it.
        </p>
      )}
      {status === 'empty' && (
        <p role="status">
          The sources this course was prepared from were deleted. Prepare it again from the sources
          it still follows, or delete it.
        </p>
      )}

      {status === 'ready' && (
        <>
          {course.overview && <Paragraphs text={course.overview} className="lede" />}
          {course.objectives.length > 0 && (
            <div>
              <p className="meta">By the end you should be able to</p>
              <ul className="course__objectives">
                {course.objectives.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            </div>
          )}
          {lessons.length > 0 && (
            <Meter
              value={lessons.length ? readCount / lessons.length : 0}
              label={courseProgressLabel({
                ...course,
                lessonsReadCount: readCount,
                lessonCount: lessons.length,
              })}
            />
          )}
          {course.preparing && course.latestGenerationId !== course.generationId && (
            <p className="meta" role="status">
              A newer version of this course is being prepared. You can keep reading this one.
            </p>
          )}
          {newerPreparationFailed(course) && (
            <p className="meta">
              The last attempt to prepare this course again did not finish, so you are reading the
              previous version.
            </p>
          )}
          {course.newerGenerationHeldBack && (
            <p className="meta">
              A newer version of this course was checked and held back, so you are reading the
              previous one.
            </p>
          )}
          {lessons.length === 0 ? (
            course.heldBack ? (
              <p>
                Every lesson in this course was held back by its checks, so there is nothing to
                read. Correct your sources in Studio and prepare it again.
              </p>
            ) : (
              <p>
                You have reported or withdrawn every lesson in this course, so there is nothing to
                read in it now.
              </p>
            )
          ) : (
            <>
              <div className="course__actions">
                {next && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => startSession(next)}
                  >
                    {readCount === 0 ? 'Start the course' : 'Continue where you left off'}
                  </button>
                )}
              </div>
              <CourseOutline
                units={shownUnits}
                currentLessonId={next?.lessonId ?? null}
                onOpen={(l) => startSession(l)}
              />
            </>
          )}
          {everyLessonRead && <CourseRecap course={course} />}
          <HeldBackList items={held} working={working} onRestore={(id) => void restore(id)} />
        </>
      )}

      <hr className="rule" />
      {(course.updateAvailable || status === 'failed' || status === 'empty') &&
        !course.preparing && (
          <div className="stack">
            <h2 className="course__subheading">Prepare this course again</h2>
            <p>
              {course.updateAvailable ? 'One of its sources has a newer version. ' : ''}
              Preparing it again sends the newest version of each of its sources, and what the
              course is for, to Google’s Gemini API, and makes a new version of the course. What you
              have read in this version does not carry over.
            </p>
            <label>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />{' '}
              Send my sources and the course’s goal to the model provider to prepare it again.
            </label>
            <p>
              <button
                type="button"
                className="btn"
                aria-disabled={working}
                onClick={() => void regenerate()}
              >
                {working ? 'Working…' : 'Prepare it again'}
              </button>
            </p>
          </div>
        )}
      {actionError && (
        <p className="remember__error" role="alert">
          {actionError}
        </p>
      )}
      {armed ? (
        <div className="stack" role="group" aria-labelledby="course-delete-warning">
          <p id="course-delete-warning">
            Deleting this course removes its lessons, its questions and your place in it. Its
            sources stay in Studio, and you can make a new course from them.
          </p>
          <div className="course__actions">
            <button
              type="button"
              className="btn"
              aria-disabled={working}
              onClick={() => void remove()}
            >
              {working ? 'Deleting…' : 'Delete the course'}
            </button>
            <button type="button" className="btn btn--plain" onClick={() => setArmed(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <p>
          <button type="button" className="btn btn--plain" onClick={() => void remove()}>
            Delete this course
          </button>
        </p>
      )}
      <p className="meta">
        This course is private to you. It was made from your own material and is never published.
      </p>
    </section>
  );
}
