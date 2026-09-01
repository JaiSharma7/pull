import { useCallback, useEffect, useState } from 'react';
import {
  formatHistoryDay,
  groupByDay,
  type HistoryCursor,
  type HistoryEntry,
} from '../lib/history.js';
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

export function History({
  onNavigate,
  onGoToFeed,
}: {
  onNavigate: (to: string) => void;
  /** Leave for the feed — both the tab and the path. See `Daily.tsx`. */
  onGoToFeed: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  /** Where the next page resumes. Keyset, so inserts between pages cannot repeat a row. */
  const [cursor, setCursor] = useState<HistoryCursor | null>(null);
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
    fetchHistoryPage()
      .then((p) => {
        if (cancelled) return;
        setEntries(p.entries);
        setHasMore(p.hasMore);
        setCursor(p.cursor);
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
    fetchHistoryPage(cursor)
      .then((p) => {
        setEntries((prev) => [...(prev ?? []), ...p.entries]);
        setHasMore(p.hasMore);
        // Only advance when the page actually returned a place to resume from; a null
        // cursor would restart the list from the top on the next press.
        if (p.cursor) setCursor(p.cursor);
      })
      .catch((e: unknown) => {
        console.error('History page request failed', e);
        // Kept apart from `error`, which replaces the screen. A page that fails to
        // load must not take the pages that succeeded with it.
        setMoreError('Could not load more of your history just now.');
      })
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, cursor]);

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">History</p>
        <h1>Could not load your history.</h1>
        <p>
          {offline
            ? 'You appear to be offline. The Pulls already loaded in your feed are still readable.'
            : 'Something went wrong reaching the library. Nothing has been lost.'}
        </p>
        <p className="meta">{error}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setError(null);
            setEntries(null);
            setCursor(null);
            setReloads((n) => n + 1);
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  if (!entries)
    return (
      <p className="meta" role="status">
        Loading…
      </p>
    );

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
        <button type="button" className="btn" onClick={onGoToFeed}>
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
            {formatHistoryDay(day)} · {dayEntries.length}{' '}
            {dayEntries.length === 1 ? 'idea' : 'ideas'}
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
