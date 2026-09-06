import { describe, expect, it } from 'vitest';
import { GRAPH_LIMIT } from '../lib/graph-api.js';
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
    // Narrowed with the claim it was pinning. Asserting the old wording would now
    // hold the copy to something false about five of the six figures on the screen —
    // see `PROGRESS_COPY`. What has to survive is that the reader is told where the
    // numbers come from, and that the three kinds are not run together.
    expect(PROGRESS_COPY.provenance).toContain('comes from your own history');
    expect(PROGRESS_COPY.provenance).toContain('readings off that curve');
    expect(PROGRESS_COPY.provenance).toContain('is an estimate');
  });

  it('does not disown the one number the reader controls', () => {
    /*
     * "Connections and tensions describe the library itself, not you" was the fix for
     * the previous claim and overshot it. The tile counts
     * `undirectedEdges(measured.edges)` off the PERSONAL graph, and the RPC's
     * `user_edges` CTE keeps only edges with both ends in the reader's own
     * `knowledge_states`, so the number is about their reading. A reader told it had
     * nothing to do with them could not explain it moving at all.
     *
     * Both halves have to survive — the relationships are the library's, the selection
     * is the reader's — because together they are why the count is not a score.
     */
    expect(PROGRESS_COPY.provenance).not.toContain('describe the library itself, not you');
    expect(PROGRESS_COPY.provenance).toContain('relationships the library draws between ideas');
    expect(PROGRESS_COPY.provenance).toContain('ideas you have read are counted');
  });

  it('promises no direction it cannot keep', () => {
    /*
     * `fetchKnowledgeGraph` asks for 150 and the RPC takes the 150 most recent by
     * `last_seen_at desc`, so past 150 read ideas a new one evicts the least recently
     * seen: the connections count can FALL while the reader reads. "That number moves
     * as you read" was the only directional promise on the screen and it is the kind
     * this file exists to stop — a sentence that explains a number until the number
     * does the other thing.
     */
    expect(PROGRESS_COPY.provenance).not.toContain('moves as you read');
    // The NUMBER, from the default it describes rather than from a literal beside it.
    // Asserting the string '150' would let somebody tune `fetchKnowledgeGraph` and
    // leave the sentence claiming the old cap, with this test green — which is the
    // exact shape of claim this file exists to catch.
    expect(PROGRESS_COPY.provenance).toContain(`your ${GRAPH_LIMIT} most recently seen`);
    expect(GRAPH_LIMIT).toBe(150);
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
