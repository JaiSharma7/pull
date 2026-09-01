import { useEffect, useState } from 'react';
import { type Catalogue, EMPTY_CATALOGUE, catalogueSummary } from '../lib/explore.js';
import { fetchCatalogue } from '../lib/explore-api.js';
import { isOfflineFailure } from '../lib/offline.js';

/**
 * The catalogue: every topic in the library, on one page.
 *
 * Topics existed only as a preference input. There was no topic hub, no source
 * index, no way to go from "I am interested in this subject" to the sources
 * under it — which is exactly the complaint reviewers make about Deepstash, and
 * we had it worse because we had no path at all.
 *
 * A CATALOGUE, NOT A FEED, and the layout is where that claim is made rather
 * than in the copy. The whole taxonomy renders in one call, so there is no
 * control on this page that can lengthen it; the size of the library leads,
 * before any of it; and the rows are index lines, not cards. A column of cards
 * is precisely the screenshot law 7 says could be mistaken for a video feed with
 * the sound off. A contents page could not be.
 */

export function Explore({ onNavigate }: { onNavigate: (to: string) => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue>(EMPTY_CATALOGUE);
  /*
   * Four states, not two. Loading, a settled empty library, and a failed
   * request must look different — Review already cost this repo one screen that
   * reported a broken fetch as good news, and the fix there was this
   * distinction.
   */
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchCatalogue(controller.signal)
      .then((c) => {
        if (controller.signal.aborted) return;
        setCatalogue(c);
        setSettled(true);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        // Detail to the console; the reader gets a sentence rather than a SQLSTATE.
        console.error('Catalogue request failed', e);
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [attempt]);

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Explore</p>
        <h1>Could not open the catalogue.</h1>
        <p>
          {offline
            ? 'You appear to be offline. The catalogue needs a connection.'
            : 'Something went wrong reaching the library.'}
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

  if (!settled)
    return (
      <p className="meta" role="status">
        Loading…
      </p>
    );

  if (catalogue.parents.length === 0) {
    return (
      <section className="stack measure">
        <p className="meta">Explore</p>
        <h1>Nothing to browse yet.</h1>
        <p>
          Topics appear here once there are sources behind them. New Pulls are still being drawn
          from their sources — this is a young library.
        </p>
      </section>
    );
  }

  return (
    <section className="stack measure">
      <p className="meta">Explore</p>
      <h1>The catalogue</h1>
      {/*
        The size of the whole thing, before any of it. This is the anti-infinite-
        scroll device: a reader knows what they are looking at rather than
        discovering its extent by failing to reach the end.
      */}
      <p className="explore__totals">{catalogueSummary(catalogue)}</p>

      <ol className="explore__parents">
        {catalogue.parents.map((parent) => (
          <li key={parent.slug} className="explore__parent">
            <div className="explore__row">
              <button
                type="button"
                className="btn btn--plain explore__parent-name"
                onClick={() => onNavigate(`/topic/${encodeURIComponent(parent.slug)}`)}
              >
                {parent.label}
              </button>
              <span className="explore__count">
                {parent.sources} {parent.sources === 1 ? 'source' : 'sources'}
              </span>
            </div>

            {parent.children.length > 0 && (
              <ul className="explore__children">
                {parent.children.map((child) => (
                  <li key={child.slug} className="explore__child">
                    <button
                      type="button"
                      className="btn btn--plain explore__child-name"
                      onClick={() => onNavigate(`/topic/${encodeURIComponent(child.slug)}`)}
                    >
                      {child.label}
                    </button>{' '}
                    <span className="explore__child-count">{child.sources}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>

      {/* The end is a sentence, not the page simply stopping. */}
      <p className="meta">That is the whole catalogue.</p>
    </section>
  );
}
