import { describe, expect, it } from 'vitest';
import type { SynapseEdge, SynapseNode } from './SynapseMap.js';

describe('SynapseMap data contract', () => {
  const sampleNodes: SynapseNode[] = [
    {
      pullId: 'pull-1',
      workId: 'work-1',
      workTitle: 'Thinking, Fast and Slow',
      workKind: 'book',
      headline: 'System 1 is fast and intuitive; System 2 is slow and deliberate',
      body: 'Cognitive operations divide into autonomous heuristics and controlled reasoning.',
      retrievability: 0.95,
      stability: 14.5,
      status: 'solid',
    },
    {
      pullId: 'pull-2',
      workId: 'work-2',
      workTitle: 'Antifragile',
      workKind: 'book',
      headline: 'Antifragility goes beyond resilience or robustness',
      body: 'The resilient resists shocks and stays the same; the antifragile gets better.',
      retrievability: 0.45,
      stability: 1.2,
      status: 'fading',
    },
    {
      pullId: 'pull-3',
      workId: 'work-3',
      workTitle: 'The Black Swan',
      workKind: 'book',
      headline: 'Extreme impact events are retrospectively rationalized',
      body: 'Humans concoct explanations for severe outliers after they occur.',
      retrievability: 0.72,
      stability: 4.0,
      status: 'refreshing',
    },
  ];

  const sampleEdges: SynapseEdge[] = [
    {
      fromPullId: 'pull-2',
      toPullId: 'pull-3',
      kind: 'elaborates',
      weight: 0.8,
      rationale: 'Antifragility builds upon the vulnerability exposed by Black Swan events.',
    },
    {
      fromPullId: 'pull-1',
      toPullId: 'pull-2',
      kind: 'opposes',
      weight: 0.6,
      rationale: 'Heuristic reliance under stress contrasts with deliberate antifragile design.',
    },
  ];

  it('correctly categorizes nodes by retrievability', () => {
    const solid = sampleNodes.filter((n) => n.retrievability >= 0.8);
    const fading = sampleNodes.filter((n) => n.retrievability < 0.6);
    const refreshing = sampleNodes.filter((n) => n.retrievability >= 0.6 && n.retrievability < 0.8);

    expect(solid.length).toBe(1);
    expect(solid[0]!.pullId).toBe('pull-1');

    expect(fading.length).toBe(1);
    expect(fading[0]!.pullId).toBe('pull-2');

    expect(refreshing.length).toBe(1);
    expect(refreshing[0]!.pullId).toBe('pull-3');
  });

  it('filters edges to match active node subsets', () => {
    const activePullIds = new Set(['pull-2', 'pull-3']);
    const activeEdges = sampleEdges.filter(
      (e) => activePullIds.has(e.fromPullId) && activePullIds.has(e.toPullId),
    );

    expect(activeEdges.length).toBe(1);
    expect(activeEdges[0]!.kind).toBe('elaborates');
  });

  it('identifies dialectical tension edges correctly', () => {
    const debateEdges = sampleEdges.filter((e) => e.kind === 'opposes');
    expect(debateEdges.length).toBe(1);
    expect(debateEdges[0]!.fromPullId).toBe('pull-1');
    expect(debateEdges[0]!.toPullId).toBe('pull-2');
  });
});
