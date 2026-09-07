import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

export interface DailyPull {
  pullId: string;
  ordinal: number;
  reason: 'fading' | 'unseen';
  headline: string;
  body: string;
  whyItMatters: string | null;
  workId: string;
  workTitle: string;
  workKind: string;
  workYear: number | null;
  summaryTitle: string | null;
}

export interface DailyCuration {
  day: string;
  pulls: DailyPull[];
}

/** SQL chooses and remembers the set; no model runs when a reader opens it. */
export async function fetchDailyCuration(day: string): Promise<DailyCuration> {
  const { data, error } = await supabase.rpc('get_daily_pulls', { p_day: day });
  if (error) throw rpcError(error);
  return data as unknown as DailyCuration;
}
