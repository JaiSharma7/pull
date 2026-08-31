import { useCallback, useEffect, useState } from 'react';
import { groupByDay, type HistoryEntry } from '../lib/history.js';
import { fetchHistoryPage } from '../lib/history-api.js';
import { isOfflineFailure } from '../lib/offline.js';

/**
 * Everything you have read, by day.
 *
 * "Unlimited history" is one of the five things CLAUDE.md law 3 promises free forever,
 * and until this screen it had no surface at all — `history_events` was written by the
 * read path and read by nobody, while the Colophon told every reader it was theirs.
 *
 * Deliberately a record, not a scoreboard. `docs/product.md` lists engagement metrics
 * as an anti-goal, so there is no streak, no total, and no time-spent tally: `dwell_ms`
 * is on the table and stays off this screen. What a reader wants from their history is
 * to find something again.
 */

/** `2026-08-31` → `Today`, `Yesterday`, or a written date. */
function formatDay(day: string): string {
  // Parsed as parts, not `new Date(day)`: an ISO date string is treated as UTC
  // midnight, which renders as the previous day for every reader west of Greenwich.
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const date = new Date(y, m - 1, d);

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const daysAgo = Math.round((midnight.getTime() - date.getTime()) / 86_400_000);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === midnight.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function History({ onNavigate }: { onNavigate: (to: string) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextPage, setNextPage] = useState(1);
  /*
   * Three states, not two: loading, genuinely-nothing-read-yet, and failed.
   *
   * Collapsing a failed request into the empty state is the bug the Review screen
   * shipped with — a failed fetch rendered "Nothing is fading. Everything you have
   * saved is still solid.", telling the reader their memory was perfect because the
   * request broke. Telling someone their history is empty when the request failed is
   * the same lie about a different table, and on the one screen whose entire job is
   * to be a complete record it would be worse.
   */
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchHistoryPage(0)
      .then((p) => {
        if (cancelled) return;
        setEntries(p.entries);
        setHasMore(p.hasMore);
        setNextPage(1);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error('History request failed', e);
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setMoreError(null);
    fetchHistoryPage(nextPage)
      .then((p) => {
        setEntries((prev) => [...(prev ?? []), ...p.entries]);
        setHasMore(p.hasMore);
        setNextPage((n) => n + 1);
      })
      .catch((e: unknown) => {
        console.error('History page request failed', e);
        // Kept apart from `error`, which replaces the screen. A page that fails to
        // load must not take the pages that succeeded with it.
        setMoreError('Could not load more of your history just now.');
      })
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, nextPage]);

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">History</p>
        <h1>Could not load your history.</h1>
        <p>
          {offline
            ? 'You appear to be offline. Saved Pulls are still readable in your Library.'
            : 'Something went wrong reaching the library. Nothing has been lost.'}
        </p>
        <p className="meta">{error}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setError(null);
            setEntries(null);
            setReloads((n) => n + 1);
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  if (!entries) return <p className="meta">Loading…</p>;

  if (entries.length === 0) {
    return (
      <section className="stack measure">
        <p className="meta">History</p>
        <h1>Nothing read yet.</h1>
        <p>
          Every idea you meet is recorded here, by the day you met it — kept indefinitely, and free.
          Read something and it will show up.
        </p>
        <hr className="rule" />
        <button type="button" className="btn" onClick={() => onNavigate('/')}>
          Go to the feed
        </button>
      </section>
    );
  }

  const days = groupByDay(entries);

  return (
    <section className="stack measure">
      <p className="meta">History</p>
      <h1>Everything you have read.</h1>

      {days.map(({ day, entries: dayEntries }) => (
        <section key={day} className="history__day">
          <h2 className="meta history__date">
            {formatDay(day)} · {dayEntries.length} {dayEntries.length === 1 ? 'idea' : 'ideas'}
          </h2>
          <ul className="history__list">
            {dayEntries.map((e) => (
              <li key={e.id} className="history__item">
                <button
                  type="button"
                  className="btn btn--plain history__link"
                  onClick={() => onNavigate(`/pull/${e.pullId}`)}
                >
                  {e.headline}
                </button>
                <p className="meta history__source">
                  {e.workTitle}
                  {e.workYear ? ` · ${e.workYear}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {moreError && (
        <p className="meta" role="status">
          {moreError}
        </p>
      )}

      {/*
        Shown only while there is more. A control that can only say "no" is worse
        than no control — and this is the screen where the reader is most likely to
        be looking for something specific, so a dead button reads as a broken search.
      */}
      {hasMore && (
        <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Earlier'}
        </button>
      )}
    </section>
  );
}
