import { SAMPLE_GRAPH } from './graph.js';
import { supabase } from './supabase.js';
import type { GraphEdge, GraphNode, KnowledgeGraphData } from './types.js';

export { SAMPLE_GRAPH };

const CACHE_KEY_PREFIX = 'wap_synapse_graph_';

function getLocalCache(key: string): KnowledgeGraphData | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as KnowledgeGraphData;
  } catch {
    return null;
  }
}

function setLocalCache(key: string, data: KnowledgeGraphData): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // quota exceeded or private browsing
  }
}

/**
 * Fetch the user's personal knowledge graph from Postgres RPC,
 * falling back to local storage and sample data when offline.
 */
export async function fetchKnowledgeGraph(
  userId: string | null,
  limit = 150,
): Promise<KnowledgeGraphData> {
  const cacheKey = `${CACHE_KEY_PREFIX}${userId ?? 'guest'}`;

  try {
    const { data, error } = await (
      supabase.rpc as unknown as (
        fn: string,
        args?: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>
    )('get_user_knowledge_graph', {
      p_user_id: userId ?? undefined,
      p_limit: limit,
    });

    if (error) {
      console.warn('get_user_knowledge_graph RPC error:', error);
      const cached = getLocalCache(cacheKey);
      if (cached && cached.nodes.length > 0) return cached;
      return SAMPLE_GRAPH;
    }

    const res = data as unknown as { nodes: GraphNode[]; edges: GraphEdge[] };
    if (!res || !Array.isArray(res.nodes) || res.nodes.length === 0) {
      const cached = getLocalCache(cacheKey);
      return cached && cached.nodes.length > 0 ? cached : SAMPLE_GRAPH;
    }

    const cleanData: KnowledgeGraphData = {
      nodes: res.nodes,
      edges: res.edges ?? [],
    };

    setLocalCache(cacheKey, cleanData);
    return cleanData;
  } catch (err: unknown) {
    console.warn('Network error fetching knowledge graph:', err);
    const cached = getLocalCache(cacheKey);
    return cached && cached.nodes.length > 0 ? cached : SAMPLE_GRAPH;
  }
}
