import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * One source, and what a reader still has to learn from it.
 *
 * `get_source_delta` has existed and been tested since round 1 with nothing calling
 * it. It answers the question the product is named for — *you already hold 14 of
 * these 18* — and until now that sentence appeared nowhere a reader could see.
 */

/**
 * The work, with columns enumerated.
 *
 * Never `select('*')`. `20260831013500` dropped the table grant on `works` and
 * re-granted every column except `content_hash`, so a star select is a permission
 * error rather than a fingerprint leak — the safe direction, and the reason a new
 * column is invisible to the API until someone grants it here too.
 */
const WORK_COLUMNS = 'id, kind, title, subtitle, slug, year, description' as const;

export interface SourceWork {
  id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  slug: string;
  year: number | null;
  description: string | null;
}

export interface SourcePull {
  id: string;
  ordinal: number;
  headline: string;
  body: string;
  whyItMatters: string | null;
  /**
   * The longer form of the idea, and how long it takes.
   *
   * Both are already fetched by the feed and rendered nowhere: `FeedRow` carries
   * `explanation` and `estimatedReadSeconds` and the card shows neither. A card is
   * the wrong surface for them — it is meant to be one idea at a glance — but a
   * source page is exactly the place a reader has chosen to go deeper.
   */
  explanation: string | null;
  estimatedReadSeconds: number | null;
}

export interface SourceDetail {
  work: SourceWork;
  summaryTitle: string | null;
  elevatorPitch: string | null;
  whyItMatters: string | null;
  pulls: SourcePull[];
}

/**
 * Everything the source page renders, in two round trips.
 *
 * Published **and public**, deterministically ordered. Filtering on status alone was
 * not enough on either count:
 *
 * `summaries_author_insert` (20260830203352) permits a reader's own published-private
 * summary, and `summary_is_readable` lets them read it — so the canonical page could
 * quietly render their private row instead of the library's, for them and nobody else.
 *
 * And `get_source_delta` counts pulls across every readable published summary of the
 * work, so an unordered `limit(1)` could pair "you already hold 9 of these 18" with a
 * list of nine. The Delta describing a different summary than the one underneath it is
 * worse than no Delta: it is a specific, checkable claim that happens to be false.
 * `published_at` gives the pairing something stable to agree on.
 */
export async function fetchSource(workId: string): Promise<SourceDetail | null> {
  const { data: workRows, error: workError } = await supabase
    .from('works')
    .select(WORK_COLUMNS)
    .eq('id', workId)
    .limit(1);
  if (workError) throw rpcError(workError);

  const work = (workRows ?? [])[0] as SourceWork | undefined;
  if (!work) return null;

  const { data: summaryRows, error: summaryError } = await supabase
    .from('summaries')
    .select(
      'id, title, elevator_pitch, why_it_matters, ' +
        'pulls(id, ordinal, headline, body, why_it_matters, explanation, estimated_read_seconds)',
    )
    .eq('work_id', workId)
    .eq('status', 'published')
    .eq('visibility', 'public')
    .order('published_at', { ascending: true })
    .limit(1);
  if (summaryError) throw rpcError(summaryError);

  const summary = (summaryRows ?? [])[0] as
    | {
        title: string | null;
        elevator_pitch: string | null;
        why_it_matters: string | null;
        pulls:
          | {
              id: string;
              ordinal: number;
              headline: string;
              body: string;
              why_it_matters: string | null;
              explanation: string | null;
              estimated_read_seconds: number | null;
            }[]
          | null;
      }
    | undefined;

  return {
    work,
    summaryTitle: summary?.title ?? null,
    elevatorPitch: summary?.elevator_pitch ?? null,
    whyItMatters: summary?.why_it_matters ?? null,
    // Ordinal order, because `insertPulls` assigns it as the reading order and the
    // page is the one place the ideas are meant to be met in sequence rather than
    // ranked. Sorted here rather than in the query: an embedded resource's order is
    // not guaranteed by PostgREST without an explicit order on the embed.
    pulls: [...(summary?.pulls ?? [])]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((p) => ({
        id: p.id,
        ordinal: p.ordinal,
        headline: p.headline,
        body: p.body,
        whyItMatters: p.why_it_matters,
        explanation: p.explanation,
        estimatedReadSeconds: p.estimated_read_seconds,
      })),
  };
}

/**
 * The work a Pull belongs to, so `/pull/:id` can resolve to its source.
 *
 * The deployed `og` Edge Function already redirects browsers to `${APP_ORIGIN}/pull/
 * ${id}`, a path that until now landed on the feed. This is what makes that promise
 * true rather than a redirect into the wrong screen.
 */
export async function fetchWorkIdForPull(pullId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('pulls')
    .select('summaries(work_id)')
    .eq('id', pullId)
    .limit(1);
  if (error) throw rpcError(error);

  const row = (data ?? [])[0] as { summaries: { work_id: string } | null } | undefined;
  return row?.summaries?.work_id ?? null;
}
