import {
  dedupeConfidentlyWrong,
  parseConfidentlyWrongRows,
  type ConfidentlyWrongItem,
} from './confidently-wrong.js';
import { supabase } from './supabase.js';

export { CONFIDENTLY_WRONG_COPY, formatAttemptDate } from './confidently-wrong.js';
export type { ConfidentlyWrongItem } from './confidently-wrong.js';

/**
 * Fetch recall_events where confidence = 'sure' and grade = 'forgot' over the last N days.
 * Returns unique items deduplicated by pull_id (most recent first).
 */
export async function fetchConfidentlyWrong(
  userId: string | null,
  days = 30,
  limit = 20,
): Promise<ConfidentlyWrongItem[]> {
  if (!userId) return [];

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('recall_events')
      .select(
        `
        id,
        pull_id,
        applied_at,
        pulls (
          id,
          headline,
          summaries (
            works (
              id,
              title,
              slug
            )
          )
        )
      `,
      )
      .eq('confidence', 'sure')
      .eq('grade', 'forgot')
      .gte('applied_at', sinceIso)
      .order('applied_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('Failed to fetch confidently wrong events:', error);
      return [];
    }

    const parsed = parseConfidentlyWrongRows(data ?? []);
    return dedupeConfidentlyWrong(parsed);
  } catch (err: unknown) {
    console.warn('Network error fetching confidently wrong events:', err);
    return [];
  }
}
