/**
 * A reader's private study course, as the screens read it.
 *
 * The rows come from the SQL read path (`study_course_overview`, `study_course_outline`,
 * the `study_visible_*` views) described in `docs/study-courses.md`. Everything here is
 * pure -- shaping, grouping, choosing what to read next, planning a session with an end
 * -- so it can be tested in `environment: 'node'` without the Supabase client.
 *
 * Nothing here decides what the reader knows. Reading a lesson is exposure; whether
 * recall was demonstrated is the database's proof rule, and a later change asks the
 * questions that can establish it.
 */
import { int, isRecord, nullableInt, nullableStr, rows, str } from './shape.js';

export type LessonState = 'not_seen' | 'shown' | 'read' | 'skipped';

export interface Disagreement {
  claimKeys: string[];
  description: string;
}

export interface WithheldQuestion {
  prompt: string;
  reason: string;
}

export interface CourseSummary {
  courseId: string;
  goal: string;
  createdAt: string;
  sourceCount: number;
  /** The current generation, or null before one finishes (or once its sources went). */
  generationId: string | null;
  /** The generated text, only once validated; null or empty otherwise. */
  title: string | null;
  overview: string | null;
  objectives: string[];
  recap: string | null;
  disagreements: Disagreement[];
  withheld: WithheldQuestion[];
  /** The newest generation, current or not, and its job's status. */
  latestGenerationId: string | null;
  latestJobStatus: string | null;
  preparing: boolean;
  newerGenerationHeldBack: boolean;
  /** Validation passed nothing in the current generation. */
  heldBack: boolean;
  /**
   * The newest preparation is saved and waits for its validation, which a sweep finishes
   * within minutes -- whatever its job's status, which can read `failed` when the job's own
   * validation step gave up.
   */
  awaitingValidation: boolean;
  /** The newest generation was saved and validation settled it, whatever its job said. */
  latestSettled: boolean;
  updateAvailable: boolean;
  lessonCount: number;
  lessonsReadCount: number;
  questionCount: number;
  claimCount: number;
  claimsDemonstratedCount: number;
}

export interface OutlineLesson {
  lessonId: string;
  lessonKey: string;
  position: number;
  unitNo: number;
  title: string;
  objective: string;
  minutes: number;
  questionCount: number;
  state: LessonState;
  firstShownAt: string | null;
  readAt: string | null;
}

export interface OutlineUnit {
  unitNo: number;
  title: string;
  lessons: OutlineLesson[];
}

export interface Evidence {
  ordinal: number;
  spanText: string;
  /** Code-point offsets into the source version's text. */
  start: number;
  end: number;
  page: number | null;
}

export interface LessonClaim {
  claimId: string;
  statement: string;
  qualifications: string[];
  attribution: string | null;
  versionId: string;
  sourceTitle: string;
  evidence: Evidence[];
}

export interface LessonContent {
  lessonId: string;
  title: string;
  objective: string;
  explanation: string;
  example: string | null;
  recap: string;
  minutes: number;
  claims: LessonClaim[];
}

// ------------------------------------------------------------------ shaping

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function bool(v: unknown): boolean {
  return v === true;
}

const LESSON_STATES: readonly LessonState[] = ['not_seen', 'shown', 'read', 'skipped'];

function lessonState(v: unknown): LessonState {
  return LESSON_STATES.includes(v as LessonState) ? (v as LessonState) : 'not_seen';
}

/** One `study_course_overview` row, or null when it has no course id to key it by. */
export function shapeCourseSummary(row: unknown): CourseSummary | null {
  if (!isRecord(row)) return null;
  const courseId = str(row.course_id);
  if (!courseId) return null;
  return {
    courseId,
    goal: str(row.goal),
    createdAt: str(row.created_at),
    sourceCount: int(row.source_count),
    generationId: nullableStr(row.generation_id),
    title: nullableStr(row.title),
    overview: nullableStr(row.overview),
    objectives: strings(row.objectives),
    recap: nullableStr(row.recap),
    disagreements: rows(row.disagreements).map((d) => ({
      claimKeys: strings(d.claimKeys),
      description: str(d.description),
    })),
    withheld: rows(row.withheld).map((w) => ({ prompt: str(w.prompt), reason: str(w.reason) })),
    latestGenerationId: nullableStr(row.latest_generation_id),
    latestJobStatus: nullableStr(row.latest_job_status),
    preparing: bool(row.preparing),
    newerGenerationHeldBack: bool(row.newer_generation_held_back),
    heldBack: bool(row.held_back),
    awaitingValidation: bool(row.awaiting_validation),
    latestSettled: bool(row.latest_settled),
    updateAvailable: bool(row.update_available),
    lessonCount: int(row.lesson_count),
    lessonsReadCount: int(row.lessons_read_count),
    questionCount: int(row.question_count),
    claimCount: int(row.claim_count),
    claimsDemonstratedCount: int(row.claims_demonstrated_count),
  };
}

export function shapeCourseSummaries(data: unknown): CourseSummary[] {
  return (Array.isArray(data) ? data : [])
    .map(shapeCourseSummary)
    .filter((c): c is CourseSummary => c !== null);
}

/**
 * The outline's rows, grouped into units in course order. The rows arrive ordered by
 * unit and position; they are sorted again here so a caller cannot depend on that.
 */
export function shapeOutline(data: unknown): OutlineUnit[] {
  const lessons = rows(data)
    .map((r) => {
      const lessonId = str(r.lesson_id);
      if (!lessonId) return null;
      return {
        lesson: {
          lessonId,
          lessonKey: str(r.lesson_key),
          position: int(r.lesson_position),
          unitNo: int(r.unit_no),
          title: str(r.title),
          objective: str(r.objective),
          minutes: Math.max(1, int(r.minutes)),
          questionCount: int(r.question_count),
          state: lessonState(r.state),
          firstShownAt: nullableStr(r.first_shown_at),
          readAt: nullableStr(r.read_at),
        } satisfies OutlineLesson,
        unitTitle: str(r.unit_title),
      };
    })
    .filter((l) => l !== null)
    .sort((a, b) => a.lesson.unitNo - b.lesson.unitNo || a.lesson.position - b.lesson.position);

  const units: OutlineUnit[] = [];
  for (const { lesson, unitTitle } of lessons) {
    const last = units.at(-1);
    if (last && last.unitNo === lesson.unitNo) {
      last.lessons.push(lesson);
    } else {
      units.push({ unitNo: lesson.unitNo, title: unitTitle, lessons: [lesson] });
    }
  }
  return units;
}

/** A lesson's own text and the claims it rests on, from the rows the API layer gathers. */
export function shapeLessonContent(input: {
  lesson: unknown;
  claims: unknown;
  evidence: unknown;
  versions: unknown;
}): LessonContent | null {
  const lesson = input.lesson;
  if (!isRecord(lesson) || !str(lesson.id)) return null;

  const titles = new Map(rows(input.versions).map((v) => [str(v.id), str(v.title)]));
  const spans = new Map<string, Evidence[]>();
  for (const e of rows(input.evidence)) {
    // An unresolved quote has no span in the reader's text, so there is nothing to show.
    if (e.match === 'unresolved') continue;
    const spanText = str(e.span_text);
    const start = nullableInt(e.start_offset);
    const end = nullableInt(e.end_offset);
    if (!spanText || start === null || end === null) continue;
    const list = spans.get(str(e.claim_id)) ?? [];
    list.push({ ordinal: int(e.ordinal), spanText, start, end, page: nullableInt(e.page) });
    spans.set(str(e.claim_id), list);
  }

  const claims = rows(input.claims)
    .map((c): LessonClaim | null => {
      const claimId = str(c.id);
      if (!claimId) return null;
      const versionId = str(c.source_version_id);
      return {
        claimId,
        statement: str(c.statement),
        qualifications: strings(c.qualifications),
        attribution: nullableStr(c.attribution),
        versionId,
        sourceTitle: titles.get(versionId) || 'Your source',
        evidence: (spans.get(claimId) ?? []).sort((a, b) => a.ordinal - b.ordinal),
      };
    })
    .filter((c): c is LessonClaim => c !== null)
    .sort((a, b) => a.statement.localeCompare(b.statement));

  return {
    lessonId: str(lesson.id),
    title: str(lesson.title),
    objective: str(lesson.objective),
    explanation: str(lesson.explanation),
    example: nullableStr(lesson.example),
    recap: str(lesson.recap),
    minutes: Math.max(1, int(lesson.minutes)),
    claims,
  };
}

// ------------------------------------------------------------------ what the course is doing

export type CourseStatus =
  /** A first generation is being prepared; nothing to read yet. */
  | 'preparing'
  /** The only generation failed or was cancelled before anything could be shown. */
  | 'failed'
  /** Every generation is gone -- a source deletion took them -- and none is on its way. */
  | 'empty'
  /** There is a current generation to study. */
  | 'ready';

export function courseStatus(course: CourseSummary): CourseStatus {
  if (course.generationId) return 'ready';
  if (course.preparing || course.awaitingValidation) return 'preparing';
  // A job that ended with nothing to read -- failed, cancelled, or finished with a course
  // validation never settled within its day -- has failed, and can be prepared again.
  if (course.latestJobStatus !== null) return 'failed';
  return 'empty';
}

/** Whether a screen should look at the course again soon: something is on its way. */
export function awaitingPreparation(course: CourseSummary): boolean {
  return course.preparing || course.awaitingValidation || courseStatus(course) === 'preparing';
}

/** A newer preparation of a course the reader can already read is on its way. */
export function newerPreparationComing(course: CourseSummary): boolean {
  return (
    course.generationId !== null &&
    course.latestGenerationId !== course.generationId &&
    (course.preparing || course.awaitingValidation)
  );
}

/**
 * A later preparation of a course that has one to read, which failed: the reader is still
 * reading the one before, and should know the newer one did not arrive.
 */
export function newerPreparationFailed(course: CourseSummary): boolean {
  return (
    course.generationId !== null &&
    course.latestGenerationId !== null &&
    course.latestGenerationId !== course.generationId &&
    !course.preparing &&
    !course.awaitingValidation &&
    // Saved and settled is not lost: validation held it back, and that is said instead.
    !course.latestSettled &&
    (course.latestJobStatus === 'failed' || course.latestJobStatus === 'cancelled')
  );
}

/**
 * What to tell a reader whose request to prepare a course was refused, from the SQLSTATE
 * and DETAIL the server sent (`docs/study-courses.md`, "Errors"). Null for a refusal whose
 * own message already says it -- the size limit, the budget, the day's ceiling -- so the
 * caller shows that.
 */
export function preparationRefusal(
  code: string | undefined,
  detail: string | undefined,
  /** Preparing an existing course again, whose sources the reader does not choose. */
  again = false,
): string | null {
  switch (code) {
    case '55000':
      if (detail === 'preparing') return 'A new version of this course is already being prepared.';
      if (detail === 'unchanged') {
        return 'None of this course’s sources has changed since it was last prepared, so it would come out the same. Save a newer version of a source in Studio first.';
      }
      return null;
    case '42501':
      if (detail === 'beta') {
        return 'Courses are in a limited beta and are not open to this account yet.';
      }
      if (detail === 'unavailable') {
        return 'One of the chosen sources is no longer in your account. Reload the page and choose again.';
      }
      return null;
    case '22023':
      if (detail === 'too_large') {
        return again
          ? 'Together, this course’s sources are now longer than the 200,000-character limit. Save a shorter version of one in Studio.'
          : 'Together, these sources are longer than the 200,000-character limit. Save a shorter version of one, or choose fewer.';
      }
      return null;
    case '28000':
      return 'Preparing a course needs an account, not a guest session.';
    case 'P0002':
      return 'This course no longer exists.';
    default:
      return null;
  }
}

/** A server message as a sentence: its first letter capitalised. */
export function asSentence(message: string): string {
  const trimmed = message.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** What to call a course: its validated title, else the goal the reader typed. */
export function courseTitle(course: CourseSummary): string {
  return course.title?.trim() || course.goal.trim() || 'Untitled course';
}

export function lessonStateLabel(state: LessonState): string {
  switch (state) {
    case 'read':
      return 'Read';
    case 'skipped':
      return 'Skipped';
    case 'shown':
      return 'Started';
    case 'not_seen':
      return 'Not started';
  }
}

export function minutesLabel(minutes: number): string {
  return minutes === 1 ? '1 min' : `${minutes} min`;
}

/** Lessons read of those there are, for a progress line. Never "0 of 0". */
export function courseProgressLabel(course: CourseSummary): string {
  if (course.lessonCount === 0)
    return course.heldBack ? 'Held back by its checks' : 'Nothing to read';
  if (course.lessonsReadCount >= course.lessonCount) return 'Every lesson read';
  return `${course.lessonsReadCount} of ${course.lessonCount} lessons read`;
}

// ------------------------------------------------------------------ what to read next

function finished(lesson: OutlineLesson): boolean {
  return lesson.state === 'read' || lesson.state === 'skipped';
}

export function allLessons(units: readonly OutlineUnit[]): OutlineLesson[] {
  return units.flatMap((u) => u.lessons);
}

/** The first lesson not yet read or skipped, in course order; null when all are. */
export function nextLesson(units: readonly OutlineUnit[]): OutlineLesson | null {
  return allLessons(units).find((l) => !finished(l)) ?? null;
}

/** About ten minutes: the session the product is built around. */
export const SESSION_MINUTES = 10;

/**
 * The lessons of one session, from `startId` (or the next unfinished lesson) onwards:
 * unfinished lessons in course order until their minutes reach the budget. A session
 * does not cross into a new unit once it has at least half its budget, so it ends at a
 * natural break rather than a lesson into the next topic. Always at least one lesson
 * when any is unfinished; empty when none is.
 */
export function planSession(
  units: readonly OutlineUnit[],
  startId: string | null = null,
  budget: number = SESSION_MINUTES,
): OutlineLesson[] {
  const lessons = allLessons(units);
  const from = startId ? lessons.findIndex((l) => l.lessonId === startId) : -1;
  const candidates = (from >= 0 ? lessons.slice(from) : lessons).filter(
    (l, i) => (from >= 0 && i === 0) || !finished(l),
  );
  return fillSession(candidates, budget);
}

/** Lessons in order until their minutes reach the budget, ending at a unit break. */
function fillSession(candidates: readonly OutlineLesson[], budget: number): OutlineLesson[] {
  const plan: OutlineLesson[] = [];
  let minutes = 0;
  for (const lesson of candidates) {
    const previous = plan.at(-1);
    if (previous) {
      if (minutes >= budget) break;
      if (lesson.unitNo !== previous.unitNo && minutes >= budget / 2) break;
    }
    plan.push(lesson);
    minutes += lesson.minutes;
  }
  return plan;
}

/**
 * A lesson as its session planned it, with its unit's title. A session keeps these for its
 * whole length rather than looking ids up in the outline: a newer preparation finishing
 * mid-session replaces the outline, and a session reading from it lost its unit titles, its
 * recap list, and the unit title a correction starts from.
 */
export interface PlannedLesson {
  lessonId: string;
  title: string;
  unitNo: number;
  unitTitle: string;
}

export function planLessons(
  units: readonly OutlineUnit[],
  lessons: readonly OutlineLesson[],
): PlannedLesson[] {
  const titles = new Map(units.map((u) => [u.unitNo, u.title]));
  return lessons.map((l) => ({
    lessonId: l.lessonId,
    title: l.title,
    unitNo: l.unitNo,
    unitTitle: titles.get(l.unitNo) ?? '',
  }));
}

/**
 * A session's plan after a correction: the new version takes the old one's place, with its
 * title, and a changed unit title renames the whole unit, as the outline will.
 */
export function planAfterCorrection(
  plan: readonly PlannedLesson[],
  oldId: string,
  newId: string,
  unitNo: number,
  after: Pick<LessonDraft, 'title' | 'unitTitle'>,
): PlannedLesson[] {
  return plan.map((p) => {
    const unit = p.unitNo === unitNo ? { ...p, unitTitle: after.unitTitle.trim() } : p;
    return p.lessonId === oldId ? { ...unit, lessonId: newId, title: after.title.trim() } : unit;
  });
}

/** Whether the reader has typed a correction to this lesson and not saved it. */
export function draftUnsaved(
  lesson: LessonContent,
  unitTitle: string,
  draft: { lessonId: string; value: LessonDraft } | null,
): boolean {
  return (
    draft !== null &&
    draft.lessonId === lesson.lessonId &&
    lessonRevision(lessonDraft(lesson, unitTitle), draft.value) !== null
  );
}

/** The lessons the reader skipped, in course order. */
export function skippedLessons(units: readonly OutlineUnit[]): OutlineLesson[] {
  return allLessons(units).filter((l) => l.state === 'skipped');
}

/**
 * A session of the lessons the reader skipped, once nothing else is left: skipping is not
 * finishing, and the course offers them again rather than calling itself done.
 */
export function planSkipped(
  units: readonly OutlineUnit[],
  budget: number = SESSION_MINUTES,
): OutlineLesson[] {
  return fillSession(skippedLessons(units), budget);
}

// ------------------------------------------------------------------ the source passage

export interface PassageWindow {
  before: string;
  span: string;
  after: string;
  /** Text was cut before `before` or after `after`. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** How far a context window may widen to reach a word boundary. */
const WORD_REACH = 24;

/** The nearest word start at or before `at`, within reach; `at` itself when there is none. */
function wordStart(points: readonly string[], at: number): number {
  for (let i = at; i >= Math.max(0, at - WORD_REACH); i -= 1) {
    if (i === 0 || /\s/u.test(points[i - 1] ?? '')) return i;
  }
  return at;
}

/** The nearest word end at or after `at`, within reach; `at` itself when there is none. */
function wordEnd(points: readonly string[], at: number): number {
  for (let i = at; i <= Math.min(points.length, at + WORD_REACH); i += 1) {
    if (i === points.length || /\s/u.test(points[i] ?? '')) return i;
  }
  return at;
}

/**
 * A text's code points, kept for the few texts a lesson shows: a source runs to 200,000
 * characters, and splitting it again for every passage on every render cost tens of
 * milliseconds a frame.
 */
const pointsCache = new Map<string, readonly string[]>();
function codePoints(text: string): readonly string[] {
  const cached = pointsCache.get(text);
  if (cached) return cached;
  const points = Array.from(text);
  if (pointsCache.size >= 4) pointsCache.delete(pointsCache.keys().next().value!);
  pointsCache.set(text, points);
  return points;
}

/**
 * The evidence span in its context: up to `radius` characters either side, cut at a
 * word boundary when there is one nearby. Offsets are code points, as the database stores
 * them, so the text is split into code points rather than indexed as UTF-16. Null when the
 * offsets do not fit the text or the span there is not the one recorded -- a stale
 * version, say -- so a screen shows the recorded span alone rather than the wrong passage.
 *
 * The boundary is looked for only a short way. Japanese, Chinese and Thai put no spaces
 * between words, and widening until one appeared took in the whole document.
 */
export function passageWindow(
  text: string,
  evidence: Pick<Evidence, 'start' | 'end' | 'spanText'>,
  radius = 280,
): PassageWindow | null {
  const points = codePoints(text);
  const { start, end } = evidence;
  if (start < 0 || end <= start || end > points.length) return null;
  const span = points.slice(start, end).join('');
  if (span !== evidence.spanText) return null;

  const from = wordStart(points, Math.max(0, start - radius));
  const to = wordEnd(points, Math.min(points.length, end + radius));

  return {
    before: points.slice(from, start).join(''),
    span,
    after: points.slice(end, to).join(''),
    clippedStart: from > 0,
    clippedEnd: to < points.length,
  };
}

// ------------------------------------------------------------------ progress events

export type ProgressKind = 'lesson_shown' | 'lesson_read' | 'lesson_skipped';

export interface ProgressEvent {
  clientEventId: string;
  kind: ProgressKind;
  lessonId: string;
  occurredAt: string;
}

export interface ProgressResult {
  recorded: number;
  duplicates: number;
  refused: { index: number; clientEventId: string | null; reason: string }[];
}

export function shapeProgressResult(data: unknown): ProgressResult {
  const r = isRecord(data) ? data : {};
  return {
    recorded: int(r.recorded),
    duplicates: int(r.duplicates),
    refused: rows(r.refused).map((x) => ({
      index: int(x.index),
      clientEventId: nullableStr(x.clientEventId),
      reason: str(x.reason),
    })),
  };
}

/**
 * The lesson states after events recorded in this session, before the outline is read
 * again: a screen moves on at once rather than waiting for a round trip. Only ever
 * forward -- `read` wins over `skipped` over `shown` -- as the database reads them.
 */
export function applyProgress(
  units: readonly OutlineUnit[],
  events: readonly Pick<ProgressEvent, 'kind' | 'lessonId'>[],
): OutlineUnit[] {
  const rank: Record<LessonState, number> = { not_seen: 0, shown: 1, skipped: 2, read: 3 };
  const reached: Record<ProgressKind, LessonState> = {
    lesson_shown: 'shown',
    lesson_skipped: 'skipped',
    lesson_read: 'read',
  };
  const best = new Map<string, LessonState>();
  for (const e of events) {
    const next = reached[e.kind];
    const now = best.get(e.lessonId);
    if (!now || rank[next] > rank[now]) best.set(e.lessonId, next);
  }
  return units.map((u) => ({
    ...u,
    lessons: u.lessons.map((l) => {
      const next = best.get(l.lessonId);
      return next && rank[next] > rank[l.state] ? { ...l, state: next } : l;
    }),
  }));
}

// ------------------------------------------------------------------ building a course

export const GOAL_SUGGESTIONS = [
  'Explain the argument',
  'Prepare for a discussion',
  'Remember the key findings',
  'Prepare for an assessment',
] as const;

export const MAX_COURSE_SOURCES = 5;

/**
 * Why a chosen set of sources cannot become a course, or null when it can. The size limit
 * (200,000 characters across them) is the server's to check: the list of saved sources does
 * not carry their text, and the refusal says the total.
 */
export function courseSelectionProblem(selected: number, goal: string): string | null {
  if (selected === 0) return 'Choose at least one source.';
  if (selected > MAX_COURSE_SOURCES) return `Choose at most ${MAX_COURSE_SOURCES} sources.`;
  const trimmed = goal.trim();
  if (trimmed.length === 0) return 'Say what the course is for.';
  if (trimmed.length > 300) return 'Keep the goal under 300 characters.';
  return null;
}

// ------------------------------------------------------------------ reports and corrections

export type ReportReason = 'incorrect' | 'unsupported' | 'ambiguous' | 'unanswerable' | 'other';
export type ReportKind = 'lesson' | 'claim';

/**
 * The reasons a reader may give, in words. `unanswerable` is a question's reason, so a
 * lesson and a claim do not offer it; the database accepts the same five for all three.
 */
export const REPORT_REASONS: Record<
  ReportKind,
  readonly { reason: ReportReason; label: string }[]
> = {
  lesson: [
    { reason: 'incorrect', label: 'It gets something wrong' },
    { reason: 'unsupported', label: 'My sources do not say this' },
    { reason: 'ambiguous', label: 'It is unclear, or could be read two ways' },
    { reason: 'other', label: 'Something else' },
  ],
  claim: [
    { reason: 'incorrect', label: 'This is not what my source says' },
    { reason: 'unsupported', label: 'The passage does not support it' },
    { reason: 'ambiguous', label: 'It is unclear, or could be read two ways' },
    { reason: 'other', label: 'Something else' },
  ],
};

export const REPORT_NOTE_LIMIT = 1000;

/** A lesson's text as the reader corrects it. `example` may be empty; nothing else may. */
export interface LessonDraft {
  unitTitle: string;
  title: string;
  objective: string;
  explanation: string;
  example: string;
  recap: string;
}

/** What the database holds each field to (`docs/study-validation.md`, "Size"). */
export const LESSON_FIELD_LIMITS: Record<keyof LessonDraft, number> = {
  unitTitle: 200,
  title: 200,
  objective: 500,
  explanation: 6000,
  example: 2000,
  recap: 1000,
};

export function lessonDraft(lesson: LessonContent, unitTitle: string): LessonDraft {
  return {
    unitTitle,
    title: lesson.title,
    objective: lesson.objective,
    explanation: lesson.explanation,
    example: lesson.example ?? '',
    recap: lesson.recap,
  };
}

/**
 * The revision to send: only the fields the reader changed, since a given field replaces
 * the old one and an absent one is kept. An emptied example is sent as null. Null when
 * nothing changed, so there is nothing to save.
 */
export function lessonRevision(
  before: LessonDraft,
  after: LessonDraft,
): Partial<Record<keyof LessonDraft, string | null>> | null {
  const revision: Partial<Record<keyof LessonDraft, string | null>> = {};
  for (const key of Object.keys(LESSON_FIELD_LIMITS) as (keyof LessonDraft)[]) {
    const next = after[key].trim();
    if (next === before[key].trim()) continue;
    revision[key] = key === 'example' && next === '' ? null : next;
  }
  return Object.keys(revision).length > 0 ? revision : null;
}

const FIELD_NAMES: Record<keyof LessonDraft, string> = {
  unitTitle: 'The unit title',
  title: 'The title',
  objective: 'The objective',
  explanation: 'The explanation',
  example: 'The example',
  recap: 'The recap',
};

/** Why a draft cannot be saved as it stands, or null. The server checks the rest. */
export function lessonDraftProblem(draft: LessonDraft): string | null {
  for (const key of Object.keys(LESSON_FIELD_LIMITS) as (keyof LessonDraft)[]) {
    const value = draft[key].trim();
    if (key !== 'example' && value === '') return `${FIELD_NAMES[key]} cannot be empty.`;
    if (Array.from(value).length > LESSON_FIELD_LIMITS[key]) {
      return `${FIELD_NAMES[key]} can be at most ${LESSON_FIELD_LIMITS[key].toLocaleString('en')} characters.`;
    }
  }
  return null;
}

/** A failed check on a reader's correction, in words. */
const CHECK_WORDS: Record<string, string> = {
  text_missing: 'A field is empty, or only spaces.',
  instruction_like: 'Part of it reads like an instruction to a model rather than teaching.',
  unsourced_link: 'It links to a page none of your sources mention.',
  hidden_characters:
    'It contains hidden characters that would make it read differently from how it is stored.',
  cites_unvalidated_claim:
    'A claim it rests on has been reported or withdrawn since you opened it. Go back to the course and open the lesson again.',
  no_known_claims: 'It no longer rests on a claim from your sources.',
};

/**
 * What to tell a reader whose correction was refused, from the SQLSTATE and DETAIL. A failed
 * check lists its reasons in the DETAIL, comma-separated. Null for a refusal this does not
 * know, so the caller shows the server's own message.
 */
export function correctionRefusal(
  code: string | undefined,
  detail: string | undefined,
): string | null {
  switch (code) {
    case '22023': {
      const reasons = (detail ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
      if (reasons.length === 0) return null;
      return reasons.map((r) => CHECK_WORDS[r] ?? `It did not pass a check (${r}).`).join(' ');
    }
    case '55000':
      return 'This lesson has changed since you opened it. Go back to the course and open it again.';
    case '54000':
      // Two limits share the code, and the refusal names neither in its DETAIL.
      return 'No more corrections can be saved to this lesson: either today’s limit is reached, and it resets at 00:00 UTC, or it has been corrected fifty times, and can now only be withdrawn.';
    case '55P03':
      return 'Another change to this course is being saved. Try again in a moment.';
    case 'P0002':
      return 'This lesson is no longer in your course.';
    case '28000':
      return 'Your session has ended. Sign in again to save a correction.';
    default:
      return null;
  }
}

/** The same for a report or a withdrawal. */
export function reportRefusal(code: string | undefined): string | null {
  switch (code) {
    case '54000':
      return 'That is as many reports as can be filed today. The limit resets at 00:00 UTC.';
    case '55000':
      return 'It has already been withdrawn or replaced.';
    case '55P03':
      return 'Another change to this course is being saved. Try again in a moment.';
    case 'P0002':
      return 'It is no longer in your course.';
    case '28000':
      return 'Your session has ended. Sign in again.';
    default:
      return null;
  }
}
