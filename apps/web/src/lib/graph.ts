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
 * One edge per pair of ideas, rather than one per stored row.
 *
 * `pull_relations` stores both directions of a relationship — the Epictetus/Marcus lineage
 * is inserted as `descendant` and again as `ancestor`, the Mill/Thoreau tension as
 * `opposes` twice (`20260829131109_seed_relations_and_daily.sql`). Counting rows therefore
 * reported one debate as "2 dialectical tensions" and one lineage link as two connections,
 * under a header promising counts taken from the reader's own history. It also made the canvas stroke the
 * same segment twice, so those edges rendered darker than the alpha intends.
 *
 * (The header no longer says "nothing is estimated" — it never was true of
 * retrievability, which is read off a decay curve. What it says now is that the
 * COUNTS come from the reader's own history, which is the promise this function
 * exists to keep.)
 */
export function undirectedEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const e of edges) {
    const key = [e.fromPullId, e.toPullId].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Compute aggregate statistics for the user's knowledge graph.
 */
export function computeGraphStats(nodes: GraphNode[], edges: GraphEdge[]): GraphStats {
  const totalNodes = nodes.length;
  // Pairs, not rows — see `undirectedEdges`.
  const links = undirectedEdges(edges);
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

  for (const e of links) {
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

  /*
   * The node shape is checked, not asserted.
   *
   * `source` decides whether these numbers may be called the reader's; `retrievability`
   * decides what the numbers are. A cast let a drifted payload through silently and
   * wrongly rather than loudly: a node missing `retrievability` makes every threshold
   * comparison in `computeGraphStats` false, so it counts as fading, "Retention Health"
   * prints `0%` as a measured figure, and `formatRetrievabilityLabel` renders
   * `NaN% · Fading`. On the screens whose whole point is not showing unmeasured numbers,
   * a wrong number is the one failure mode worth spending a type guard on.
   */
  const nodes = res.nodes.filter(isGraphNode);
  if (nodes.length === 0) return null;

  const source: GraphSource = res.source === 'personal' ? 'personal' : 'seed';
  // Only edges whose both ends survived. A dangling edge would be counted by
  // `computeGraphStats` as a connection to an idea that is not in the graph, and drawn
  // to a node the simulation does not have.
  const present = new Set(nodes.map((n) => n.pullId));
  const edges = Array.isArray(res.edges)
    ? res.edges
        .filter(isGraphEdge)
        .filter((e) => present.has(e.fromPullId) && present.has(e.toPullId))
    : [];
  return { nodes, edges, source };
}

function isGraphNode(n: unknown): n is GraphNode {
  if (typeof n !== 'object' || n === null) return false;
  const c = n as Record<string, unknown>;
  return (
    typeof c.pullId === 'string' &&
    typeof c.workId === 'string' &&
    // The renderer dereferences these without checking — `data.headline.length` inside the
    // rAF callback, where a TypeError is an uncaught async error that stops the frame and
    // leaves a half-drawn canvas.
    typeof c.workTitle === 'string' &&
    typeof c.headline === 'string' &&
    typeof c.body === 'string' &&
    typeof c.retrievability === 'number' &&
    Number.isFinite(c.retrievability) &&
    typeof c.stability === 'number' &&
    Number.isFinite(c.stability)
  );
}

/**
 * An edge, checked on the field whose absence is fatal rather than merely wrong.
 *
 * `weight` is not decoration: `SynapseMap` computes a spring length of
 * `70 + (1 - weight) * 50`, so a missing weight is `NaN`, and one `NaN` length puts both
 * endpoints' velocities to `NaN` in the spring pass — which the O(n²) repulsion pass then
 * spreads to every node in the graph within a frame or two. The whole map disappears,
 * permanently, with no error. The node guard gained a finiteness check because drift
 * there produced a wrong number; drift here produces a blank screen, so it gets one too.
 */
function isGraphEdge(e: unknown): e is GraphEdge {
  if (typeof e !== 'object' || e === null) return false;
  const c = e as Record<string, unknown>;
  return (
    typeof c.fromPullId === 'string' &&
    typeof c.toPullId === 'string' &&
    typeof c.weight === 'number' &&
    Number.isFinite(c.weight) &&
    typeof c.kind === 'string'
  );
}

/**
 * Whether there is a signed-in reader who could have a personal graph at all.
 *
 * Named `mayServeCache` until the cache it guarded was removed, which left the name
 * describing something that no longer exists — the next reader of
 * `if (!hasReader(userId))` would have gone looking for one.
 */
export function hasReader(userId: string | null): userId is string {
  return typeof userId === 'string' && userId.length > 0;
}

/**
 * The reader's own graph, or null.
 *
 * Every screen that turns graph nodes into a number shown to a reader has to make this
 * check, and the point of putting it here is that they cannot make it differently.
 * `MetacognitiveDashboard` made it inline and `Graph` — the destination whose heading is
 * "Your Mental Landscape" — did not make it at all, so a reader who had read nothing was
 * shown the published seed corpus as "21 ideas connected, 100% retention".
 */
export function personalGraph(graph: KnowledgeGraphData | null): KnowledgeGraphData | null {
  return graph?.source === 'personal' ? graph : null;
}

/**
 * Why there is nothing of the reader's to show, when there is nothing.
 *
 * The two cases must not be told the same way, and telling them apart is the whole reason
 * `sample` and `seed` are separate values. `seed` means the reader genuinely has no
 * knowledge states yet. `sample` means the RPC could not be reached, so we know nothing
 * about their history — and saying "nothing measured yet, go and read something" to a
 * reader with two years of it, because their train went into a tunnel, is worse than
 * saying nothing.
 */
export function graphAbsence(
  graph: KnowledgeGraphData | null,
): 'unreachable' | 'nothing-yet' | null {
  if (graph === null || graph.source === 'personal') return null;
  return graph.source === 'sample' ? 'unreachable' : 'nothing-yet';
}
