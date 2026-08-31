import { describe, expect, it } from 'vitest';
import { createDwellTracker, MAX_DWELL_MS, MIN_DWELL_MS } from './dwell.js';

/*
 * The signal only means something if the ways it can be wrong are closed. Every test
 * below is one of those ways, not a demonstration that addition works.
 */

describe('createDwellTracker', () => {
  it('measures a single visible interval', () => {
    const t = createDwellTracker();
    t.enter('a', 0);
    t.leave('a', 4000);
    expect(t.report(4000)).toEqual([{ id: 'a', dwellMs: 4000 }]);
  });

  it('accumulates across re-entries, so re-reading counts', () => {
    const t = createDwellTracker();
    t.enter('a', 0);
    t.leave('a', 3000);
    t.enter('a', 10_000);
    t.leave('a', 12_000);
    expect(t.report(12_000)).toEqual([{ id: 'a', dwellMs: 5000 }]);
  });

  it('does not restart an open interval when entry fires twice', () => {
    // IntersectionObserver fires more than once for the same element routinely.
    // Restarting would discard everything before the duplicate.
    const t = createDwellTracker();
    t.enter('a', 0);
    t.enter('a', 3000);
    t.leave('a', 4000);
    expect(t.report(4000)).toEqual([{ id: 'a', dwellMs: 4000 }]);
  });

  it('stops counting while the tab is hidden', () => {
    /*
     * The load-bearing one. A backgrounded tab is not reading, and without this a
     * reader who opens the app and switches away for an hour produces an hour of
     * "attention" on whatever happened to be on screen.
     */
    const t = createDwellTracker();
    t.enter('a', 0);
    t.setVisible(false, 2000);
    t.setVisible(true, 60_000);
    t.enter('a', 60_000);
    t.leave('a', 61_000);
    expect(t.report(61_000)).toEqual([{ id: 'a', dwellMs: 3000 }]);
  });

  it('ignores an entry that arrives while hidden', () => {
    const t = createDwellTracker();
    t.setVisible(false, 0);
    t.enter('a', 0);
    t.setVisible(true, 10_000);
    expect(t.report(10_000)).toEqual([]);
  });

  it('caps a tab left open, because that is furniture and not interest', () => {
    // One forgotten window would otherwise define the reader's tastes outright.
    const t = createDwellTracker();
    t.enter('a', 0);
    t.leave('a', 6 * 60 * 60 * 1000);
    expect(t.report(0)).toEqual([{ id: 'a', dwellMs: MAX_DWELL_MS }]);
  });

  it('drops a card that only passed through the viewport', () => {
    const t = createDwellTracker();
    t.enter('a', 0);
    t.leave('a', MIN_DWELL_MS - 1);
    expect(t.report(0)).toEqual([]);
  });

  it('keeps counting a card that is still on screen when drained', () => {
    /*
     * Draining is not leaving. A periodic flush must not stop the clock on the card
     * the reader is currently reading, or long reads report only their first slice.
     */
    const t = createDwellTracker();
    t.enter('a', 0);
    expect(t.report(2000)).toEqual([{ id: 'a', dwellMs: 2000 }]);
    t.leave('a', 5000);
    expect(t.report(5000)).toEqual([{ id: 'a', dwellMs: 5000 }]);
  });

  it('reports a running total, because the server keeps the largest it is sent', () => {
    /*
     * `record_read` resolves conflicts with `greatest(existing, excluded)`. Reporting
     * increments against that would keep only the largest slice and throw away the
     * rest of a long read — so a card read for four minutes in eight bursts would be
     * recorded as thirty seconds.
     *
     * Cumulative also makes every report idempotent, which is what makes the
     * `pagehide` flush safe: it is the one call whose delivery nobody can verify, and
     * losing it must cost nothing.
     */
    const t = createDwellTracker();
    t.enter('a', 0);
    t.leave('a', 3000);
    expect(t.report(3000)).toEqual([{ id: 'a', dwellMs: 3000 }]);
    expect(t.report(9000)).toEqual([{ id: 'a', dwellMs: 3000 }]);

    t.enter('a', 10_000);
    t.leave('a', 12_000);
    expect(t.report(12_000)).toEqual([{ id: 'a', dwellMs: 5000 }]);
  });

  it('survives a clock that steps backwards', () => {
    // NTP correction, or a laptop resuming from sleep. Negative time would subtract
    // from a total whose only meaning is time spent.
    const t = createDwellTracker();
    t.enter('a', 10_000);
    t.leave('a', 4000);
    expect(t.report(4000)).toEqual([]);
  });

  it('ignores a leave for a card that never entered', () => {
    const t = createDwellTracker();
    expect(() => t.leave('ghost', 1000)).not.toThrow();
    expect(t.report(1000)).toEqual([]);
  });
});
