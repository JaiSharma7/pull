import { describe, expect, it } from 'vitest';
import { computeGraphStats, SAMPLE_GRAPH } from '../lib/graph.js';

describe('MetacognitiveDashboard stats calculations', () => {
  it('computes retention health over a graph', () => {
    const stats = computeGraphStats(SAMPLE_GRAPH.nodes, SAMPLE_GRAPH.edges);
    expect(stats.totalNodes).toBe(SAMPLE_GRAPH.nodes.length);
    expect(stats.solidCount + stats.refreshingCount + stats.fadingCount).toBe(stats.totalNodes);
    expect(stats.retentionHealth).toBeGreaterThanOrEqual(0);
    expect(stats.retentionHealth).toBeLessThanOrEqual(100);
  });

  /*
   * The dashboard refuses to count anything whose `source` is not `personal`, and this is
   * the half of that contract that lives in the data. `SAMPLE_GRAPH` is the offline
   * fallback: if it were ever to claim `personal`, an offline reader would be shown the
   * constant below as their own retention.
   */
  it('marks the offline fallback as a sample, so the dashboard will not count it', () => {
    expect(SAMPLE_GRAPH.source).toBe('sample');
  });

  /*
   * `docs/design.md`: an illustrative Pull is a real seeded one from a public-domain work.
   * The first version of this constant attributed invented prose to five in-copyright
   * bestsellers, which is the exact mistake that rule was written after.
   */
  it('illustrates only with public-domain works', () => {
    const permitted = new Set([
      'The Enchiridion',
      'Meditations',
      'On Liberty',
      'Walden',
      'On the Origin of Species',
      'Relativity: The Special and General Theory',
    ]);
    for (const node of SAMPLE_GRAPH.nodes) {
      expect(permitted.has(node.workTitle), `${node.workTitle} is not in the seeded corpus`).toBe(
        true,
      );
    }
  });
});
