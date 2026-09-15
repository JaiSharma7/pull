import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

export interface DailyPull {
  pullId: string;
  ordinal: number;
  reason: 'fading' | 'unseen' | 'editorial';
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
  /** Present only when an older deployment serves the editorial archive. */
  editorialDay?: string | null;
}

/** SQL chooses and remembers the set; no model runs when a reader opens it. */
export async function fetchDailyCuration(day: string): Promise<DailyCuration> {
  const { data, error } = await supabase.rpc('get_daily_pulls', { p_day: day });
  if (error?.code === 'PGRST202') return fetchEditorialCuration(day);
  if (error) throw rpcError(error);
  return data as unknown as DailyCuration;
}

/** Compatibility with deployments that have not applied personal Daily Pull migrations. */
async function fetchEditorialCuration(day: string): Promise<DailyCuration> {
  const { data, error } = await supabase
    .from('daily_pulls')
    .select(
      'day,ordinal,blurb,pulls!inner(id,headline,body,why_it_matters,summaries!inner(title,works!inner(id,title,kind,year)))',
    )
    .lte('day', day)
    .eq('pulls.summaries.status', 'published')
    .eq('pulls.summaries.visibility', 'public')
    .in('pulls.summaries.works.rights_status', ['public_domain', 'licensed'])
    .order('day', { ascending: false })
    .order('ordinal')
    .limit(5);
  if (error) throw rpcError(error);
  const editorialDay = data?.[0]?.day ?? null;
  return {
    day,
    editorialDay,
    pulls: (data ?? [])
      .filter((row) => row.day === editorialDay)
      .map((row) => ({
        pullId: row.pulls.id,
        ordinal: row.ordinal,
        reason: 'editorial',
        headline: row.pulls.headline,
        body: row.pulls.body,
        whyItMatters: row.blurb ?? row.pulls.why_it_matters,
        workId: row.pulls.summaries.works.id,
        workTitle: row.pulls.summaries.works.title,
        workKind: row.pulls.summaries.works.kind,
        workYear: row.pulls.summaries.works.year,
        summaryTitle: row.pulls.summaries.title,
      })),
  };
}
