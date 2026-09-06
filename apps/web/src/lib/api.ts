import type { RecallGrade } from './grades.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';
import type { DueReview, FeedResponse, LibraryItem, SourceDelta } from './types.js';

/**
 * All reads go through Postgres RPCs. No model is called anywhere in here —
 * ranking, the Delta and the interleave plan are SQL and pgvector arithmetic.
 * See CLAUDE.md law 2; `/costcheck` audits this file.
 */

export async function fetchFeed(params: {
  seed: number;
  page: number;
  cardsBefore: number;
  usedBudget: number;
  limit?: number;
  /**
   * Where the previous page put its last question, in planner space.
   *
   * `get_feed` has accepted this since `20260829135224_interleave_gap_and_precision`
   * and nothing has ever sent it, because the client only ever asked for page 0.
   * It carries the interleave planner's minimum gap across a page boundary: without
   * it, a question on the last card of one page leaves slot 0 of the next
   * immediately eligible and the reader gets two questions one card apart.
   *
   * Inert while there was no second page; a live bug the moment there is one. So it
   * ships with pagination rather than after it.
   */
  lastPlaced?: number | null;
}): Promise<FeedResponse> {
  const { data, error } = await supabase.rpc('get_feed', {
    p_limit: params.limit ?? 20,
    p_seed: params.seed,
    p_page: params.page,
    p_cards_before: params.cardsBefore,
    p_used_budget: params.usedBudget,
    p_last_placed: params.lastPlaced ?? undefined,
  });
  if (error) throw rpcError(error);
  return data as unknown as FeedResponse;
}

export async function fetchDueReviews(limit = 20): Promise<DueReview[]> {
  const { data, error } = await supabase.rpc('get_due_reviews', { p_limit: limit });
  if (error) throw rpcError(error);
  return (data ?? []) as unknown as DueReview[];
}

export async function fetchSourceDelta(workId: string): Promise<SourceDelta> {
  const { data, error } = await supabase.rpc('get_source_delta', { p_work_id: workId });
  if (error) throw rpcError(error);
  return data as unknown as SourceDelta;
}

export async function recordRead(pullId: string, dwellMs: number, position: number) {
  const { error } = await supabase.rpc('record_read', {
    p_pull_id: pullId,
    p_dwell_ms: dwellMs,
    p_position: position,
  });
  if (error) throw rpcError(error);
}

/**
 * What travels with a grade beyond the grade itself.
 *
 * `mutationId` is the one that changes what the client may do. Until
 * 20260905100000 `grade_recall` applied every call it received — it multiplies
 * stability and increments `reps` — so a retry of a lost response roughly squared
 * the interval and a card fell out of review for months. The client could
 * therefore only queue a grade it could PROVE had never left the tab, and dropped
 * every ambiguous failure on the floor. With the id, the server recognises a
 * replay as the same attempt and returns the state untouched, so an ambiguous
 * failure is queueable and a grade stops being losable.
 *
 * `submittedAt` is when the reader answered, not when the queue gave up, for the
 * reason `setConviction` gives below: it is the only way to order two requests
 * that overlap. The rest is evidence `recall_events` keeps per attempt —
 * `confidence` is the half only the reader can supply, and a confident miss is
 * the one worth repairing first.
 */
export interface GradeProvenance {
  mutationId: string;
  submittedAt: number;
  confidence?: 'sure' | 'unsure';
  /** A `quiz_questions` id, or one of the reader's own from `user_questions`. */
  questionId?: string;
  kind?: string;
  latencyMs?: number;
  answer?: string;
}

export async function gradeRecall(
  pullId: string,
  grade: RecallGrade,
  provenance?: GradeProvenance,
) {
  const { error } = await supabase.rpc('grade_recall', {
    p_pull_id: pullId,
    p_grade: grade,
    // Optional so a caller that has nothing to say behaves exactly as before:
    // every added parameter defaults, and an absent mutation id means the write
    // is applied rather than de-duplicated — which is what a replayed entry
    // queued by an older build needs.
    ...(provenance
      ? {
          p_mutation_id: provenance.mutationId,
          p_submitted_at: new Date(provenance.submittedAt).toISOString(),
          ...(provenance.confidence ? { p_confidence: provenance.confidence } : {}),
          ...(provenance.questionId ? { p_question_id: provenance.questionId } : {}),
          ...(provenance.kind ? { p_kind: provenance.kind } : {}),
          ...(typeof provenance.latencyMs === 'number'
            ? { p_latency_ms: provenance.latencyMs }
            : {}),
          ...(provenance.answer ? { p_answer: provenance.answer } : {}),
        }
      : {}),
  });
  if (error) throw rpcError(error);
}

export async function recordInterrupt(args: {
  pullId: string;
  kind: string;
  slot: number;
  response: 'answered' | 'dismissed' | 'expired';
  grade?: RecallGrade;
  latencyMs?: number;
  mutationId?: string;
  submittedAt?: number;
  confidence?: 'sure' | 'unsure';
}) {
  const { error } = await supabase.rpc('record_interrupt', {
    p_pull_id: args.pullId,
    p_kind: args.kind as never,
    p_slot: args.slot,
    p_response: args.response,
    p_grade: args.grade as never,
    p_latency: args.latencyMs,
    // `record_interrupt` stops at its own row on a replay and only then grades,
    // so one id makes the interrupt, the grade and the session bump idempotent
    // together.
    ...(args.mutationId ? { p_mutation_id: args.mutationId } : {}),
    ...(typeof args.submittedAt === 'number'
      ? { p_submitted_at: new Date(args.submittedAt).toISOString() }
      : {}),
    ...(args.confidence ? { p_confidence: args.confidence } : {}),
  });
  if (error) throw rpcError(error);
}

/**
 * Two pieces of provenance travel with a stance, and they answer different
 * questions.
 *
 * `mutationId` says *which submission this is*, so a replay of one already
 * recorded is returned rather than reapplied. `submittedAt` says *when the
 * reader decided*, so a submission older than the stance on record loses no
 * matter how long its request took to arrive — which is the only way to order
 * two requests that overlap, since neither the browser nor the queue can
 * observe both of them finishing.
 */
export async function setConviction(
  pullId: string,
  stance: 'agree' | 'disagree' | 'unsure',
  mutationId: string,
  submittedAt: number,
  confidence = 0.6,
) {
  const { error } = await supabase.rpc('set_conviction', {
    p_pull_id: pullId,
    p_stance: stance,
    p_confidence: confidence,
    p_mutation_id: mutationId,
    p_submitted_at: new Date(submittedAt).toISOString(),
  });
  if (error) throw rpcError(error);
}

/**
 * Keep what the reader wrote in their own words.
 *
 * This is the whole point of Say It Back: an explanation someone can actually
 * produce is the strongest evidence the knowledge model has, and it becomes a
 * personal annotation on the card. Grading it is round 2 — `gap_score` and
 * `missed_points` stay null until a provider fills them — but the text has to be
 * kept now or there is nothing to grade later.
 *
 * `mutationId` is minted once per submission and reused by any queued retry, so
 * a replay after a lost response collides on `explanations_client_mutation_key`
 * rather than writing the reader's paragraph twice.
 */
export async function saveExplanation(
  userId: string,
  pullId: string,
  text: string,
  mutationId: string,
) {
  const { error } = await supabase
    .from('explanations')
    .insert({ user_id: userId, pull_id: pullId, text, client_mutation_id: mutationId });
  // The collision means this exact submission already landed, which is the
  // outcome the caller wanted — not a failure to retry.
  if (error && error.code !== '23505') throw rpcError(error);
}

/** Saving is unlimited and free, by policy. There is no quota to check. */
export async function savePull(pullId: string, userId: string) {
  const { error } = await supabase.from('saved_items').insert({ user_id: userId, pull_id: pullId });
  // A duplicate save is idempotent, not an error: the unique index is doing its
  // job and the reader's intent is already satisfied.
  if (error && error.code !== '23505') throw rpcError(error);
}

export async function unsavePull(pullId: string, userId: string) {
  const { error } = await supabase
    .from('saved_items')
    .delete()
    .eq('user_id', userId)
    .eq('pull_id', pullId);
  if (error) throw rpcError(error);
}

/**
 * Every saved pull, paged.
 *
 * PostgREST caps a response at `max_rows` (100), so a single unpaged select
 * silently returns a slice of a large library and the rest render as unsaved —
 * with the Save button doing nothing, since the insert collides and is
 * swallowed as a duplicate. Law 3 promises unlimited stashing; that has to hold
 * in the read path too, not just in the table.
 */
export async function fetchSavedPullIds(userId: string): Promise<Set<string>> {
  const PAGE = 100;
  const ids = new Set<string>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('saved_items')
      .select('pull_id')
      .eq('user_id', userId)
      .not('pull_id', 'is', null)
      // Ordered so the pages partition the set. Without it PostgREST may return
      // rows in any order and a range walk can repeat or skip.
      .order('pull_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw rpcError(error);

    const rows = data ?? [];
    for (const r of rows) if (r.pull_id !== null) ids.add(r.pull_id);
    if (rows.length < PAGE) return ids;
  }
}

/**
 * The Library: saved Pulls, newest first, with the source that anchors them.
 *
 * Paged for the same reason as `fetchSavedPullIds` — `max_rows` is 100 and law 3
 * promises unlimited stashing, so a library that silently stops at 100 breaks the
 * promise in the one place the reader would notice.
 *
 * Ordered by `created_at` here rather than `pull_id`: a library is read as a
 * history, and the tiebreak on `pull_id` keeps the page boundaries stable when
 * several saves share a timestamp.
 */
export async function fetchLibrary(userId: string): Promise<LibraryItem[]> {
  const PAGE = 100;
  const items: LibraryItem[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('saved_items')
      .select(
        'id, created_at, pull_id, stash_id, note, archived, read_later, pulls(id, headline, body, why_it_matters, explanation, example, summaries(works(id, title, kind)))',
      )
      .eq('user_id', userId)
      .not('pull_id', 'is', null)
      .order('created_at', { ascending: false })
      .order('pull_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw rpcError(error);

    const rows = (data ?? []) as unknown as {
      id: string;
      created_at: string;
      stash_id: string | null;
      note: string | null;
      archived: boolean;
      read_later: boolean;
      pulls: {
        id: string;
        headline: string;
        body: string;
        why_it_matters: string | null;
        explanation: string | null;
        example: string | null;
        summaries: { works: { id: string; title: string; kind: string | null } | null } | null;
      } | null;
    }[];

    for (const r of rows) {
      // A saved row whose pull has been removed is expected, not corrupt: the
      // FK is `on delete set null` so a takedown leaves the save behind. Skip it
      // rather than rendering an empty card.
      if (!r.pulls) continue;
      const work = r.pulls.summaries?.works;
      items.push({
        id: r.pulls.id,
        headline: r.pulls.headline,
        body: r.pulls.body,
        whyItMatters: r.pulls.why_it_matters,
        explanation: r.pulls.explanation,
        example: r.pulls.example,
        savedAt: r.created_at,
        work: work ?? { id: '', title: 'Unknown source', kind: null },
        saveId: r.id,
        stashId: r.stash_id,
        note: r.note,
        archived: r.archived,
        readLater: r.read_later,
      });
    }

    if (rows.length < PAGE) return items;
  }
}
