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
