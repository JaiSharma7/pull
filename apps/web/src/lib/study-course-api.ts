/**
 * The study-course calls, wrapped once so every screen reads them the same way.
 *
 * Reads go through the SQL read path and the `study_visible_*` views, so only what a
 * learner may be shown ever reaches the browser. Writes go through the functions the
 * database offers a reader and nothing else. See `docs/study-courses.md`.
 */
import { rpcError } from './rpc-error.js';
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

export async function fetchCourses(signal?: AbortSignal): Promise<CourseSummary[]> {
  const request = supabase
    .from('study_course_overview')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw rpcError(error);
  return shapeCourseSummaries(data);
}

/** One course, or null when it is not the reader's or no longer exists. */
export async function fetchCourse(
  courseId: string,
  signal?: AbortSignal,
): Promise<CourseSummary | null> {
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
 * own material it rests on. Five small reads rather than one embed: the views carry no
 * foreign keys PostgREST could embed through.
 */
export async function fetchLesson(
  lessonId: string,
  signal?: AbortSignal,
): Promise<LessonContent | null> {
  const abortable = <T extends { abortSignal: (s: AbortSignal) => T }>(q: T): T =>
    signal ? q.abortSignal(signal) : q;

  const lessonRead = await abortable(
    supabase
      .from('study_visible_lessons')
      .select('id, title, objective, explanation, example, recap, minutes')
      .eq('id', lessonId),
  );
  if (lessonRead.error) throw rpcError(lessonRead.error);
  const lesson = lessonRead.data?.[0];
  if (!lesson) return null;

  const links = await abortable(
    supabase.from('study_lesson_claims').select('claim_id').eq('lesson_id', lessonId),
  );
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

  const evidence = shownIds.length
    ? await abortable(
        supabase
          .from('study_claim_evidence')
          .select('claim_id, ordinal, span_text, start_offset, end_offset, page, match')
          .in('claim_id', shownIds),
      )
    : { data: [], error: null };
  if (evidence.error) throw rpcError(evidence.error);

  const versionIds = [
    ...new Set((claims.data ?? []).map((c) => c.source_version_id).filter(Boolean)),
  ] as string[];
  const versions = versionIds.length
    ? await abortable(
        supabase.from('study_source_versions').select('id, title').in('id', versionIds),
      )
    : { data: [], error: null };
  if (versions.error) throw rpcError(versions.error);

  return shapeLessonContent({
    lesson,
    claims: claims.data,
    evidence: evidence.data,
    versions: versions.data,
  });
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

export interface HeldBack {
  reportId: string;
  kind: ReportKind;
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
  const seen = new Set<string>();
  const held: HeldBack[] = [];
  for (const r of rows) {
    const target = r.lesson_id ?? r.claim_id;
    const label = target ? labels.get(target) : undefined;
    if (!target || label === undefined || seen.has(target)) continue;
    seen.add(target);
    held.push({ reportId: r.id, kind: r.lesson_id ? 'lesson' : 'claim', label });
  }
  return held;
}
