import { describe, expect, it } from 'vitest';
import { computeGraphStats, SAMPLE_GRAPH } from '../lib/graph.js';
import { PROGRESS_COPY } from '../lib/progress.js';

/*
 * The screen's own promise, checked against the screen.
 *
 * The header said "Every number here is computed from your own recall history —
 * nothing is estimated", and retrievability is exactly an estimate: it is read
 * off a decay curve from `stability` and `last_seen_at` by `public.retrievability`,
 * never stored and never measured by asking the reader today. "Solid",
 * "Refreshing" and "Fading" are bands of it, so the sentence disclaimed the
 * dashboard's three headline numbers.
 *
 * A source check rather than a render: this route reads a live session and a
 * network call, and the claim lives in one paragraph of copy that a future edit
 * could quietly restore.
 */
describe('what the dashboard promises about its own numbers', () => {
  it('does not claim that nothing is estimated', () => {
    expect(PROGRESS_COPY.provenance).not.toContain('nothing is estimated');
  });

  it('says where the counts come from, and that retrievability is an estimate', () => {
    expect(PROGRESS_COPY.provenance).toContain('from your own recall history');
    expect(PROGRESS_COPY.provenance).toContain('is an estimate');
  });

  it('does not tell a reader the curve moves only when they recall something', () => {
    // `record_read` stamps `last_seen_at` on every read, so reopening an idea moves
    // the estimate without answering anything. Copy that named recall alone would
    // explain a number that had just gone up for a reason it does not contain.
    expect(PROGRESS_COPY.provenance).toContain('open or recall');
    expect(PROGRESS_COPY.provenance).not.toContain('when you last recalled it');
  });
});

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
