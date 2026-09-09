import { useEffect, useState } from 'react';
import { fetchDailyCuration, type DailyCuration } from '../lib/daily-api.js';
import { isOfflineFailure } from '../lib/offline.js';
import { useCalendarDay } from '../lib/use-calendar-day.js';

function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function Daily({
  onNavigate,
  onGoToFeed,
}: {
  onNavigate: (to: string) => void;
  onGoToFeed: () => void;
}) {
  const day = useCalendarDay();
  const [curation, setCuration] = useState<DailyCuration | null>(null);
  const [failure, setFailure] = useState<{ day: string; reload: number; offline: boolean } | null>(
    null,
  );
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchDailyCuration(day)
      .then((data) => {
        if (!cancelled) {
          setCuration(data);
          setFailure(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error('Daily Pull request failed', error);
          setFailure({ day, reload, offline: isOfflineFailure(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [day, reload]);

  if (failure?.day === day && failure.reload === reload) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Daily Pull</p>
        <h1>Could not fetch today's pick.</h1>
        <p>
          {failure.offline
            ? 'You appear to be offline. Your downloaded feed is still readable.'
            : 'Something went wrong reaching the library.'}
        </p>
        <button type="button" className="btn" onClick={() => setReload((n) => n + 1)}>
          Try again
        </button>
      </section>
    );
  }
  if (curation?.day !== day) {
    return (
      <section className="stack measure" aria-busy="true">
        <p className="meta">Choosing your Daily Pull…</p>
      </section>
    );
  }
  return (
    <section className="stack measure">
      <p className="meta">Daily Pull</p>
      <h1>{formatDay(day)}</h1>
      {curation.pulls.length === 0 ? (
        <>
          <h2>
            {curation.editorialDay !== undefined
              ? 'No editorial picks are available yet.'
              : 'You’re caught up for today.'}
          </h2>
          <p>
            {curation.editorialDay !== undefined
              ? 'Explore the library while we prepare the daily selection.'
              : 'There are no new or fading ideas to show right now. Recent daily selections stay out of the rotation for two weeks.'}
          </p>
          <button type="button" className="btn" onClick={onGoToFeed}>
            Read the feed instead
          </button>
        </>
      ) : (
        <>
          <p className="meta">
            {curation.editorialDay
              ? `From the editorial archive · ${formatDay(curation.editorialDay)}. Your personal daily mix is temporarily unavailable.`
              : 'Your daily mix of new ideas and ideas to refresh.'}
          </p>
          <ol className="daily__list">
            {curation.pulls.map((p) => (
              <li key={p.pullId} className="daily__item">
                <p className="pull-card__chip">
                  {p.workTitle}
                  {p.workYear ? ` · ${p.workYear}` : ''}
                </p>
                <p className="meta">
                  {p.reason === 'editorial'
                    ? 'Editorial pick'
                    : p.reason === 'fading'
                      ? 'Worth revisiting'
                      : 'New to you'}
                </p>
                <h2 className="daily__headline">{p.headline}</h2>
                <p className="daily__body">{p.body}</p>
                {p.whyItMatters && (
                  <p className="daily__why">
                    <span className="meta">Why it matters</span> {p.whyItMatters}
                  </p>
                )}
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
            That is the whole of it — {curation.pulls.length}{' '}
            {curation.pulls.length === 1 ? 'idea' : 'ideas'}
            {curation.editorialDay ? ' from the editorial archive.' : ', chosen for you.'}
          </p>
        </>
      )}
    </section>
  );
}
