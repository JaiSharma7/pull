import { describe, expect, it } from 'vitest';
import { toStances, toStoredColumns } from './preferences.js';

/**
 * The stance mapping.
 *
 * These two columns are the only input a reader has into `topic_affinity`, which is
 * 28% of the score in `get_feed`. Every failure here is silent: the save succeeds,
 * the screen re-renders, and the feed is weighted by something the reader did not
 * ask for. Nothing downstream would report it.
 */

describe('stances to stored columns', () => {
  it('writes a "default" topic to neither column', () => {
    // The asymmetry worth protecting. `topic_affinity` reads a missing key as no
    // preference; a zero would instead be an explicit "not interested", which is a
    // claim the reader never made and which `excluded_topics` already makes properly.
    const { topicWeights, excluded } = toStoredColumns({ ethics: 'default' });
    expect(topicWeights).toEqual({});
    expect(excluded).toEqual([]);
  });

  it('weights up only the topics chosen, and excludes only those refused', () => {
    const { topicWeights, excluded } = toStoredColumns({
      ethics: 'more',
      physics: 'less',
      stoicism: 'default',
      liberty: 'more',
    });
    expect(topicWeights).toEqual({ ethics: 1, liberty: 1 });
    expect(excluded).toEqual(['physics']);
  });

  it('produces an empty pair when nothing is chosen', () => {
    // "Show me everything" lands here, and it must be distinguishable from an
    // unanswered picker only by `onboarded_at` — not by leaving stale weights behind.
    const { topicWeights, excluded } = toStoredColumns({});
    expect(topicWeights).toEqual({});
    expect(excluded).toEqual([]);
  });
});

describe('stored columns to stances', () => {
  it('reads a weighted topic as chosen and an excluded one as refused', () => {
    expect(toStances({ ethics: 1 }, ['physics'])).toEqual({
      ethics: 'more',
      physics: 'less',
    });
  });

  it('resolves a topic in both columns to excluded', () => {
    // The database does not prevent this, so the UI has to decide. Showing "Not for
    // me" for something being filtered out of the pool is truthful; showing "More of
    // this" for it would be the screen contradicting the feed.
    expect(toStances({ ethics: 1 }, ['ethics'])).toEqual({ ethics: 'less' });
  });

  it('treats null columns as no stated preference', () => {
    // A profile row created by `handle_new_user` and never edited.
    expect(toStances(null, null)).toEqual({});
  });

  it('round-trips a set of stances unchanged', () => {
    const stances = { ethics: 'more', physics: 'less' } as const;
    const { topicWeights, excluded } = toStoredColumns(stances);
    expect(toStances(topicWeights, excluded)).toEqual(stances);
  });

  it('drops "default" across a round trip, rather than inventing a stance for it', () => {
    // Deliberate and worth pinning: "default" is the absence of a row, so it does not
    // survive storage. The picker supplies it back as the fallback for any topic it
    // finds no opinion about, which is what makes the absence readable.
    const { topicWeights, excluded } = toStoredColumns({ ethics: 'more', stoicism: 'default' });
    expect(toStances(topicWeights, excluded)).toEqual({ ethics: 'more' });
  });
});
