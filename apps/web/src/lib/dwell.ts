/**
 * How long a reader actually spent with an idea.
 *
 * `history_events.dwell_ms` has existed since the first migration and every row in
 * production holds **0** — `recordRead(row.id, 0, index)` was the only call site, and
 * nothing measured anything. So a feed that ranked on dwell would rank on a column
 * that is uniformly zero and silently do nothing at all.
 *
 * What is measured here is *visible, foreground* time, which is deliberately narrower
 * than elapsed time:
 *
 * - Accumulated across re-entries, so scrolling back to re-read counts.
 * - Paused when the tab is hidden, because a backgrounded tab is not reading.
 * - Capped, because a tab left open overnight is not interest — it is furniture.
 *
 * The cap is the part that decides whether this signal means anything. Without it a
 * single abandoned tab produces an hour of "attention" on one idea and drowns every
 * honest signal in the account.
 *
 * Time is injected rather than read from `Date.now()` so this is testable without
 * waiting, and so a test can assert the pause semantics rather than approximate them.
 */

/**
 * Longer than this is not reading.
 *
 * Five minutes on one idea is already an outlier: `estimated_read_seconds` across the
 * corpus runs to a couple of minutes at most. Anything beyond it is a tab that was
 * left open, and counting it would let one forgotten window define a reader's tastes.
 */
export const MAX_DWELL_MS = 5 * 60 * 1000;

/** Below this it is a card passing through the viewport on the way somewhere else. */
export const MIN_DWELL_MS = 1000;

export interface DwellTracker {
  /** The card became visible. Ignored if it already is. */
  enter(id: string, now: number): void;
  /** The card stopped being visible. Accumulates the interval; safe if never entered. */
  leave(id: string, now: number): void;
  /** Tab hidden or shown. Closes or reopens every open interval at once. */
  setVisible(visible: boolean, now: number): void;
  /**
   * Everything worth reporting, as a running total per card.
   *
   * **Cumulative, and deliberately not cleared.** `record_read` resolves a conflict
   * with `greatest(existing, excluded)`, so the server keeps the largest number it
   * has ever been sent for a card. Reporting increments against that would keep only
   * the largest *slice* and silently discard the rest of a long read.
   *
   * Cumulative also makes every report idempotent, which is what makes this safe to
   * call from `pagehide` — the one flush of a session whose delivery nobody can
   * check. A lost report costs nothing: the next one carries the same ground it did.
   */
  report(now: number): { id: string; dwellMs: number }[];
}

export function createDwellTracker(): DwellTracker {
  /** id → ms accumulated in closed intervals. */
  const total = new Map<string, number>();
  /** id → timestamp the current open interval began. Absent means not open. */
  const openedAt = new Map<string, number>();
  let visible = true;

  const close = (id: string, now: number) => {
    const started = openedAt.get(id);
    if (started === undefined) return;
    openedAt.delete(id);
    // `max(0, …)` because a clock that steps backwards (NTP, a suspended laptop)
    // would otherwise subtract time from a total that only ever means "time spent".
    total.set(id, (total.get(id) ?? 0) + Math.max(0, now - started));
  };

  return {
    enter(id, now) {
      if (!visible) return;
      // Re-entering an already-open card must not restart the interval, or a
      // duplicate observer callback silently discards everything before it.
      if (!openedAt.has(id)) openedAt.set(id, now);
    },
    leave(id, now) {
      close(id, now);
    },
    setVisible(next, now) {
      if (next === visible) return;
      visible = next;
      if (next) return; // Nothing reopens on its own; the observer re-enters what is on screen.
      for (const id of [...openedAt.keys()]) close(id, now);
    },
    report(now) {
      for (const id of [...openedAt.keys()]) {
        close(id, now);
        // Reopened, because reporting is not leaving: a periodic flush must not stop
        // the clock on a card the reader is still looking at.
        if (visible) openedAt.set(id, now);
      }
      const out: { id: string; dwellMs: number }[] = [];
      for (const [id, ms] of total) {
        const capped = Math.min(ms, MAX_DWELL_MS);
        if (capped >= MIN_DWELL_MS) out.push({ id, dwellMs: capped });
      }
      return out;
    },
  };
}
