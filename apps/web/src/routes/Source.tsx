import { useEffect, useState } from 'react';
import { fetchSourceDelta } from '../lib/api.js';
import { isOfflineFailure } from '../lib/offline.js';
import { anchoredPullId } from '../lib/routes.js';
import { fetchSource, fetchWorkIdForPull, type SourceDetail } from '../lib/source-api.js';
import type { SourceDelta } from '../lib/types.js';

/**
 * One source, and the Delta against it.
 *
 * `get_source_delta` was implemented, bounded, mutation-tested and called by nothing
 * for two rounds. It answers the sentence this product is built on — *you already
 * hold 14 of these 18, here are the 4 that are new* — and until this screen that
 * sentence existed only in the README.
 *
 * The Delta is reported as **time saved**, never time spent. `docs/product.md` lists
 * engagement metrics as an anti-goal, and the number a reader is shown is the one the
 * product is actually optimising for.
 */

/** Minutes, from the estimate the pipeline stored per Pull. */
function readingMinutes(seconds: number | null): number | null {
  if (seconds === null || seconds <= 0) return null;
  return Math.max(1, Math.round(seconds / 60));
}

export function Source({
  workId,
  onNavigate,
}: {
  workId: string;
  onNavigate: (to: string) => void;
}) {
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [delta, setDelta] = useState<SourceDelta | null>(null);
  /*
   * Four states, not two. `null` detail with no error is loading; a resolved `null`
   * from `fetchSource` is a work that does not exist; an error is an error. Review
   * has already cost this repo one screen that reported failure as good news, and
   * the fix there was exactly this distinction.
   */
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  /*
   * No reset on `workId` here: the shell renders this with `key={workId}`, so a new
   * source is a new component with fresh state. Clearing four pieces of state
   * synchronously inside the effect did the same job and made every navigation a
   * cascading render — which the react-hooks rule flags, correctly.
   */
  useEffect(() => {
    let live = true;

    fetchSource(workId)
      .then((d) => {
        if (!live) return;
        if (!d) {
          setMissing(true);
          return;
        }
        setDetail(d);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : 'Could not load this source.');
      });

    /*
     * The Delta is fetched separately and allowed to fail on its own.
     *
     * It is the more interesting half and the more fragile one: it does vector work
     * over everything the reader knows. If it fails, the source is still worth
     * reading, so the page renders without the banner rather than not at all —
     * absence of the Delta is not the same as a Delta of zero, and this is the same
     * distinction `minutesSaved: number | null` makes in the session rail.
     */
    fetchSourceDelta(workId)
      .then((d) => {
        if (live) setDelta(d);
      })
      .catch(() => {
        /* The page stands without it. */
      });

    return () => {
      live = false;
    };
  }, [workId]);

  /*
   * Scroll to the anchored Pull once the list exists.
   *
   * `replaceState` does not perform fragment navigation, and the element is not in
   * the document until the fetch resolves — so a shared `/pull/:id` link would land
   * on the right page at the wrong place, which is most of the way to landing on the
   * wrong page. Reads `location.hash` rather than taking a prop because the anchor is
   * a property of the URL, not of this component's inputs.
   */
  useEffect(() => {
    if (!detail) return;
    const pullId = anchoredPullId(window.location.hash);
    if (!pullId) return;
    document.getElementById(`p-${pullId}`)?.scrollIntoView({ block: 'start' });
  }, [detail]);

  if (missing) {
    return (
      <section className="measure">
        <h1 className="prose__heading">Not found</h1>
        <p>There is no source here. It may have been retired since you last saw it.</p>
        <button type="button" className="btn btn--plain" onClick={() => onNavigate('/')}>
          Back to the feed
        </button>
      </section>
    );
  }

  if (error) {
    return (
      <section className="measure">
        <h1 className="prose__heading">Could not load this source</h1>
        <p>
          {offline
            ? 'You appear to be offline. Saved Pulls are still readable in your Library.'
            : 'Something went wrong reaching the library.'}
        </p>
        <p className="meta">{error}</p>
        <button type="button" className="btn btn--plain" onClick={() => onNavigate('/')}>
          Back to the feed
        </button>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="measure">
        <p className="meta">Loading…</p>
      </section>
    );
  }

  const { work, pulls } = detail;

  return (
    <article className="source measure">
      <p className="meta">
        {work.kind}
        {work.year ? ` · ${work.year}` : ''}
      </p>
      <h1 className="prose__heading">{detail.summaryTitle ?? work.title}</h1>
      {work.subtitle ? <p className="source__subtitle">{work.subtitle}</p> : null}

      {detail.elevatorPitch ? <p className="source__pitch">{detail.elevatorPitch}</p> : null}
      {detail.whyItMatters ? (
        <>
          <h2 className="meta source__group">Why this matters</h2>
          <p>{detail.whyItMatters}</p>
        </>
      ) : null}

      {/*
        The Delta, in the one accent colour, above the ideas rather than below them —
        a reader deciding whether to spend the next eight minutes should be told what
        those minutes buy before they start, not congratulated afterwards.
      */}
      {delta && delta.total > 0 ? (
        <p className="source__delta">
          {delta.known === 0 ? (
            <>All {delta.total} of these ideas are new to you.</>
          ) : (
            <>
              You already hold <strong>{delta.known}</strong> of these {delta.total}.{' '}
              <strong className="source__delta-new">{delta.new}</strong>{' '}
              {delta.new === 1 ? 'is' : 'are'} new
              {delta.minutesSaved > 0 ? (
                <>
                  {' '}
                  — about <strong>{delta.minutesSaved} min</strong> you do not need to spend again
                </>
              ) : null}
              .
            </>
          )}
        </p>
      ) : null}

      <h2 className="meta source__group">
        {pulls.length} {pulls.length === 1 ? 'idea' : 'ideas'}
      </h2>

      {pulls.length === 0 ? (
        <p>
          This source has no published ideas yet. That usually means it is still being summarised.
        </p>
      ) : (
        <ol className="source__pulls">
          {pulls.map((p) => {
            const minutes = readingMinutes(p.estimatedReadSeconds);
            return (
              <li key={p.id} id={`p-${p.id}`} className="source__pull">
                <h3 className="source__pull-headline">{p.headline}</h3>
                <p className="source__pull-body">{p.body}</p>
                {p.explanation ? <p className="source__pull-more">{p.explanation}</p> : null}
                {p.whyItMatters ? (
                  <p className="source__pull-why">
                    <span className="meta">Why it matters</span> {p.whyItMatters}
                  </p>
                ) : null}
                {minutes ? <p className="meta">{minutes} min</p> : null}
              </li>
            );
          })}
        </ol>
      )}

      {work.description ? (
        <>
          <h2 className="meta source__group">About the source</h2>
          <p>{work.description}</p>
        </>
      ) : null}

      <div className="source__foot">
        <button type="button" className="btn btn--plain" onClick={() => onNavigate('/')}>
          Back to the feed
        </button>
      </div>
    </article>
  );
}

/**
 * `/pull/:id` → the source that Pull belongs to, anchored at the Pull.
 *
 * The deployed `og` Edge Function has been redirecting browsers to
 * `${APP_ORIGIN}/pull/${id}` since round 2, and until now that path rendered the
 * feed: a shared link that opened on somebody else's idea. This resolves it.
 *
 * `replace` rather than `push`, so the browser Back button returns to wherever the
 * reader came from rather than to a URL that only ever redirects.
 */
export function PullRedirect({
  pullId,
  onReplace,
  onNavigate,
}: {
  pullId: string;
  onReplace: (to: string) => void;
  onNavigate: (to: string) => void;
}) {
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    fetchWorkIdForPull(pullId)
      .then((workId) => {
        if (!live) return;
        if (workId) onReplace(`/source/${workId}#p-${pullId}`);
        else setMissing(true);
      })
      .catch(() => {
        // A Pull that cannot be resolved is indistinguishable to the reader from one
        // that does not exist, and both are better than a spinner that never stops.
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [pullId, onReplace]);

  if (missing) {
    return (
      <section className="measure">
        <h1 className="prose__heading">Not found</h1>
        <p>That Pull is no longer available.</p>
        <button type="button" className="btn btn--plain" onClick={() => onNavigate('/')}>
          Back to the feed
        </button>
      </section>
    );
  }

  return (
    <section className="measure">
      <p className="meta">Finding that Pull…</p>
    </section>
  );
}
