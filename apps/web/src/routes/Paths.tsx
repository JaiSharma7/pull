import { useEffect, useState } from 'react';
import { progressLabel, type PathItem } from '../lib/paths.js';
import { fetchPaths } from '../lib/paths-api.js';
import { isOfflineFailure } from '../lib/offline.js';

export function Paths({
  userId,
  onNavigate,
}: {
  userId: string | null;
  onNavigate: (to: string) => void;
}) {
  const [paths, setPaths] = useState<PathItem[]>([]);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchPaths(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setPaths(items);
        setSettled(true);
        // A load that worked ends the failure before it. `error` was set in one place
        // and cleared in none, so one flaky request replaced the list with a dead end
        // until the reader reloaded the page. `Library.tsx` documents the same defect.
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        console.error('Paths request failed', e);
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
    // `userId` is in the deps and not in the body on purpose. `get_paths` answers for
    // whoever `auth.uid()` is and is granted to anon too, so it is the session that
    // decides what comes back: signing in with this screen mounted left the visitor's
    // all-null progress on screen, and `progressLabel` read "5 steps" over a path the
    // reader had finished. `Library.tsx` is the precedent.
  }, [userId, attempt]);

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Learning Paths</p>
        <h1>Could not load learning paths.</h1>
        <p>
          {offline
            ? 'You appear to be offline. Paths need an active connection.'
            : 'Something went wrong loading the paths.'}
        </p>
        <p className="meta">{error}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setError(null);
            setSettled(false);
            setAttempt((n) => n + 1);
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

  if (paths.length === 0) {
    return (
      <section className="stack measure">
        <p className="meta">Learning Paths</p>
        <h1>No paths available yet.</h1>
        <p>
          Curated learning progressions are being prepared. Check back soon or explore the catalogue
          directly.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => onNavigate('/explore')}>
          Explore catalogue
        </button>
      </section>
    );
  }

  return (
    <section className="stack measure">
      <div className="paths__header">
        <p className="meta">Learning Paths</p>
        <h1>A path has an end.</h1>
        <p>
          Each path answers a single question in five steps: read the core claim, predict its
          mechanism, compare it against an opposing work, say it back in your own words, and ground
          it in an application.
        </p>
      </div>

      <ol className="paths__list">
        {paths.map((p) => {
          const isCompleted =
            Boolean(p.completedAt) || (p.stepCount > 0 && p.completedSteps >= p.stepCount);
          const label = progressLabel(p.completedSteps, p.stepCount, p.completedAt);

          return (
            <li key={p.id} className="paths__item">
              <div className="paths__item-header">
                <button
                  type="button"
                  className="btn btn--plain paths__item-title"
                  onClick={() => onNavigate(`/path/${encodeURIComponent(p.slug)}`)}
                >
                  {p.title}
                </button>
                <span
                  className={`paths__item-status ${
                    isCompleted ? 'paths__item-status--completed' : ''
                  }`}
                >
                  {label}
                </span>
              </div>

              <p className="paths__item-question">{p.question}</p>
              <p className="paths__item-desc">{p.description}</p>

              <div className="paths__item-footer">
                {p.topicSlug && <span className="paths__item-topic">{p.topicSlug}</span>}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="meta">That is every path.</p>
    </section>
  );
}
