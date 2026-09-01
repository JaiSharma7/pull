import { rpcError } from './rpc-error.js';
import { type SearchResult, shapeSearchResult } from './search.js';
import { supabase } from './supabase.js';

/**
 * The two reads search needs, and neither of them calls a model.
 *
 * `search_catalogue` is full-text ranking plus one pgvector average over
 * embeddings that were written at generation time; `related_pulls` reads a
 * column. The reader's query is never embedded, which is what keeps law 2 —
 * and the README's claim that search is "SQL and vector maths" — true rather
 * than aspirational. `/costcheck` audits this file along with `api.ts`.
 */

export interface SearchOptions {
  /** How many ideas to render. The RPC still counts every match, so the header can say how many were left. */
  limitIdeas?: number;
  limitSources?: number;
  signal?: AbortSignal;
}

export async function searchCatalogue(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const request = supabase.rpc('search_catalogue', {
    p_query: query,
    p_limit_ideas: options.limitIdeas ?? 12,
    p_limit_sources: options.limitSources ?? 8,
  });

  // `abortSignal` is on the builder rather than the options object. Without it a
  // reader who searches twice quickly can have the slower first response resolve
  // last and overwrite the second — the same stale-response race the feed guards
  // with a cancelled flag, except here the two requests are indistinguishable
  // once they land, because both are just "a search result".
  const { data, error } = await (options.signal ? request.abortSignal(options.signal) : request);
  if (error) throw rpcError(error);

  // Shaped rather than cast. supabase-js types a jsonb return as `Json`, so a
  // cast would assert a shape nobody checked; `shapeSearchResult` narrows it and
  // drops what it does not recognise.
  return shapeSearchResult(data);
}

export interface RelatedPull {
  id: string;
  summaryId: string;
  workId: string;
  headline: string;
  workTitle: string;
  /**
   * The authored edge kind, or null when the vectors found it rather than a person.
   *
   * Worth keeping apart on screen: "argues against this" is a claim somebody made
   * and can be held to, while "close to this" is a measurement. Presenting the
   * second as the first is how a Counterpull surface starts lying.
   */
  relation: string | null;
  rationale: string | null;
}

export async function fetchRelatedPulls(pullId: string, limit = 6): Promise<RelatedPull[]> {
  const { data, error } = await supabase.rpc('related_pulls', {
    p_pull_id: pullId,
    p_limit: limit,
  });
  if (error) throw rpcError(error);

  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((row): RelatedPull | null => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
      const r = row as Record<string, unknown>;
      const id = typeof r.id === 'string' ? r.id : '';
      if (!id) return null;
      return {
        id,
        summaryId: typeof r.summaryId === 'string' ? r.summaryId : '',
        workId: typeof r.workId === 'string' ? r.workId : '',
        headline: typeof r.headline === 'string' ? r.headline : '',
        workTitle: typeof r.workTitle === 'string' ? r.workTitle : '',
        relation: typeof r.relation === 'string' ? r.relation : null,
        rationale: typeof r.rationale === 'string' ? r.rationale : null,
      };
    })
    .filter((r): r is RelatedPull => r !== null);
}
