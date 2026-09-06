import { GRAPH_LIMIT, hasReader, narrowGraph, SAMPLE_GRAPH } from './graph.js';
import { supabase } from './supabase.js';
import type { KnowledgeGraphData } from './types.js';

export { GRAPH_LIMIT, SAMPLE_GRAPH };

/**
 * Fetch the reader's personal knowledge graph.
 *
 * The returned `source` says what the caller is holding, and it is not decoration: the
 * RPC falls back to the published seed corpus for a reader with no knowledge states, and
 * this falls back again to `SAMPLE_GRAPH` when the RPC cannot be reached. Both look like
 * a populated graph. Anything that turns these nodes into a number shown to a reader —
 * "concepts retained", "connections" — has to refuse unless `source` is `personal`, which
 * is what `personalGraph` and `graphAbsence` in `./graph.js` are for.
 *
 * **There is deliberately no local cache**, and the reasoning is worth writing down
 * because two attempts at one got it wrong. The first kept the graph in `localStorage`
 * keyed by `userId ?? 'guest'` and served it on any RPC error, so a reader's headlines
 * and bodies survived sign-out on a shared machine and were handed back at exactly the
 * moment the server refused to hand them over. Moving it to `sessionStorage` ended the
 * first half and not the second: `userId` being non-null is not evidence of a live token,
 * so a revoked session was still served from it.
 *
 * Removing it ends both, and costs less than it appears to. A cached graph is stamped
 * `personal`, so every honesty check downstream waves it through — but `retrievability`
 * decays with wall-clock time, so a cached graph's numbers are not merely stale, they are
 * wrong by construction, on the screens whose entire purpose is to show nothing they have
 * not measured. Offline *reading* is IndexedDB (`lib/offline.ts`, law 3) and is untouched.
 * A graph is a derived view one RPC rebuilds; until that RPC answers, the honest thing to
 * show is that we do not know, which `graphAbsence` reports as `unreachable`.
 */

export async function fetchKnowledgeGraph(
  userId: string | null,
  limit = GRAPH_LIMIT,
): Promise<KnowledgeGraphData> {
  // Still asked, and still meaning what it meant: whether there is a reader who could
  // have a personal graph at all. It no longer gates a cache, because there is none.
  if (!hasReader(userId)) return SAMPLE_GRAPH;

  try {
    const { data, error } = await supabase.rpc('get_user_knowledge_graph', { p_limit: limit });

    if (error) {
      console.warn('get_user_knowledge_graph RPC error:', error);
      return SAMPLE_GRAPH;
    }

    return narrowGraph(data) ?? SAMPLE_GRAPH;
  } catch (err: unknown) {
    console.warn('Network error fetching knowledge graph:', err);
    return SAMPLE_GRAPH;
  }
}
