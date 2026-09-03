import { describe, expect, it } from 'vitest';
import { computeGraphStats } from '../lib/graph.js';
import { SAMPLE_GRAPH } from '../lib/graph.js';

describe('MetacognitiveDashboard stats calculations', () => {
  it('computes accurate retention health from sample data', () => {
    const stats = computeGraphStats(SAMPLE_GRAPH.nodes, SAMPLE_GRAPH.edges);
    expect(stats.totalNodes).toBe(6);
    expect(stats.solidCount).toBeGreaterThanOrEqual(4);
    expect(stats.fadingCount).toBeGreaterThanOrEqual(2);
    expect(stats.retentionHealth).toBeGreaterThanOrEqual(50);
  });
});
