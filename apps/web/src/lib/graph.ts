import type { GraphEdge, GraphNode, GraphSource, KnowledgeGraphData } from './types.js';

/**
 * The graph shown when the RPC cannot be reached at all.
 *
 * Every node is a real seeded Pull from a public-domain work, and every edge a real
 * row from `20260829131109_seed_relations_and_daily.sql`. That is not incidental:
 * `docs/design.md` requires an illustrative card to be a real seeded Pull from a
 * public-domain work, and says so because this repository has already once reached for
 * an in-copyright bestseller the moment it wanted a plausible example. The version of
 * this constant that shipped in the branch did it again — invented one-line paraphrases
 * attributed to *Thinking, Fast and Slow*, *Antifragile*, *The Black Swan* and *The
 * Structure of Scientific Revolutions*, plus a line attributed to *Man's Search for
 * Meaning* that is not in that book.
 *
 * The retrievability values are illustrative rather than measured, which is exactly why
 * `KnowledgeGraphData.source` marks this graph `sample`: a caller that reports counts to
 * a reader must refuse to treat these as their own.
 */
export const SAMPLE_GRAPH: KnowledgeGraphData = {
  source: 'sample',
  nodes: [
    {
      pullId: 'sample-enchiridion-1',
      workId: 'sample-work-enchiridion',
      workTitle: 'The Enchiridion',
      workKind: 'book',
      headline: 'Some things are up to you. Most are not.',
      body: 'Your judgements, intentions and effort are yours. Reputation, outcomes, other people and the past are not.',
      stability: 24.0,
      difficulty: 0.2,
      retrievability: 0.96,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      status: 'solid',
    },
    {
      pullId: 'sample-enchiridion-2',
      workId: 'sample-work-enchiridion',
      workTitle: 'The Enchiridion',
      workKind: 'book',
      headline: 'You are disturbed by your judgement, not by the event.',
      body: 'Events arrive without commentary. The distress comes from the verdict you attach to them, which is why two people meet the same news very differently.',
      stability: 18.0,
      difficulty: 0.3,
      retrievability: 0.91,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      status: 'solid',
    },
    {
      pullId: 'sample-meditations-2',
      workId: 'sample-work-meditations',
      workTitle: 'Meditations',
      workKind: 'book',
      headline: 'It is your opinion of the thing that wounds you, and you can revoke it.',
      body: 'The pain is attached to the verdict rather than the event, and the verdict is something you issued and can withdraw.',
      stability: 12.0,
      difficulty: 0.35,
      retrievability: 0.84,
      lastSeenAt: '2026-08-31T00:00:00.000Z',
      status: 'solid',
    },
    {
      pullId: 'sample-on-liberty-1',
      workId: 'sample-work-on-liberty',
      workTitle: 'On Liberty',
      workKind: 'book',
      headline: 'Silencing an opinion robs the people doing the silencing.',
      body: 'If the opinion is right, they lose a correction. If it is wrong, they lose the sharper understanding that comes from defeating it.',
      stability: 6.0,
      difficulty: 0.45,
      retrievability: 0.68,
      lastSeenAt: '2026-08-29T00:00:00.000Z',
      status: 'refreshing',
    },
    {
      pullId: 'sample-walden-3',
      workId: 'sample-work-walden',
      workTitle: 'Walden',
      workKind: 'book',
      headline: 'Living deliberately is mostly deciding what to attend to.',
      body: 'The point of the experiment was not the cabin. It was removing enough noise to find out which parts of a life were actually chosen.',
      stability: 3.2,
      difficulty: 0.5,
      retrievability: 0.55,
      lastSeenAt: '2026-08-26T00:00:00.000Z',
      status: 'fading',
    },
    {
      pullId: 'sample-walden-1',
      workId: 'sample-work-walden',
      workTitle: 'Walden',
      workKind: 'book',
      headline: 'The cost of a thing is the amount of life you exchange for it.',
      body: 'Not the price. The hours required to earn the price, plus the hours spent maintaining, storing and worrying about what you bought.',
      stability: 9.0,
      difficulty: 0.35,
      retrievability: 0.79,
      lastSeenAt: '2026-08-30T00:00:00.000Z',
      status: 'refreshing',
    },
    {
      pullId: 'sample-origin-2',
      workId: 'sample-work-origin',
      workTitle: 'On the Origin of Species',
      workKind: 'book',
      headline: 'Very small advantages, compounded over deep time, do very large work.',
      body: 'A trait that helps fractionally, in each generation, across an interval of time the mind is not built to picture, produces results that look designed.',
      stability: 2.1,
      difficulty: 0.6,
      retrievability: 0.47,
      lastSeenAt: '2026-08-25T00:00:00.000Z',
      status: 'fading',
    },
  ],
  edges: [
    {
      fromPullId: 'sample-enchiridion-2',
      toPullId: 'sample-meditations-2',
      kind: 'descendant',
      weight: 0.9,
      rationale:
        'Marcus was a reader of Epictetus; this is the same claim, restated by a later Stoic.',
    },
    {
      fromPullId: 'sample-meditations-2',
      toPullId: 'sample-enchiridion-2',
      kind: 'ancestor',
      weight: 0.9,
      rationale: "Traces back to the Enchiridion's distinction between event and judgement.",
    },
    {
      fromPullId: 'sample-on-liberty-1',
      toPullId: 'sample-walden-3',
      kind: 'opposes',
      weight: 0.75,
      rationale:
        'Mill argues for engaging with opinions you reject; Thoreau argues that attention is scarce and must be spent selectively. Both cannot be maximised.',
    },
    {
      fromPullId: 'sample-origin-2',
      toPullId: 'sample-walden-1',
      kind: 'related',
      weight: 0.6,
      rationale:
        'Both turn on the same failure of intuition about small quantities accumulating over long intervals.',
    },
  ],
};

export interface GraphStats {
  totalNodes: number;
  solidCount: number;
  refreshingCount: number;
  fadingCount: number;
  retentionHealth: number; // percentage of nodes >= 0.6
  opposesCount: number;
  ancestorCount: number;
  elaboratesCount: number;
}

/**
 * Filter graph nodes by retrievability status.
 */
export function filterGraphNodes(
  nodes: GraphNode[],
  filter: 'all' | 'solid' | 'fading',
): GraphNode[] {
  if (filter === 'solid') return nodes.filter((n) => n.retrievability >= 0.8);
  if (filter === 'fading') return nodes.filter((n) => n.retrievability < 0.6);
  return nodes;
}

/**
 * Filter edges so that only edges with both ends present in active node set survive.
 */
export function filterConnectedEdges(edges: GraphEdge[], activeNodeIds: Set<string>): GraphEdge[] {
  return edges.filter((e) => activeNodeIds.has(e.fromPullId) && activeNodeIds.has(e.toPullId));
}

/**
 * Compute aggregate statistics for the user's knowledge graph.
 */
export function computeGraphStats(nodes: GraphNode[], edges: GraphEdge[]): GraphStats {
  const totalNodes = nodes.length;
  if (totalNodes === 0) {
    return {
      totalNodes: 0,
      solidCount: 0,
      refreshingCount: 0,
      fadingCount: 0,
      retentionHealth: 100,
      opposesCount: 0,
      ancestorCount: 0,
      elaboratesCount: 0,
    };
  }

  let solidCount = 0;
  let refreshingCount = 0;
  let fadingCount = 0;

  for (const n of nodes) {
    if (n.retrievability >= 0.8) solidCount++;
    else if (n.retrievability >= 0.6) refreshingCount++;
    else fadingCount++;
  }

  let opposesCount = 0;
  let ancestorCount = 0;
  let elaboratesCount = 0;

  for (const e of edges) {
    if (e.kind === 'opposes') opposesCount++;
    else if (e.kind === 'ancestor' || e.kind === 'descendant') ancestorCount++;
    else if (e.kind === 'elaborates') elaboratesCount++;
  }

  const retentionHealth = Math.round(((solidCount + refreshingCount) / totalNodes) * 100);

  return {
    totalNodes,
    solidCount,
    refreshingCount,
    fadingCount,
    retentionHealth,
    opposesCount,
    ancestorCount,
    elaboratesCount,
  };
}

/**
 * Human-readable retrievability description.
 */
export function formatRetrievabilityLabel(retrievability: number): string {
  const pct = Math.round(retrievability * 100);
  if (retrievability >= 0.8) return `${pct}% · Solid`;
  if (retrievability >= 0.6) return `${pct}% · Refreshing`;
  return `${pct}% · Fading`;
}

/**
 * Narrow what `get_user_knowledge_graph` returned, or say it gave us nothing usable.
 *
 * Pure and here rather than in `graph-api.ts` so it can be tested: that module imports
 * the Supabase client, which throws at import time without the environment.
 *
 * `source` is the load-bearing field. It decides whether a caller may describe these
 * nodes as the reader's own, and the default when the server does not send one is
 * `seed` — an older deployment predating the key returns a perfectly good graph with no
 * claim attached, and the safe reading of a missing claim is the one that suppresses
 * personal-progress numbers rather than inventing them.
 */
export function narrowGraph(data: unknown): KnowledgeGraphData | null {
  if (typeof data !== 'object' || data === null) return null;
  const res = data as { nodes?: unknown; edges?: unknown; source?: unknown };
  if (!Array.isArray(res.nodes) || res.nodes.length === 0) return null;
  const source: GraphSource = res.source === 'personal' ? 'personal' : 'seed';
  return {
    nodes: res.nodes as GraphNode[],
    edges: Array.isArray(res.edges) ? (res.edges as GraphEdge[]) : [],
    source,
  };
}

/**
 * Whether a cached graph may be handed to this caller.
 *
 * A signed-out reader gets `null` here and therefore never sees a cache. That is the
 * rule the previous implementation broke: it keyed the cache by `userId ?? 'guest'` and
 * returned it on any RPC failure, so a session that had just expired — the one case
 * where the server has explicitly declined to hand this data over — was answered out of
 * local storage with the previous reader\'s headlines and bodies.
 */
export function mayServeCache(userId: string | null): userId is string {
  return typeof userId === 'string' && userId.length > 0;
}
