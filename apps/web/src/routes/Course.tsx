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
import { usePlayer } from '../components/PlayerProvider.js';
import { isOfflineFailure } from '../lib/offline.js';
import { sqlDetail, sqlState } from '../lib/rpc-error.js';
import { currentTrack } from '../lib/player.js';
import { localVoiceURI, onVoicesChanged } from '../lib/speech.js';
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
  newerPreparationComing,
  newerPreparationFailed,
  nextLesson,
  passageWindow,
  planSession,
  planSkipped,
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
  fetchCourse,
  fetchHeldBack,
  fetchLesson,
  fetchOutline,
  fetchSourceText,
  recordProgress,
  regenerateCourse,
  reportContent,
  restoreReported,
  retireContent,
  reviseLesson,
  type HeldBack,
  type ReportTarget,
} from '../lib/study-course-api.js';
import { mutationId } from '../lib/submission.js';

/** How often a course being prepared is looked at again. */
const PREPARING_POLL_MS = 15_000;

/** The player's id for a lesson read aloud; never a Pull's id. */
const lessonTrackId = (lessonId: string) => `study-lesson:${lessonId}`;

/**
 * A lesson as its session planned it, with its unit's title. A session keeps these for its
 * whole length rather than looking ids up in the outline: a newer preparation finishing
 * mid-session replaces the outline, and a session reading from it lost its unit titles, its
 * recap list, and the unit title a correction starts from.
 */
interface Planned {
  lessonId: string;
  title: string;
  unitNo: number;
  unitTitle: string;
}

type View =
  | { kind: 'overview' }
  | { kind: 'session'; plan: Planned[]; index: number }
  | { kind: 'stop'; plan: Planned[] };

function planned(units: readonly OutlineUnit[], lessons: readonly OutlineLesson[]): Planned[] {
  const titles = new Map(units.map((u) => [u.unitNo, u.title]));
  return lessons.map((l) => ({
    lessonId: l.lessonId,
    title: l.title,
    unitNo: l.unitNo,
    unitTitle: titles.get(l.unitNo) ?? '',
  }));
}

/** Where focus goes after a control that replaced itself is gone. */
type FocusTarget = string | null;

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
  // A source text that would not load, said as such rather than cached as empty for good.
  const [textFailed, setTextFailed] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [recaps, setRecaps] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [armed, setArmed] = useState(false);
  const [deleted, setDeleted] = useState(false);
  // Fixing the lesson on screen: which form is open, and a claim being reported.
  const [fix, setFix] = useState<null | 'report' | 'correct' | 'withdraw'>(null);
  const [claimReport, setClaimReport] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  // A correction in progress, kept here so closing its form does not throw it away.
  const [draft, setDraft] = useState<{ lessonId: string; value: LessonDraft } | null>(null);
  // Done or Skip pressed once over an unsaved correction: the next press leaves it.
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; undo: ReportTarget | null } | null>(null);
  const [held, setHeld] = useState<HeldBack[]>([]);
  const pending = useRef<ProgressEvent[]>([]);
  const regeneration = useRef<string | null>(null);
  const shownFor = useRef<string | null>(null);

  /*
   * FOCUS FOLLOWS THE CONTROL THAT WENT. Most controls here replace themselves -- a form
   * opens where its button was, a list item goes when it is restored, a screen gives way to
   * another -- and focus on a removed element falls to the top of the page. Each such
   * change names where focus goes next, and it goes there once the new screen is drawn.
   */
  const focusNext = useRef<FocusTarget>(null);
  const focusAfter = (id: string) => {
    focusNext.current = id;
  };
  useEffect(() => {
    const id = focusNext.current;
    if (id === null) return;
    const target = document.getElementById(id);
    if (!target) return;
    focusNext.current = null;
    target.focus();
  });

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

  // A course being prepared is looked at again until it is ready, or has failed -- including
  // one saved and awaiting its validation, and a newer version of one being read. Only on
  // the course page: a session walks the lessons it planned, and has nothing to redraw.
  const watching = course !== null && awaitingPreparation(course) && view.kind === 'overview';
  useEffect(() => {
    if (!watching) return;
    const timer = window.setTimeout(() => setAttempt((n) => n + 1), PREPARING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [watching, attempt]);

  /*
   * LISTENING GOES THROUGH THE PLAYER, the one place in the app that speaks
   * (`PlayerProvider`). Speaking here directly shared `speech.ts`'s one utterance with
   * the player behind its back: stopping a lesson cut off a Pull and advanced the queue,
   * and starting one wiped a paused Pull's place. As a player track the lesson pauses,
   * resumes and changes rate like anything else, and stays out of storage and off remote
   * voices because it is `localOnly` (`lib/player.ts`).
   */
  const player = usePlayer();
  const lessonTrack = useRef<string | null>(null);
  const playing = player.state.status === 'playing' ? currentTrack(player.state) : null;
  const listening = lesson !== null && playing?.id === lessonTrackId(lesson.lessonId);
  /** Take the lesson this screen queued out of the player, stopping it if it is on. */
  const silence = () => {
    const id = lessonTrack.current;
    if (id === null) return;
    lessonTrack.current = null;
    // Playing or paused on it: stop, so removing it does not start whatever comes next.
    if (player.state.status !== 'idle' && currentTrack(player.state)?.id === id) player.stop();
    player.remove(id);
  };

  // Nothing this screen queued outlives it.
  const leave = useRef(silence);
  useEffect(() => {
    leave.current = silence;
  });
  useEffect(() => () => leave.current(), []);

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
            ? 'Today’s reading record is full, so what you read now may not be kept. It resets at 00:00 UTC.'
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
  const current = view.kind === 'session' ? (view.plan[view.index] ?? null) : null;
  const currentId = current?.lessonId ?? null;
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
          // Once the lesson is drawn, not in a frame that can come before it.
          focusNext.current = 'course-lesson-title';
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

  /** Leave the lesson on screen: its reading, its forms and any correction not saved. */
  const leaveLesson = () => {
    silence();
    setLesson(null);
    setLessonError(null);
    closeFixes();
    setDraft(null);
    setLeaving(false);
  };

  /** Take the lesson on screen out of this session -- reported or withdrawn -- and go on. */
  const dropCurrent = () => {
    if (view.kind !== 'session') return;
    const plan = view.plan.filter((_, i) => i !== view.index);
    leaveLesson();
    setView(view.index < plan.length ? { ...view, plan } : { kind: 'stop', plan });
    // Said in the notice, which is where the reader looks next.
    focusAfter('course-notice');
    window.scrollTo(0, 0);
  };

  // A correction typed and not saved, to the lesson on screen.
  const unsaved =
    lesson !== null &&
    current !== null &&
    draft !== null &&
    draft.lessonId === lesson.lessonId &&
    lessonRevision(lessonDraft(lesson, current.unitTitle), draft.value) !== null;

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
      await reportContent(kind, id, reason, note);
      setNotice({
        text:
          kind === 'lesson'
            ? `Reported “${lesson.title}”. It is held back from this course until you restore it.`
            : 'Reported the claim. The lessons that rest on it are held back until you restore it.',
        undo: { kind, id },
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
        text: `Withdrew “${lesson.title}” from this course. Its questions stay in the course.`,
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

  const correct = async (after: LessonDraft) => {
    if (working || !lesson || !current) return;
    const revision = lessonRevision(lessonDraft(lesson, current.unitTitle), after);
    if (!revision) {
      setFixError('Nothing has changed yet.');
      return;
    }
    const oldId = lesson.lessonId;
    const unitNo = current.unitNo;
    setWorking(true);
    setFixError(null);
    try {
      const newId = await reviseLesson(oldId, revision);
      // The new version takes the old one's place in the session. The reader's place in
      // it follows the lesson's lineage, so it is not shown again as new.
      shownFor.current = newId;
      closeFixes();
      setDraft(null);
      setLeaving(false);
      setLesson(null);
      // From the session as it is when the save lands, not as it was when it began.
      setView((v) =>
        v.kind !== 'session'
          ? v
          : {
              ...v,
              plan: v.plan.map((p) => {
                const unit = p.unitNo === unitNo ? { ...p, unitTitle: after.unitTitle.trim() } : p;
                return p.lessonId === oldId
                  ? { ...unit, lessonId: newId, title: after.title.trim() }
                  : unit;
              }),
            },
      );
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

  /*
   * Restoring settles every open report on the lesson or claim, and then says what the
   * course shows now rather than what it hopes: a lesson resting on a claim that is still
   * reported stays held back after its own report is settled.
   */
  const restore = async (target: ReportTarget) => {
    if (working) return;
    setWorking(true);
    try {
      await restoreReported(target);
      let text =
        target.kind === 'lesson'
          ? 'Restored. The lesson is back in the course.'
          : 'Restored. The claim is back in the course, with the lessons that rest on it.';
      if (target.kind === 'lesson' && (await fetchLesson(target.id)) === null) {
        text =
          'Restored your report, but the lesson is still held back: a claim it rests on is reported. Restore the claim to bring it back.';
      }
      setNotice({ text, undo: null });
      setAttempt((n) => n + 1);
    } catch (e: unknown) {
      // Said where the reader is -- in a session or on the course -- with the undo kept.
      setNotice({
        text: isOfflineFailure(e)
          ? 'Could not restore it — you look offline.'
          : `Could not restore it: ${
              reportRefusal(sqlState(e)) ?? asSentence(e instanceof Error ? e.message : String(e))
            }`,
        undo: target,
      });
    } finally {
      setWorking(false);
      focusAfter('course-notice');
    }
  };

  const begin = (plan: Planned[]) => {
    if (plan.length === 0) return;
    leaveLesson();
    setNotice(null);
    setView({ kind: 'session', plan, index: 0 });
    window.scrollTo(0, 0);
  };

  const startSession = (from: OutlineLesson | null) =>
    begin(planned(shownUnits, planSession(shownUnits, from?.lessonId ?? null)));

  /** Back to the course page, with focus on its title. */
  const toOverview = () => {
    leaveLesson();
    setView({ kind: 'overview' });
    focusAfter('course-title');
    window.scrollTo(0, 0);
  };

  const advance = (kind: 'lesson_read' | 'lesson_skipped') => {
    if (view.kind !== 'session' || !currentId || working) return;
    // A correction typed and not saved is not dropped on one press.
    if (unsaved && !leaving) {
      setLeaving(true);
      return;
    }
    // Only a lesson the reader was shown is recorded. One that would not open -- held back
    // by a report on a claim it shares, withdrawn in another tab, or unreachable offline --
    // was never seen, and a skip recorded for it kept it out of every later session.
    if (lesson?.lessonId === currentId) send(kind, currentId);
    leaveLesson();
    setNotice(null);
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
      silence();
      return;
    }
    const text = [lesson.title, lesson.objective, lesson.explanation, lesson.example, lesson.recap]
      .filter(Boolean)
      .join('\n\n');
    // Only with a local voice, so the reader's material is not sent to a speech service;
    // `localOnly` holds the player to that, and keeps the lesson out of its stored queue.
    if (!localVoice) return;
    const id = lessonTrackId(lesson.lessonId);
    lessonTrack.current = id;
    player.playNow({ id, title: lesson.title, text, localOnly: true });
  };

  const showContext = (claim: LessonClaim, ordinal: number) => {
    const key = `${claim.claimId}:${ordinal}`;
    const version = claim.versionId;
    const opening = !opened[key];
    setOpened((o) => ({ ...o, [key]: opening }));
    if (!opening || texts[version] !== undefined) return;
    // A failure is said, and opening the passage again tries again: it is not remembered as
    // a text with nothing in it.
    setTextFailed((f) => {
      const rest = { ...f };
      delete rest[version];
      return rest;
    });
    fetchSourceText(version)
      .then((text) => setTexts((t) => ({ ...t, [version]: text })))
      .catch((e: unknown) =>
        setTextFailed((f) => ({
          ...f,
          [version]: isOfflineFailure(e)
            ? 'Your text needs a connection to open. Close this and try again when you reconnect.'
            : 'Your text could not be loaded just now. Close this and try again.',
        })),
      );
  };

  const renderContext = (claim: LessonClaim, ordinal: number) => {
    const key = `${claim.claimId}:${ordinal}`;
    const evidence = claim.evidence.find((e) => e.ordinal === ordinal);
    const text = texts[claim.versionId];
    const failed = textFailed[claim.versionId];
    const open = Boolean(opened[key]);
    // Only for a passage the reader opened: each is a walk over a text of up to 200,000
    // characters, and a lesson cites up to twenty-four.
    const passage = open && evidence && text ? passageWindow(text, evidence) : null;
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
              failed ? (
                <p>{failed}</p>
              ) : (
                <p className="meta" role="status">
                  Loading your text…
                </p>
              )
            ) : passage ? (
              <PassageInContext passage={passage} />
            ) : (
              <p>
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
          : (preparationRefusal(state, sqlDetail(e), true) ??
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
      focusAfter('course-delete-warning');
      return;
    }
    setWorking(true);
    setActionError(null);
    try {
      await deleteCourse(course.courseId);
      setDeleted(true);
    } catch (e: unknown) {
      // Already gone -- deleted in another tab, or with its last source -- is done.
      if (sqlState(e) === 'P0002') {
        setDeleted(true);
        return;
      }
      // Still armed, so the warning and "Deleting…" stay where the reader pressed.
      setActionError(
        isOfflineFailure(e)
          ? 'That has not reached your account — you look offline.'
          : asSentence(e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setWorking(false);
    }
  };

  // ---------------------------------------------------------------- rendering
  const noticeLine = notice && (
    <p id="course-notice" className="course__notice" role="status" tabIndex={-1}>
      {notice.text}{' '}
      {notice.undo && (
        <button
          type="button"
          className="btn btn--plain"
          aria-disabled={working}
          onClick={() => {
            const target = notice.undo;
            if (target) void restore(target);
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

  if (deleted) {
    return (
      <section className="stack measure" aria-labelledby="course-title">
        {back}
        <h1 id="course-title" tabIndex={-1}>
          The course is deleted.
        </h1>
        <p>Its sources stay in Studio, and you can make a new course from them.</p>
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

  if (view.kind === 'session' && current) {
    // One primary control on the screen: while a fix form is open, its own button is it.
    const fixing = fix !== null || claimReport !== null;
    const cancelFix = (focus: string) => {
      closeFixes();
      focusAfter(focus);
    };
    return (
      <section className="stack measure course">
        <div className="course__bar">
          <button type="button" className="btn btn--plain meta" onClick={toOverview}>
            ← {title}
          </button>
          <span className="meta">
            Lesson {view.index + 1} of {view.plan.length} in this sitting
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
            <LessonBody lesson={lesson} unitTitle={current.unitTitle} />
            {player.supported &&
              (localVoice ? (
                <p>
                  <button type="button" className="btn btn--plain" onClick={toggleListen}>
                    {listening ? 'Stop reading the lesson aloud' : 'Read this lesson aloud'}
                  </button>
                </p>
              ) : (
                <p>
                  Reading aloud needs a voice installed on this device, so that your material is not
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
                      onCancel={() => cancelFix(`claim-report-${claim.claimId}`)}
                    />
                  ) : (
                    <button
                      id={`claim-report-${claim.claimId}`}
                      type="button"
                      className="btn btn--plain meta"
                      onClick={() => {
                        // Another form closes; a correction typed in it is kept (`draft`).
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
            {/* Not controlled: Cancel closes a form, not the section the reader opened. */}
            <details className="course__sources course__fix">
              <summary id="course-fix-summary">Something wrong with this lesson?</summary>
              {fix === null && (
                <>
                  <p>
                    Report it and it is held back at once; correct it and it reads as you write it;
                    or withdraw it from the course for good.
                  </p>
                  {unsaved && <p>Your correction is not saved yet. Correct it to go on with it.</p>}
                  <div className="course__actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setClaimReport(null);
                        setFix('report');
                      }}
                    >
                      Report it
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setClaimReport(null);
                        setFix('correct');
                      }}
                    >
                      Correct it
                    </button>
                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => {
                        setClaimReport(null);
                        setFix('withdraw');
                        focusAfter('course-withdraw-warning');
                      }}
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
                  onCancel={() => cancelFix('course-fix-summary')}
                />
              )}
              {fix === 'correct' && (
                <LessonCorrectionForm
                  initial={lessonDraft(lesson, current.unitTitle)}
                  draft={
                    draft?.lessonId === lesson.lessonId
                      ? draft.value
                      : lessonDraft(lesson, current.unitTitle)
                  }
                  working={working}
                  error={fixError}
                  onDraft={(value) => {
                    setDraft({ lessonId: lesson.lessonId, value });
                    setLeaving(false);
                  }}
                  onSave={(value) => void correct(value)}
                  onCancel={() => {
                    setDraft(null);
                    setLeaving(false);
                    cancelFix('course-fix-summary');
                  }}
                />
              )}
              {fix === 'withdraw' && (
                <div className="stack course__fix-form">
                  <p id="course-withdraw-warning" tabIndex={-1}>
                    Withdrawing “{lesson.title}” takes it out of this course for good. Its questions
                    stay in the course. Reporting it instead holds it back until you decide.
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
                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => cancelFix('course-fix-summary')}
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}
            </details>
          </>
        )}
        {progressNote && <p role="status">{progressNote}</p>}
        {leaving && (
          <p role="status">
            Your correction to this lesson is not saved. Save it, or press again to leave it
            unsaved.
          </p>
        )}
        <div className="course__actions">
          <button
            type="button"
            className={fixing ? 'btn' : 'btn btn--primary'}
            aria-disabled={!lesson || working}
            onClick={() => lesson && advance('lesson_read')}
          >
            {view.index + 1 < view.plan.length ? 'Done — next lesson' : 'Done'}
          </button>
          {/* A lesson that would not open was never seen, so going past it records nothing. */}
          <button
            type="button"
            className="btn"
            aria-disabled={working}
            onClick={() => advance('lesson_skipped')}
          >
            {lesson ? 'Skip this lesson' : 'Go on'}
          </button>
        </div>
      </section>
    );
  }

  const next = nextLesson(shownUnits);
  const skipped = lessons.filter((l) => l.state === 'skipped').length;

  if (view.kind === 'stop') {
    // What this sitting read, from the lessons it planned: a newer preparation that
    // arrived meanwhile has other lessons, and none of these in its outline.
    const readHere = new Set(
      recorded.filter((r) => r.kind === 'lesson_read').map((r) => r.lessonId),
    );
    const covered = view.plan
      .filter((p) => readHere.has(p.lessonId) || lessonById.get(p.lessonId)?.state === 'read')
      .map((p) => ({ title: p.title, recap: recaps[p.lessonId] ?? null }));
    const remaining = lessons.filter((l) => l.state !== 'read' && l.state !== 'skipped').length;
    return (
      <section className="stack measure course">
        <div className="course__bar">{back}</div>
        {noticeLine}
        <StoppingPoint
          covered={covered}
          remaining={remaining}
          skipped={skipped}
          onDone={toOverview}
          onContinue={next ? () => startSession(next) : null}
        />
      </section>
    );
  }

  // The end of the course is every lesson read or skipped; "every lesson read" is only the
  // first of those, and a skipped lesson is offered again rather than counted as finished.
  const courseEnded = status === 'ready' && lessons.length > 0 && next === null;
  const readCount = lessons.filter((l) => l.state === 'read').length;

  return (
    <section className="stack measure course">
      <div className="course__bar">{back}</div>
      <p className="meta">Your private course</p>
      <h1 id="course-title" className="display" tabIndex={-1}>
        {title}
      </h1>
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
          A source this course was prepared from was deleted, and the lessons made from it went with
          it. Prepare it again from the{' '}
          {course.sourceCount === 1 ? 'source' : `${course.sourceCount} sources`} it still follows,
          or delete it.
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
            <div className="course__progress">
              {/* Said in words beside the bar, which at nothing read is only a rule. */}
              <p className="meta" aria-hidden="true">
                {courseProgressLabel({
                  ...course,
                  lessonsReadCount: readCount,
                  lessonCount: lessons.length,
                })}
              </p>
              <Meter
                value={lessons.length ? readCount / lessons.length : 0}
                label={courseProgressLabel({
                  ...course,
                  lessonsReadCount: readCount,
                  lessonCount: lessons.length,
                })}
              />
            </div>
          )}
          {newerPreparationComing(course) && (
            <p role="status">
              A newer version of this course is being prepared. You can keep reading this one.
            </p>
          )}
          {newerPreparationFailed(course) && (
            <p>
              The last attempt to prepare this course again did not finish, so you are reading the
              previous version.
            </p>
          )}
          {course.newerGenerationHeldBack && (
            <p>
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
                {next ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => startSession(next)}
                  >
                    {readCount === 0 && skipped === 0
                      ? 'Start the course'
                      : 'Continue where you left off'}
                  </button>
                ) : (
                  skipped > 0 && (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => begin(planned(shownUnits, planSkipped(shownUnits)))}
                    >
                      Go back to what you skipped
                    </button>
                  )
                )}
              </div>
              <CourseOutline
                units={shownUnits}
                currentLessonId={next?.lessonId ?? null}
                onOpen={(l) => startSession(l)}
              />
            </>
          )}
          {courseEnded && <CourseRecap course={course} allRead={skipped === 0} />}
          <HeldBackList
            items={held}
            working={working}
            onRestore={(target) => void restore(target)}
          />
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
              course is for, to Google’s Gemini API, and makes a new version of the course.
              {status === 'ready' ? ' What you have read in this version does not carry over.' : ''}
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
          <p id="course-delete-warning" tabIndex={-1}>
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
            <button
              type="button"
              className="btn btn--plain"
              onClick={() => {
                setArmed(false);
                focusAfter('course-delete');
              }}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <p>
          <button
            id="course-delete"
            type="button"
            className="btn btn--plain"
            onClick={() => void remove()}
          >
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
