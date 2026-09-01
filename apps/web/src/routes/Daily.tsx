import { useEffect, useState } from 'react';
import { fetchDailyCuration, type DailyCuration } from '../lib/daily-api.js';
import { isOfflineFailure } from '../lib/offline.js';

/**
 * The Daily Pull — a small, finite, curated set, and then you are done.
 *
 * "Curated Daily Pulls" is one of the five things CLAUDE.md law 3 promises free
 * forever, and until this screen it existed only as a table with no readers and a
 * label in `Enough.tsx`. It is affordable by design: rows in Postgres, chosen once,
 * served to everyone. No model runs here (law 2).
 *
 * Deliberately not the feed. The feed is ranked, personal and endless-ish; this is the
 * same handful for every reader, in a fixed order, with a curator's note. That is the
 * whole appeal — finishing it is possible.
 */

/** `2026-08-31` → `31 August 2026`, in the reader's own locale. */
function formatDay(day: string): string {
  // Parsed as parts rather than `new Date(day)`: an ISO date string is treated as UTC
  // midnight, which renders as the *previous* day for every reader west of Greenwich.
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function isToday(day: string): boolean {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return day === `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function Daily({
  onNavigate,
  onGoToFeed,
}: {
  onNavigate: (to: string) => void;
  /**
   * Leave for the feed — both the tab and the path.
   *
   * `onNavigate('/')` alone changed the URL and left `tab` on `daily`, and the shell
   * renders Daily on the root path, so the advertised exit put the reader back on the
   * screen they were trying to leave. A control that does nothing is worse than no
   * control, and this one was the only way out of an empty state.
   */
  onGoToFeed: () => void;
}) {
  const [curation, setCuration] = useState<DailyCuration | null>(null);
  /*
   * Four states, and the distinction between the last two is the point.
   *
   * `curation` null with no error and not settled is loading; settled with a null
   * curation is genuinely nothing curated; an error is an error. Collapsing a failed
   * request into the empty state is the bug the Review screen shipped with — a fetch
   * that failed rendered "Nothing is fading. Everything you have saved is still
   * solid.", telling the reader their memory was perfect because the request broke.
   * This screen does not repeat it.
   */
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchDailyCuration()
      .then((c) => {
        if (cancelled) return;
        setCuration(c);
        setSettled(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Detail to the console; the reader gets a sentence rather than a SQLSTATE.
        console.error('Daily Pull request failed', e);
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Daily Pull</p>
        <h1>Could not fetch today's pick.</h1>
        <p>
          {offline
            ? 'You appear to be offline. The Pulls already loaded in your feed are still readable.'
            : 'Something went wrong reaching the library.'}
        </p>
        <p className="meta">{error}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setError(null);
            setSettled(false);
            setReloads((n) => n + 1);
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  if (!settled) {
    return (
      <p className="meta" role="status">
        Loading…
      </p>
    );
  }

  if (!curation) {
    return (
      <section className="stack measure">
        <p className="meta">Daily Pull</p>
        <h1>Nothing curated yet.</h1>
        <p>
          The Daily Pull is a small, chosen set rather than a ranked feed — a few ideas worth the
          walk, the same ones for everyone. There is no selection to show yet.
        </p>
        <hr className="rule" />
        {/*
          A door out rather than a dead end. The feed is ranked and always has
          something, so an empty Daily should send the reader there instead of
          leaving them on a screen with nothing on it.
        */}
        <button type="button" className="btn" onClick={onGoToFeed}>
          Read the feed instead
        </button>
      </section>
    );
  }

  const { day, pulls } = curation;

  return (
    <section className="stack measure">
      <p className="meta">Daily Pull</p>
      {/*
        The date is named rather than assumed. When the curation is not today's — the
        job has not run, or the reader's calendar is ahead of the database's — saying
        so is the difference between a stale screen and a dishonest one.
      */}
      <h1>{isToday(day) ? 'Today' : formatDay(day)}</h1>
      {!isToday(day) && (
        <p className="meta">Curated {formatDay(day)} — the most recent selection.</p>
      )}

      <ol className="daily__list">
        {pulls.map((p) => (
          <li key={p.pullId} className="daily__item">
            <p className="pull-card__chip">
              {p.workTitle}
              {p.workYear ? ` · ${p.workYear}` : ''}
            </p>
            <h2 className="daily__headline">{p.headline}</h2>
            {p.blurb ? <p className="daily__blurb">{p.blurb}</p> : null}
            <p className="daily__body">{p.body}</p>
            {p.whyItMatters ? (
              <p className="daily__why">
                <span className="meta">Why it matters</span> {p.whyItMatters}
              </p>
            ) : null}
            <button
              type="button"
              className="btn btn--plain"
              onClick={() => onNavigate(`/pull/${p.pullId}`)}
            >
              Read it in its source
            </button>
          </li>
        ))}
      </ol>

      <p className="meta">
        That is the whole of it — {pulls.length} {pulls.length === 1 ? 'idea' : 'ideas'}, chosen
        rather than ranked.
      </p>
    </section>
  );
}
