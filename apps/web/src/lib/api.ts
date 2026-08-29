import type { RecallGrade } from './grades.js';
import { supabase } from './supabase.js';
import type { DueReview, FeedResponse, SourceDelta } from './types.js';

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
}): Promise<FeedResponse> {
  const { data, error } = await supabase.rpc('get_feed', {
    p_limit: params.limit ?? 20,
    p_seed: params.seed,
    p_page: params.page,
    p_cards_before: params.cardsBefore,
    p_used_budget: params.usedBudget,
  });
  if (error) throw error;
  return data as unknown as FeedResponse;
}

export async function fetchDueReviews(limit = 20): Promise<DueReview[]> {
  const { data, error } = await supabase.rpc('get_due_reviews', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as unknown as DueReview[];
}

export async function fetchSourceDelta(workId: string): Promise<SourceDelta> {
  const { data, error } = await supabase.rpc('get_source_delta', { p_work_id: workId });
  if (error) throw error;
  return data as unknown as SourceDelta;
}

export async function recordRead(pullId: string, dwellMs: number, position: number) {
  const { error } = await supabase.rpc('record_read', {
    p_pull_id: pullId,
    p_dwell_ms: dwellMs,
    p_position: position,
  });
  if (error) throw error;
}

export async function gradeRecall(pullId: string, grade: RecallGrade) {
  const { error } = await supabase.rpc('grade_recall', { p_pull_id: pullId, p_grade: grade });
  if (error) throw error;
}

export async function recordInterrupt(args: {
  pullId: string;
  kind: string;
  slot: number;
  response: 'answered' | 'dismissed' | 'expired';
  grade?: RecallGrade;
  latencyMs?: number;
}) {
  const { error } = await supabase.rpc('record_interrupt', {
    p_pull_id: args.pullId,
    p_kind: args.kind as never,
    p_slot: args.slot,
    p_response: args.response,
    p_grade: args.grade as never,
    p_latency: args.latencyMs,
  });
  if (error) throw error;
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
  if (error) throw error;
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
  if (error && error.code !== '23505') throw error;
}

/** Saving is unlimited and free, by policy. There is no quota to check. */
export async function savePull(pullId: string, userId: string) {
  const { error } = await supabase.from('saved_items').insert({ user_id: userId, pull_id: pullId });
  // A duplicate save is idempotent, not an error: the unique index is doing its
  // job and the reader's intent is already satisfied.
  if (error && error.code !== '23505') throw error;
}

export async function unsavePull(pullId: string, userId: string) {
  const { error } = await supabase
    .from('saved_items')
    .delete()
    .eq('user_id', userId)
    .eq('pull_id', pullId);
  if (error) throw error;
}

export async function fetchSavedPullIds(userId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('saved_items')
    .select('pull_id')
    .eq('user_id', userId)
    .not('pull_id', 'is', null);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.pull_id).filter((id): id is string => id !== null));
}
