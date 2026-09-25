/**
 * The study-course calls, wrapped once so every screen reads them the same way.
 *
 * Reads go through the SQL read path and the `study_visible_*` views, so only what a
 * learner may be shown ever reaches the browser. Writes go through the functions the
 * database offers a reader and nothing else. See `docs/study-courses.md`.
 */
import { rpcError, sqlState } from './rpc-error.js';
import {
  shapeCourseSummaries,
  shapeCourseSummary,
  shapeLessonContent,
  shapeOutline,
  shapeProgressResult,
  type CourseSummary,
  type LessonContent,
  type LessonDraft,
  type OutlineUnit,
  type ProgressEvent,
  type ProgressResult,
  type ReportKind,
  type ReportReason,
} from './study-course.js';
import { supabase } from './supabase.js';

/** How many courses the list shows: the newest. */
export const COURSE_LIST_LIMIT = 200;

/**
 * The reader's courses, newest first, and whether there are more than the list shows -- one
 * more is asked for, so a long list says it was cut rather than silently losing its end.
 */
export async function fetchCourses(
  signal?: AbortSignal,
): Promise<{ courses: CourseSummary[]; more: boolean }> {
  const request = supabase
    .from('study_course_overview')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(COURSE_LIST_LIMIT + 1);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  const courses = shapeCourseSummaries(data);
  return { courses: courses.slice(0, COURSE_LIST_LIMIT), more: courses.length > COURSE_LIST_LIMIT };
}

/** A course id's shape. Anything else is no course, not a request Postgres refuses. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One course, or null when it is not the reader's, no longer exists, or the address names
 * none: `/course/<not-a-uuid>` was a 22P02 shown as a raw error, with a Try again that
 * could never work.
 */
export async function fetchCourse(
  courseId: string,
  signal?: AbortSignal,
): Promise<CourseSummary | null> {
  if (!UUID.test(courseId)) return null;
  const request = supabase.from('study_course_overview').select('*').eq('course_id', courseId);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return shapeCourseSummary(data?.[0]);
}

export async function fetchOutline(courseId: string, signal?: AbortSignal): Promise<OutlineUnit[]> {
  const request = supabase.rpc('study_course_outline', { p_course_id: courseId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return shapeOutline(data);
}

/**
 * A lesson's text and the claims it teaches, each with the exact passages of the reader's
 * own material it rests on. Small reads rather than one embed -- the views carry no foreign
 * keys PostgREST could embed through -- in three round trips: what does not depend on an
 * answer goes in parallel, since a phone pays for each trip before every next lesson.
 */
export async function fetchLesson(
  lessonId: string,
  signal?: AbortSignal,
): Promise<LessonContent | null> {
  const abortable = <T extends { abortSignal: (s: AbortSignal) => T }>(q: T): T =>
    signal ? q.abortSignal(signal) : q;

  const [lessonRead, links] = await Promise.all([
    abortable(
      supabase
        .from('study_visible_lessons')
        .select('id, title, objective, explanation, example, recap, minutes')
        .eq('id', lessonId),
    ),
    abortable(supabase.from('study_lesson_claims').select('claim_id').eq('lesson_id', lessonId)),
  ]);
  if (lessonRead.error) throw rpcError(lessonRead.error);
  const lesson = lessonRead.data?.[0];
  if (!lesson) return null;
  if (links.error) throw rpcError(links.error);
  const claimIds = (links.data ?? []).map((l) => l.claim_id);

  // The claims a learner may be shown, and then only their evidence: a claim validation
  // held back keeps its passages off the screen with it.
  const claims = claimIds.length
    ? await abortable(
        supabase
          .from('study_visible_claims')
          .select('id, statement, qualifications, attribution, source_version_id')
          .in('id', claimIds),
      )
    : { data: [], error: null };
  if (claims.error) throw rpcError(claims.error);
  const shownIds = (claims.data ?? []).map((c) => c.id).filter(Boolean) as string[];
  const versionIds = [
    ...new Set((claims.data ?? []).map((c) => c.source_version_id).filter(Boolean)),
  ] as string[];

  const [evidence, versions] = await Promise.all([
    shownIds.length
      ? abortable(
          supabase
            .from('study_claim_evidence')
            .select('claim_id, ordinal, span_text, start_offset, end_offset, page, match')
            .in('claim_id', shownIds),
        )
      : Promise.resolve({ data: [], error: null }),
    versionIds.length
      ? abortable(supabase.from('study_source_versions').select('id, title').in('id', versionIds))
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (evidence.error) throw rpcError(evidence.error);
  if (versions.error) throw rpcError(versions.error);

  return shapeLessonContent({
    lesson,
    claims: claims.data,
    evidence: evidence.data,
    versions: versions.data,
  });
}

/** Whether a lesson is shown to the reader now: one read of the visible lessons. */
export async function lessonShown(lessonId: string, signal?: AbortSignal): Promise<boolean> {
  const request = supabase.from('study_visible_lessons').select('id').eq('id', lessonId);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return (data ?? []).length > 0;
}

/** The full text of one of the reader's source versions, to show a passage in context. */
export async function fetchSourceText(versionId: string, signal?: AbortSignal): Promise<string> {
  const request = supabase
    .from('study_source_versions')
    .select('extracted_text')
    .eq('id', versionId);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return data?.[0]?.extracted_text ?? '';
}

export async function recordProgress(events: readonly ProgressEvent[]): Promise<ProgressResult> {
  const { data, error } = await supabase.rpc('record_study_progress', {
    p_events: events.map((e) => ({ ...e })),
  });
  if (error) throw rpcError(error);
  return shapeProgressResult(data);
}

/** Whether this reader may prepare a course: the beta allowlist, answered by the server. */
export async function courseBuildingAvailable(signal?: AbortSignal): Promise<boolean> {
  const request = supabase.rpc('study_generation_available');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return data === true;
}

export interface CourseEnqueued {
  courseId: string | null;
  jobId: string;
  replayed: boolean;
}

function shapeEnqueued(data: unknown): CourseEnqueued {
  const r = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (typeof r.jobId !== 'string') {
    throw new Error('Preparing the course returned an unreadable answer. Try again.');
  }
  return {
    courseId: typeof r.courseId === 'string' ? r.courseId : null,
    jobId: r.jobId,
    replayed: r.replayed === true,
  };
}

export async function buildCourse(input: {
  versionIds: string[];
  goal: string;
  mutationId: string;
  consent: boolean;
}): Promise<CourseEnqueued> {
  const { data, error } = await supabase.rpc('enqueue_study_generation', {
    p_source_version_ids: input.versionIds,
    p_goal: input.goal,
    p_mutation_id: input.mutationId,
    p_processing_consent: input.consent,
  });
  if (error) throw rpcError(error);
  return shapeEnqueued(data);
}

export async function regenerateCourse(input: {
  courseId: string;
  mutationId: string;
  consent: boolean;
}): Promise<CourseEnqueued> {
  const { data, error } = await supabase.rpc('regenerate_study_course', {
    p_course_id: input.courseId,
    p_mutation_id: input.mutationId,
    p_processing_consent: input.consent,
  });
  if (error) throw rpcError(error);
  return shapeEnqueued(data);
}

export async function deleteCourse(courseId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_study_course', { p_course_id: courseId });
  if (error) throw rpcError(error);
}

/** File a report; the lesson or claim is held back at once. Answers with the report's id. */
export async function reportContent(
  kind: ReportKind,
  id: string,
  reason: ReportReason,
  note: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc('report_study_content', {
    p_kind: kind,
    p_id: id,
    p_reason: reason,
    ...(note ? { p_note: note } : {}),
  });
  if (error) throw rpcError(error);
  return String(data);
}

/** The report was mistaken: what it held back returns, unless something else holds it. */
export async function dismissReport(reportId: string): Promise<void> {
  const { error } = await supabase.rpc('dismiss_study_report', { p_report_id: reportId });
  if (error) throw rpcError(error);
}

/** Something the reader can report: a lesson or a claim. */
export interface ReportTarget {
  kind: ReportKind;
  id: string;
}

const REPORT_COLUMN = { lesson: 'lesson_id', claim: 'claim_id' } as const satisfies Record<
  ReportKind,
  string
>;

/**
 * Restore something the reader reported, by dismissing every open report on it.
 *
 * There can be more than one: a report sent again because its answer was lost, or one from
 * another tab. Dismissing only the one the screen knew of left the lesson held back by the
 * other while the screen said it was back. A report settled in the meantime -- 55000, or
 * gone with its course (P0002) -- is already what this asks for.
 */
export async function restoreReported(target: ReportTarget): Promise<void> {
  const { data, error } = await supabase
    .from('study_reports')
    .select('id')
    .eq(REPORT_COLUMN[target.kind], target.id)
    .eq('status', 'open');
  if (error) throw rpcError(error);
  for (const report of data ?? []) {
    try {
      await dismissReport(report.id);
    } catch (e: unknown) {
      const state = sqlState(e);
      if (state !== '55000' && state !== 'P0002') throw e;
    }
  }
}

/** Withdraw a lesson or claim from the course for good. */
export async function retireContent(kind: ReportKind, id: string): Promise<void> {
  const { error } = await supabase.rpc('retire_study_content', { p_kind: kind, p_id: id });
  if (error) throw rpcError(error);
}

/** Save the reader's correction as a new version of the lesson. Answers with its id. */
export async function reviseLesson(
  lessonId: string,
  revision: Partial<Record<keyof LessonDraft, string | null>>,
): Promise<string> {
  const { data, error } = await supabase.rpc('revise_study_lesson', {
    p_lesson_id: lessonId,
    p_revision: revision,
  });
  if (error) throw rpcError(error);
  return String(data);
}

export interface HeldBack extends ReportTarget {
  /** The lesson's title, or the claim's statement. */
  label: string;
}

/**
 * What the reader has reported in a generation and not yet settled: their open reports on
 * lessons and on claims -- a reported claim holds back every lesson resting on it -- each
 * with what it names. Read from the tables, not the visible views, because reported content
 * is exactly what the views hide; only a title or a statement is read.
 */
export async function fetchHeldBack(
  generationId: string,
  signal?: AbortSignal,
): Promise<HeldBack[]> {
  const abortable = <T extends { abortSignal: (s: AbortSignal) => T }>(q: T): T =>
    signal ? q.abortSignal(signal) : q;
  const reports = await abortable(
    supabase
      .from('study_reports')
      .select('id, lesson_id, claim_id, created_at')
      .eq('generation_id', generationId)
      .eq('status', 'open')
      .is('item_id', null)
      .order('created_at', { ascending: true }),
  );
  if (reports.error) throw rpcError(reports.error);
  const rows = reports.data ?? [];
  const lessonIds = [...new Set(rows.map((r) => r.lesson_id).filter(Boolean))] as string[];
  const claimIds = [...new Set(rows.map((r) => r.claim_id).filter(Boolean))] as string[];
  const [lessons, claims] = await Promise.all([
    lessonIds.length
      ? abortable(
          supabase
            .from('study_lessons')
            .select('id, title')
            .eq('status', 'suspended')
            .in('id', lessonIds),
        )
      : Promise.resolve({ data: [], error: null }),
    claimIds.length
      ? abortable(
          supabase
            .from('study_claims')
            .select('id, statement')
            .eq('status', 'suspended')
            .in('id', claimIds),
        )
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (lessons.error) throw rpcError(lessons.error);
  if (claims.error) throw rpcError(claims.error);
  const labels = new Map<string, string>([
    ...(lessons.data ?? []).map((l) => [l.id, l.title] as [string, string]),
    ...(claims.data ?? []).map((c) => [c.id, c.statement] as [string, string]),
  ]);
  // One entry per lesson or claim however many reports it has; restoring it settles all.
  const seen = new Set<string>();
  const held: HeldBack[] = [];
  for (const r of rows) {
    const target = r.lesson_id ?? r.claim_id;
    const label = target ? labels.get(target) : undefined;
    if (!target || label === undefined || seen.has(target)) continue;
    seen.add(target);
    held.push({ kind: r.lesson_id ? 'lesson' : 'claim', id: target, label });
  }
  return held;
}
