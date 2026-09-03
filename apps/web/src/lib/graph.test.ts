import { describe, expect, it } from 'vitest';
import {
  computeGraphStats,
  filterConnectedEdges,
  filterGraphNodes,
  formatRetrievabilityLabel,
  mayServeCache,
  narrowGraph,
} from './graph.js';
import type { GraphEdge, GraphNode } from './types.js';

describe('graph pure functions', () => {
  const nodes: GraphNode[] = [
    {
      pullId: '1',
      workId: 'w1',
      workTitle: 'Work 1',
      workKind: 'book',
      headline: 'Idea 1',
      body: 'Body 1',
      stability: 10,
      difficulty: 0.3,
      retrievability: 0.92,
      lastSeenAt: '2026-09-01T00:00:00Z',
      status: 'solid',
    },
    {
      pullId: '2',
      workId: 'w2',
      workTitle: 'Work 2',
      workKind: 'book',
      headline: 'Idea 2',
      body: 'Body 2',
      stability: 4,
      difficulty: 0.4,
      retrievability: 0.71,
      lastSeenAt: '2026-09-01T00:00:00Z',
      status: 'refreshing',
    },
    {
      pullId: '3',
      workId: 'w3',
      workTitle: 'Work 3',
      workKind: 'book',
      headline: 'Idea 3',
      body: 'Body 3',
      stability: 1,
      difficulty: 0.6,
      retrievability: 0.45,
      lastSeenAt: '2026-08-20T00:00:00Z',
      status: 'fading',
    },
  ];

  const edges: GraphEdge[] = [
    { fromPullId: '1', toPullId: '2', kind: 'opposes', weight: 0.8, rationale: null },
    { fromPullId: '2', toPullId: '3', kind: 'ancestor', weight: 0.7, rationale: null },
    { fromPullId: '1', toPullId: '4', kind: 'elaborates', weight: 0.5, rationale: null },
  ];

  it('filters nodes by retrievability', () => {
    expect(filterGraphNodes(nodes, 'all').length).toBe(3);
    expect(filterGraphNodes(nodes, 'solid').map((n) => n.pullId)).toEqual(['1']);
    expect(filterGraphNodes(nodes, 'fading').map((n) => n.pullId)).toEqual(['3']);
  });

  it('filters connected edges and prunes missing nodes', () => {
    const active = new Set(['1', '2']);
    const filtered = filterConnectedEdges(edges, active);
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.kind).toBe('opposes');
  });

  it('computes accurate graph metrics', () => {
    const stats = computeGraphStats(nodes, edges);
    expect(stats.totalNodes).toBe(3);
    expect(stats.solidCount).toBe(1);
    expect(stats.refreshingCount).toBe(1);
    expect(stats.fadingCount).toBe(1);
    expect(stats.retentionHealth).toBe(67); // (1+1)/3 = 66.7% -> 67%
    expect(stats.opposesCount).toBe(1);
    expect(stats.ancestorCount).toBe(1);
    expect(stats.elaboratesCount).toBe(1);
  });

  it('formats retrievability human labels correctly', () => {
    expect(formatRetrievabilityLabel(0.92)).toBe('92% · Solid');
    expect(formatRetrievabilityLabel(0.71)).toBe('71% · Refreshing');
    expect(formatRetrievabilityLabel(0.45)).toBe('45% · Fading');
  });
});

describe('narrowGraph', () => {
  const node = {
    pullId: 'p1',
    workId: 'w1',
    workTitle: 'Meditations',
    workKind: 'book',
    headline: 'h',
    body: 'b',
    stability: 1,
    difficulty: 0.3,
    retrievability: 0.9,
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    status: 'solid' as const,
  };

  it('keeps a personal graph marked personal', () => {
    const g = narrowGraph({ nodes: [node], edges: [], source: 'personal' });
    expect(g?.source).toBe('personal');
  });

  /*
   * The important direction. A caller that treats an unmarked graph as personal reports
   * the published corpus back to a brand-new reader as their own retention, which is the
   * defect this field exists to close — so anything that is not explicitly `personal`
   * reads as `seed`, including a deployment too old to send the key at all.
   */
  it('treats an unmarked or unrecognised graph as seed, never as personal', () => {
    expect(narrowGraph({ nodes: [node], edges: [] })?.source).toBe('seed');
    expect(narrowGraph({ nodes: [node], edges: [], source: 'seed' })?.source).toBe('seed');
    expect(narrowGraph({ nodes: [node], edges: [], source: 'whatever' })?.source).toBe('seed');
  });

  it('rejects a payload with no nodes rather than returning an empty graph', () => {
    expect(narrowGraph({ nodes: [], edges: [], source: 'personal' })).toBeNull();
    expect(narrowGraph(null)).toBeNull();
    expect(narrowGraph({ source: 'personal' })).toBeNull();
  });

  it('defaults missing edges to none', () => {
    expect(narrowGraph({ nodes: [node], source: 'personal' })?.edges).toEqual([]);
  });
});

describe('mayServeCache', () => {
  /*
   * A graph node carries the reader's headlines and bodies. The cache was keyed by
   * `userId ?? 'guest'` and returned on any RPC error — including an expired session,
   * which is precisely when the server has declined to hand that data over.
   */
  it('never serves a cached graph to a signed-out reader', () => {
    expect(mayServeCache(null)).toBe(false);
    expect(mayServeCache('')).toBe(false);
  });

  it('serves one to a signed-in reader', () => {
    expect(mayServeCache('user-1')).toBe(true);
  });
});
