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
  draftUnsaved,
  passageWindow,
  planAfterCorrection,
  planLessons,
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
  type PlannedLesson,
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
  lessonShown,
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

type View =
  | { kind: 'overview' }
  | { kind: 'session'; plan: PlannedLesson[]; index: number }
  | { kind: 'stop'; plan: PlannedLesson[] };

/**
 * Where focus goes after a control that replaced itself is gone, and how many times the
 * screen has been drawn since: a target that never appears is forgotten rather than taking
 * focus whenever it does.
 */
type FocusTarget = { id: string; draws: number } | null;

/** How many draws a focus target waits for its element: a few loads' worth. */
const FOCUS_WAIT_DRAWS = 60;

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
  // The lessons read in this sitting, for the end of it: not the outline's reads, which
  // count earlier sittings, nor this page's, which count a lesson read then skipped now.
  const [sittingReads, setSittingReads] = useState<string[]>([]);
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
  // A way out pressed once over an unsaved correction -- the course's title above the lesson,
  // or Done and Skip below it -- and said beside it: the next press leaves it.
  const [leaving, setLeaving] = useState<null | 'top' | 'bottom'>(null);
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
    focusNext.current = { id, draws: 0 };
  };
  useEffect(() => {
    const next = focusNext.current;
    if (next === null) return;
    const target = document.getElementById(next.id);
    if (!target) {
      next.draws += 1;
      if (next.draws > FOCUS_WAIT_DRAWS) focusNext.current = null;
      return;
    }
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
  // Every fifteen seconds for the first five minutes, then every minute: a course awaiting
  // the validation sweep can take its ten minutes and more.
  const watching = course !== null && awaitingPreparation(course) && view.kind === 'overview';
  const polls = useRef(0);
  useEffect(() => {
    if (!watching) {
      polls.current = 0;
      return;
    }
    const delay = polls.current < 20 ? PREPARING_POLL_MS : 4 * PREPARING_POLL_MS;
    const timer = window.setTimeout(() => {
      polls.current += 1;
      setAttempt((n) => n + 1);
    }, delay);
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
  const { dismiss } = player;
  // Every lesson this screen handed the player, so leaving takes all of them back -- a
  // correction or a second lesson must not orphan the first in the queue.
  const queuedLessons = useRef(new Set<string>());
  const onTrack = currentTrack(player.state);
  const onLessonTrack = lesson !== null && onTrack?.id === lessonTrackId(lesson.lessonId);
  const listening = onLessonTrack && player.state.status === 'playing';
  const paused = onLessonTrack && player.state.status === 'paused';
  /**
   * Take lessons this screen queued out of the player -- one, or all of them -- stopping
   * rather than moving on if one is on. `dismiss` decides on the player's state when it
   * runs, not on what this screen last drew.
   */
  const silence = useCallback(
    (lessonId?: string) => {
      const ids = lessonId ? [lessonTrackId(lessonId)] : [...queuedLessons.current];
      for (const id of ids) {
        queuedLessons.current.delete(id);
        dismiss(id);
      }
    },
    [dismiss],
  );

  // Nothing this screen queued outlives it, and neither does the title it gave the page --
  // which can be the reader's own goal.
  useEffect(() => () => silence(), [silence]);
  useEffect(() => () => onTitle?.(null), [onTitle]);

  // The lesson on screen, for answers that arrive after the reader may have moved on: a
  // report, a withdrawal or a correction acts on its own lesson, not on whatever is shown.
  const onScreen = useRef<string | null>(null);
  useEffect(() => {
    onScreen.current = lesson?.lessonId ?? null;
  }, [lesson]);
  // And which of its fix forms is open, for the same reason: a failure is said on the form
  // that sent it only while that form is still there to say it.
  const openForm = useRef<string | null>(null);
  useEffect(() => {
    openForm.current = claimReport !== null ? `claim:${claimReport}` : fix;
  }, [claimReport, fix]);

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
          // Once the lesson is drawn, not in a frame that can come before it -- unless the
          // reader is on the notice that says why this lesson replaced the last one.
          if (!document.getElementById('course-notice')?.contains(document.activeElement)) {
            focusNext.current = { id: 'course-lesson-title', draws: 0 };
          }
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

  const lessons = allLessons(shownUnits);

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
    setLeaving(null);
  };

  /**
   * Take a lesson out of the session -- reported or withdrawn -- after the server said so.
   * From the session as it is then: the reader may have gone back to the course page, or on
   * to another lesson, while the answer was on its way, and neither is undone by it.
   */
  const dropLesson = (lessonId: string) => {
    setView((v) => {
      if (v.kind !== 'session') return v;
      const at = v.plan.findIndex((p) => p.lessonId === lessonId);
      if (at < 0) return v;
      const plan = v.plan.filter((_, i) => i !== at);
      const index = at < v.index ? v.index - 1 : v.index;
      return index < plan.length ? { ...v, plan, index } : { kind: 'stop', plan };
    });
    silence(lessonId);
    if (onScreen.current !== lessonId) return;
    setLesson(null);
    setLessonError(null);
    closeFixes();
    setDraft(null);
    setLeaving(null);
    // Said in the notice, which is where the reader looks next.
    focusAfter('course-notice');
    window.scrollTo(0, 0);
  };

  // A correction typed and not saved, to the lesson on screen.
  const unsaved =
    lesson !== null && current !== null && draftUnsaved(lesson, current.unitTitle, draft);

  /**
   * A change that failed is said beside the form that sent it, while that form is open on
   * its lesson. Otherwise the form on screen is another's -- another lesson's, or another
   * form of this one -- or none, when the reader folded the section: an error there would be
   * about a change it never asked for, or nowhere, while nothing said this one failed. So it
   * is said in the notice instead, naming the lesson.
   */
  const fixFailed = (
    lessonId: string,
    form: string,
    what: string,
    e: unknown,
    refusal: string | null,
  ) => {
    const why = isOfflineFailure(e)
      ? 'That has not reached your account — you look offline. Try again when you reconnect.'
      : (refusal ?? asSentence(e instanceof Error ? e.message : String(e)));
    if (onScreen.current === lessonId && openForm.current === form) {
      setFixError(why);
      return;
    }
    setNotice({ text: `${what} ${why}`, undo: null });
  };

  const report = async (
    kind: 'lesson' | 'claim',
    id: string,
    reason: ReportReason,
    note: string | null,
  ) => {
    if (working || !lesson) return;
    const from = lesson;
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
      // A claim report holds back the lesson it was reported from.
      dropLesson(lesson.lessonId);
      setAttempt((n) => n + 1);
    } catch (e: unknown) {
      fixFailed(
        from.lessonId,
        kind === 'lesson' ? 'report' : `claim:${id}`,
        kind === 'lesson'
          ? `Could not report “${from.title}”.`
          : `Could not report the claim in “${from.title}”.`,
        e,
        reportRefusal(sqlState(e)),
      );
    } finally {
      setWorking(false);
    }
  };

  const withdraw = async () => {
    if (working || !lesson) return;
    const from = lesson;
    setWorking(true);
    setFixError(null);
    try {
      await retireContent('lesson', lesson.lessonId);
      setNotice({
        text: `Withdrew “${lesson.title}” from this course. Its questions stay in the course.`,
        undo: null,
      });
      dropLesson(lesson.lessonId);
      setAttempt((n) => n + 1);
    } catch (e: unknown) {
      fixFailed(
        from.lessonId,
        'withdraw',
        `Could not withdraw “${from.title}”.`,
        e,
        reportRefusal(sqlState(e)),
      );
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
    const oldTitle = lesson.title;
    const unitNo = current.unitNo;
    setWorking(true);
    setFixError(null);
    try {
      const newId = await reviseLesson(oldId, revision);
      // The new version takes the old one's place in the session. The reader's place in
      // it follows the lesson's lineage, so it is not shown again as new.
      shownFor.current = newId;
      // The old version's words stop; the new one is read aloud only when asked.
      silence(oldId);
      if (onScreen.current === oldId) {
        closeFixes();
        setDraft(null);
        setLeaving(null);
        setLesson(null);
      }
      // From the session as it is when the save lands, not as it was when it began.
      setView((v) =>
        v.kind !== 'session'
          ? v
          : { ...v, plan: planAfterCorrection(v.plan, oldId, newId, unitNo, after) },
      );
      setNotice({
        text: 'Saved your correction. The lesson now reads as you wrote it.',
        undo: null,
      });
      setAttempt((n) => n + 1);
    } catch (e: unknown) {
      fixFailed(
        oldId,
        'correct',
        `Your correction to “${oldTitle}” was not saved.`,
        e,
        correctionRefusal(sqlState(e), sqlDetail(e)),
      );
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
      setWorking(false);
      focusAfter('course-notice');
      return;
    }
    // Restored: the course is read again whatever follows. Whether the lesson now shows is
    // asked on its own, so a failure to ask cannot be told as a failure to restore.
    setAttempt((n) => n + 1);
    let text =
      target.kind === 'lesson'
        ? 'Restored. The lesson is back in the course.'
        : 'Restored. The claim is back in the course.';
    if (target.kind === 'lesson') {
      const shown = await lessonShown(target.id).catch(() => null);
      if (shown === false) {
        text =
          'Restored your report. The lesson is still not shown: a claim it rests on is reported, or it has been withdrawn or replaced.';
      } else if (shown === null) {
        text = 'Restored.';
      }
    }
    setNotice({ text, undo: null });
    setWorking(false);
    focusAfter('course-notice');
  };

  const begin = (plan: PlannedLesson[]) => {
    if (plan.length === 0) return;
    leaveLesson();
    setNotice(null);
    setSittingReads([]);
    setView({ kind: 'session', plan, index: 0 });
    window.scrollTo(0, 0);
  };

  const startSession = (from: OutlineLesson | null) =>
    begin(planLessons(shownUnits, planSession(shownUnits, from?.lessonId ?? null)));

  /** Back to the course page, with focus on its title. */
  /**
   * Leaving the lesson over a correction typed and not saved asks once, as Done and Skip do:
   * the first press says so, the second leaves it.
   */
  const mayLeave = (where: 'top' | 'bottom') => {
    if (unsaved && leaving === null) {
      setLeaving(where);
      return false;
    }
    return true;
  };

  const toOverview = () => {
    // A lesson's change on its way is waited for, as Done and Skip wait for it: leaving under
    // a correction being saved asked whether to leave it unsaved, and took its draft with it.
    // The end of a sitting has no form to wait for; a restore there says its result wherever
    // the reader has gone.
    if (working && view.kind === 'session') return;
    if (!mayLeave('top')) return;
    leaveLesson();
    setView({ kind: 'overview' });
    focusAfter('course-title');
    window.scrollTo(0, 0);
  };

  const advance = (kind: 'lesson_read' | 'lesson_skipped') => {
    if (view.kind !== 'session' || !currentId || working) return;
    // A correction typed and not saved is not dropped on one press.
    if (!mayLeave('bottom')) return;
    // Only a lesson the reader was shown is recorded. One that would not open -- held back
    // by a report on a claim it shares, withdrawn in another tab, or unreachable offline --
    // was never seen, and a skip recorded for it kept it out of every later session.
    if (lesson?.lessonId === currentId) {
      send(kind, currentId);
      if (kind === 'lesson_read') setSittingReads((r) => [...r, currentId]);
    }
    leaveLesson();
    setNotice(null);
    if (view.index + 1 < view.plan.length) {
      setView({ ...view, index: view.index + 1 });
    } else {
      setView({ kind: 'stop', plan: view.plan });
      // The end of a sitting is a new screen: a keyboard or screen-reader reader starts at
      // its heading, as they do at a lesson's.
      focusAfter('course-stop-title');
    }
    window.scrollTo(0, 0);
  };

  const toggleListen = () => {
    if (!lesson) return;
    if (listening) {
      silence(lesson.lessonId);
      return;
    }
    // Paused from the player's bar: go on from where it stopped rather than from the top.
    if (paused) {
      player.resume();
      return;
    }
    const text = [lesson.title, lesson.objective, lesson.explanation, lesson.example, lesson.recap]
      .filter(Boolean)
      .join('\n\n');
    // Only with a local voice, so the reader's material is not sent to a speech service;
    // `localOnly` holds the player to that, and keeps the lesson out of its stored queue.
    if (!localVoice) return;
    const id = lessonTrackId(lesson.lessonId);
    // Any other lesson this screen queued goes first: an interlude ends on what it
    // interrupted, and that must not be an earlier lesson.
    for (const other of queuedLessons.current) if (other !== id) dismiss(other);
    queuedLessons.current = new Set([id]);
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
      // The section goes once the course reads as preparing; the line saying so takes focus.
      focusAfter('course-preparing');
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
  /** The course is deleted: say so, and take its title -- perhaps the reader's goal -- off. */
  const gone = () => {
    setDeleted(true);
    onTitle?.(null);
    focusAfter('course-title');
  };

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
      gone();
    } catch (e: unknown) {
      // Already gone -- deleted in another tab, or with its last source -- is done.
      if (sqlState(e) === 'P0002') {
        gone();
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
  // Always drawn, empty or not: a live region added together with its text is not reliably
  // announced, and this is the line that says what just happened.
  const noticeLine = (
    <p
      id="course-notice"
      className={notice ? 'course__notice' : 'sr-only'}
      role="status"
      tabIndex={notice ? -1 : undefined}
    >
      {notice?.text}
      {notice?.undo && ' '}
      {notice?.undo && (
        <button
          type="button"
          className="btn btn--plain"
          aria-disabled={working}
          onClick={() => {
            const target = notice?.undo;
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
    // Always drawn, above the lesson and below it, and filled only beside the control that
    // was pressed: a live region added together with its text is not reliably announced, and
    // the press that shows this does nothing else.
    const unsavedLine = (where: 'top' | 'bottom') => (
      <p role="status" className={leaving === where ? undefined : 'sr-only'}>
        {leaving === where &&
          'Your correction to this lesson is not saved. Press again to leave it unsaved, or save it under “Something wrong with this lesson?”.'}
      </p>
    );
    const cancelFix = (focus: string) => {
      closeFixes();
      focusAfter(focus);
    };
    return (
      <section className="stack measure course">
        <div className="course__bar">
          <button
            type="button"
            className="btn btn--plain meta"
            aria-disabled={working}
            onClick={toOverview}
          >
            ← {title}
          </button>
          <span className="meta">
            Lesson {view.index + 1} of {view.plan.length} in this sitting
          </span>
        </div>
        {noticeLine}
        {unsavedLine('top')}
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
                    {listening
                      ? 'Stop reading the lesson aloud'
                      : paused
                        ? 'Resume reading the lesson aloud'
                        : 'Read this lesson aloud'}
                  </button>
                </p>
              ) : (
                <p>
                  Reading aloud needs a voice installed on this device, so that your material is not
                  sent to a speech service.
                </p>
              ))}
            <details
              className="course__sources"
              onToggle={(e) => {
                if (!(e.currentTarget as HTMLDetailsElement).open) setClaimReport(null);
              }}
            >
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
            {/* Not controlled: Cancel closes a form, not the section the reader opened. Folding
                the section closes its form (a correction is kept in `draft`), so Done is the
                screen's primary control again. */}
            <details
              className="course__sources course__fix"
              onToggle={(e) => {
                if (!(e.currentTarget as HTMLDetailsElement).open) {
                  setFix(null);
                  setFixError(null);
                }
              }}
            >
              <summary id="course-fix-summary">Something wrong with this lesson?</summary>
              {fix === null && (
                <>
                  <p>
                    Report it and it is held back at once; correct it and it reads as you write it;
                    or withdraw it from the course for good.
                  </p>
                  {unsaved && leaving === null && (
                    <p>Your correction is not saved yet. Correct it to go on with it.</p>
                  )}
                  <div className="course__actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setClaimReport(null);
                        setFixError(null);
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
                        setFixError(null);
                        setFix('correct');
                        // Back at the form, the reader is deciding again.
                        setLeaving(null);
                      }}
                    >
                      Correct it
                    </button>
                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => {
                        setClaimReport(null);
                        setFixError(null);
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
                    setLeaving(null);
                  }}
                  onSave={(value) => void correct(value)}
                  onCancel={() => {
                    setDraft(null);
                    setLeaving(null);
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
        <p role="status" className={progressNote ? undefined : 'sr-only'}>
          {progressNote}
        </p>
        {unsavedLine('bottom')}
        <div className="course__actions">
          <button
            type="button"
            className={fixing ? 'btn' : 'btn btn--primary'}
            aria-disabled={!lesson || working}
            onClick={() => lesson && advance('lesson_read')}
          >
            {view.index + 1 < view.plan.length ? 'Done — next lesson' : 'Finish the sitting'}
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
    // What this sitting read, from the lessons it planned and the reads it recorded -- not
    // the outline, which counts earlier sittings' reads, and after a newer preparation
    // arrives has none of these lessons at all.
    const readHere = new Set(sittingReads);
    const covered = view.plan
      .filter((p) => readHere.has(p.lessonId))
      .map((p) => ({ title: p.title, recap: recaps[p.lessonId] ?? null }));
    const remaining = lessons.filter((l) => l.state !== 'read' && l.state !== 'skipped').length;
    return (
      <section className="stack measure course">
        <div className="course__bar">
          <button type="button" className="btn btn--plain meta" onClick={toOverview}>
            ← {title}
          </button>
        </div>
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
        <p id="course-preparing" role="status" tabIndex={-1}>
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
          A source this course was prepared from was deleted, and this version of the course went
          with it: its lessons, its questions and your place in it. Prepare it again from the{' '}
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
            <p id="course-preparing" role="status" tabIndex={-1}>
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
                    {lessons.every((l) => l.state === 'not_seen')
                      ? 'Start the course'
                      : 'Continue where you left off'}
                  </button>
                ) : (
                  skipped > 0 && (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => begin(planLessons(shownUnits, planSkipped(shownUnits)))}
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
          {courseEnded && <CourseRecap course={course} />}
          <HeldBackList
            items={held}
            working={working}
            onRestore={(target) => void restore(target)}
          />
        </>
      )}

      <hr className="rule" />
      {(course.updateAvailable || status === 'failed' || status === 'empty') &&
        !course.preparing &&
        !course.awaitingValidation && (
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
