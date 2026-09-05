/**
 * A strictly increasing stamp for ordering the reader's own decisions.
 *
 * `Date.now()` is only millisecond-resolution, so two submissions made inside
 * one millisecond share a value — and equal timestamps carry no information
 * about which came first, which is the one thing the server needs to order
 * them. Advancing by a millisecond whenever the clock has not moved makes that
 * impossible within a tab: every stamp this returns is greater than the last.
 *
 * It is deliberately per-tab. Making it monotonic across tabs would need an
 * origin-wide lock around a stored counter on every submission, and the race it
 * would close — two tabs answering the same card inside the same millisecond —
 * is not reachable by someone clicking. The remaining tie resolves to whichever
 * submission reaches the database second, which is no worse than arbitrary and
 * no longer discards a stance.
 *
 * It can run ahead of the wall clock, by at most one millisecond per submission
 * in a burst. That is the point: it is an ordering token, not a timestamp, and
 * the server compares it only against other stamps from the same reader.
 */
let last = 0;

export function nextSubmissionStamp(): number {
  const now = Date.now();
  last = now > last ? now : last + 1;
  return last;
}

/**
 * The longest answer the database will accept as a measurement.
 *
 * `recall_events_latency_bounds` in `20260905100000_a_grade_is_recorded_once.sql`
 * is `latency_ms is null or latency_ms between 0 and 3600000`. Mirrored here as a
 * named constant rather than repeated as a number, because it is a database fact
 * and the check is the reason this function exists.
 */
export const MAX_LATENCY_MS = 3_600_000;

/**
 * How long since the answer was shown — or nothing, when that is not a measurement.
 *
 * Review sent `Date.now() - revealedAt` unbounded, so a reader who revealed an
 * answer and came back after lunch sent something over the hour the column allows.
 * Postgres refused it with `23514`, and because a check violation is permanent the
 * grade was then queued and dropped by the first drain — the whole grade lost over
 * a field that is only ever advisory.
 *
 * Omitted rather than clamped, and that is the substance of the fix. Clamping would
 * record exactly one hour, which is a measurement, and a false one: someone who
 * walked away did not take an hour to decide. `latency_ms` is nullable precisely so
 * that "no useful timing" can be said, and a grade with no latency is worth far more
 * than no grade at all.
 */
export function elapsedSince(revealedAt: number | null, now = Date.now()): number | undefined {
  if (revealedAt === null) return undefined;
  const elapsed = now - revealedAt;
  // A clock that has gone backwards — an NTP correction mid-session — is not a
  // negative answer time either; the column's floor is 0 and the honest value is none.
  if (elapsed < 0 || elapsed > MAX_LATENCY_MS) return undefined;
  return elapsed;
}
