import type { GraphEdge, GraphNode, KnowledgeGraphData } from './types.js';

/**
 * Fallback seed graph for guests, cold-start, or offline states when no local
 * cache exists.
 */
export const SAMPLE_GRAPH: KnowledgeGraphData = {
  nodes: [
    {
      pullId: 'sample-1',
      workId: 'work-1',
      workTitle: 'Thinking, Fast and Slow',
      workKind: 'book',
      headline: 'System 1 is fast and heuristic; System 2 is slow and deliberate',
      body: 'Most judgment operates automatically. Deliberate effort is invoked only when surprise or complexity demands it.',
      stability: 18.0,
      difficulty: 0.3,
      retrievability: 0.94,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      status: 'solid',
    },
    {
      pullId: 'sample-2',
      workId: 'work-2',
      workTitle: 'Antifragile',
      workKind: 'book',
      headline: 'Antifragility gains from disorder, volatility, and stressors',
      body: 'Some things benefit from shocks; they thrive and grow when exposed to volatility, randomness, and stressors.',
      stability: 8.5,
      difficulty: 0.4,
      retrievability: 0.88,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      status: 'solid',
    },
    {
      pullId: 'sample-3',
      workId: 'work-3',
      workTitle: 'The Black Swan',
      workKind: 'book',
      headline: 'Outlier events dominate history yet are retrospectively rationalized',
      body: 'A Black Swan is an event with extreme impact, incomprehensible predictability, and retrospective explanation.',
      stability: 3.2,
      difficulty: 0.5,
      retrievability: 0.58,
      lastSeenAt: '2026-08-28T00:00:00.000Z',
      status: 'fading',
    },
    {
      pullId: 'sample-4',
      workId: 'work-4',
      workTitle: 'Meditations',
      workKind: 'book',
      headline: 'You have power over your mind, not outside events',
      body: 'Realize this, and you will find strength. The obstacle to action advances action; what stands in the way becomes the way.',
      stability: 24.0,
      difficulty: 0.2,
      retrievability: 0.96,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      status: 'solid',
    },
    {
      pullId: 'sample-5',
      workId: 'work-5',
      workTitle: 'The Structure of Scientific Revolutions',
      workKind: 'book',
      headline: 'Science progresses by paradigm shifts, not steady accumulation',
      body: 'Normal science operates within a paradigm until accumulating anomalies trigger a crisis and fundamental shift.',
      stability: 2.1,
      difficulty: 0.6,
      retrievability: 0.48,
      lastSeenAt: '2026-08-26T00:00:00.000Z',
      status: 'fading',
    },
    {
      pullId: 'sample-6',
      workId: 'work-6',
      workTitle: 'Man’s Search for Meaning',
      workKind: 'book',
      headline: 'Between stimulus and response there is a space: our choice',
      body: 'In that space is our power to choose our response. In our response lies our growth and our freedom.',
      stability: 12.0,
      difficulty: 0.35,
      retrievability: 0.85,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      status: 'solid',
    },
  ],
  edges: [
    {
      fromPullId: 'sample-2',
      toPullId: 'sample-3',
      kind: 'elaborates',
      weight: 0.85,
      rationale: 'Antifragility provides the operational antidote to Black Swan vulnerabilities.',
    },
    {
      fromPullId: 'sample-1',
      toPullId: 'sample-3',
      kind: 'opposes',
      weight: 0.7,
      rationale:
        'Heuristic pattern-matching falsely assures us of predictability in tail-risk regimes.',
    },
    {
      fromPullId: 'sample-4',
      toPullId: 'sample-6',
      kind: 'ancestor',
      weight: 0.9,
      rationale:
        'Stoic dichotomy of control directly informs logotherapy and existential psychology.',
    },
    {
      fromPullId: 'sample-2',
      toPullId: 'sample-4',
      kind: 'related',
      weight: 0.65,
      rationale: 'Voluntary exposure to hardship builds psychological and systemic antifragility.',
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
