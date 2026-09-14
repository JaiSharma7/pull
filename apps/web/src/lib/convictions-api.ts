import { chainStances, isStance, type Belief, type ConvictionRow } from './convictions.js';
import { pageAfter } from './paging.js';
import { fetchRelatedPulls, type RelatedPull } from './search-api.js';
import { supabase } from './supabase.js';

export {
  BELIEF_COPY,
  BELIEF_COPY_EMPTY,
  changeLine,
  chainStances,
  mindsChanged,
} from './convictions.js';
export type { Belief, ConvictionRow, Stance } from './convictions.js';

/**
 * Every stance this reader has recorded, folded into one belief per idea.
 *
 * WALKED RATHER THAN LIMITED, for the reason `fetchConfidentlyWrong` walks: the
 * point of the section is the CHAIN — what somebody used to think — and a page of
 * a hundred rows cut at the server would drop the older half of exactly the
 * chains worth reading. A reader's whole conviction history is small: one row per
 * Counterpull they have answered, plus one per change of mind.
 *
 * Keyed on `id` rather than offset, again for `fetchConfidentlyWrong`'s reason: an
 * offset shifts under a concurrent write, and this reader's other tab writes a
 * conviction every time they answer a Counterpull.
 *
 * The idea rides on the row as an embed, and a row whose pull is no longer
 * readable is dropped rather than rendered as a headline-less stance. A belief
 * about an idea the reader cannot open is not something they can do anything
 * with, and the alternative — "You agreed · (unavailable)" — is worse than its
 * absence.
 */
export async function fetchBeliefs(userId: string | null): Promise<Belief[]> {
  if (!userId) return [];

  const rows = await pageAfter<EmbeddedConviction>((after, limit) => {
    let q = supabase
      .from('convictions')
      .select('id, pull_id, stance, created_at, pulls(headline, summaries(work_id, works(title)))')
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .limit(limit);
    if (after !== null) q = q.gt('id', after);
    return q;
  }, 'id');

  return chainStances(rows.map(shape).filter((r): r is ConvictionRow => r !== null));
}

/**
 * The shape PostgREST returns for the select above.
 *
 * Declared rather than inferred so `shape` below has something to narrow against;
 * supabase-js types an embed as a union of a row and an error, and a cast would
 * assert a shape nobody checked.
 */
interface EmbeddedConviction {
  id: string;
  pull_id: string;
  stance: string;
  created_at: string;
  pulls: {
    headline: string | null;
    summaries: { work_id: string | null; works: { title: string | null } | null } | null;
  } | null;
}

function shape(row: EmbeddedConviction): ConvictionRow | null {
  const headline = row.pulls?.headline ?? null;
  const workId = row.pulls?.summaries?.work_id ?? null;
  if (!isStance(row.stance) || headline === null || workId === null) return null;
  return {
    id: row.id,
    pullId: row.pull_id,
    stance: row.stance,
    createdAt: row.created_at,
    headline,
    workId,
    workTitle: row.pulls?.summaries?.works?.title ?? 'a source',
  };
}

/**
 * The strongest recorded case against an idea, or null when nobody has written
 * one down.
 *
 * `related_pulls` returns authored edges and vector neighbours together, and only
 * the authored `opposes` edge is admissible here. The distinction is the one
 * `RelatedPull.relation` exists to keep: "argues against this" is a claim somebody
 * made and can be held to, while "close to this" is a measurement, and presenting
 * the second as the first is how a Counterpull surface starts lying.
 *
 * FETCHED WHEN THE READER ASKS, not with the list. One RPC per belief on mount
 * would be twenty round trips to render a screen, on the one page whose whole
 * subject is the reader's own record rather than the catalogue's — and a case
 * against something is read one at a time, if at all.
 */
export async function fetchCaseAgainst(pullId: string): Promise<RelatedPull | null> {
  const related = await fetchRelatedPulls(pullId);
  return related.find((r) => r.relation === 'opposes') ?? null;
}

export type { RelatedPull } from './search-api.js';
