import { SAMPLE_GRAPH } from './graph.js';
import { supabase } from './supabase.js';
import type { GraphEdge, GraphNode, KnowledgeGraphData } from './types.js';

export { SAMPLE_GRAPH };

const CACHE_KEY_PREFIX = 'wap_synapse_graph_';

/**
 * The graph cache lives in `sessionStorage`, not `localStorage`, and a signed-out
 * reader is never served one.
 *
 * A graph node carries a Pull's headline and body — the reader's own reading history,
 * in plain text. In `localStorage` that survived sign-out indefinitely, so the next
 * person to open the browser on a shared machine had it, and it was returned on *any*
 * RPC error, an expired session included: exactly the case where the server has just
 * declined to hand this data over. Tab-scoped storage ends both. Nothing is lost by it
 * either — offline *reading* is IndexedDB (`lib/offline.ts`, law 3), and this is a
 * derived view that one RPC rebuilds.
 */
function cacheKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userId}`;
}

function readCache(userId: string): KnowledgeGraphData | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KnowledgeGraphData;
    return Array.isArray(parsed.nodes) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(userId: string, data: KnowledgeGraphData): void {
  try {
    // Whatever another reader left behind on this device goes now, rather than sitting
    // under its own key until the tab closes.
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(CACHE_KEY_PREFIX) && k !== cacheKey(userId)) sessionStorage.removeItem(k);
    }
    sessionStorage.setItem(cacheKey(userId), JSON.stringify(data));
  } catch {
    // Quota exceeded, or storage denied in a private window. The graph still renders;
    // it just costs an RPC next time.
  }
}

/**
 * Fetch the reader's personal knowledge graph.
 *
 * The returned `source` says what the caller is holding, and it is not decoration: the
 * RPC falls back to the published seed corpus for a reader with no knowledge states, and
 * this falls back again to `SAMPLE_GRAPH` when the RPC cannot be reached. Both look like
 * a populated graph. Anything that turns these nodes into a number shown to a reader —
 * "concepts retained", "connections" — has to refuse to do so unless `source` is
 * `personal`, or it is reporting the corpus back to them as their own progress.
 */
export async function fetchKnowledgeGraph(
  userId: string | null,
  limit = 150,
): Promise<KnowledgeGraphData> {
  try {
    const { data, error } = await supabase.rpc('get_user_knowledge_graph', { p_limit: limit });

    if (error) {
      console.warn('get_user_knowledge_graph RPC error:', error);
      return (userId && readCache(userId)) || SAMPLE_GRAPH;
    }

    const res = data as { nodes?: GraphNode[]; edges?: GraphEdge[]; source?: string } | null;
    if (!res || !Array.isArray(res.nodes) || res.nodes.length === 0) {
      return (userId && readCache(userId)) || SAMPLE_GRAPH;
    }

    const graph: KnowledgeGraphData = {
      nodes: res.nodes,
      edges: res.edges ?? [],
      // Trust the server's word over an assumption. An older deployment that predates
      // the `source` key returns nothing here, and `seed` is the safe reading: it
      // suppresses the personal-progress claims rather than inventing them.
      source: res.source === 'personal' ? 'personal' : 'seed',
    };

    if (userId && graph.source === 'personal') writeCache(userId, graph);
    return graph;
  } catch (err: unknown) {
    console.warn('Network error fetching knowledge graph:', err);
    return (userId && readCache(userId)) || SAMPLE_GRAPH;
  }
}
