import { useEffect, useState } from 'react';
import {
  TOPIC_PAGE,
  type TopicPage,
  expandLimit,
  topicCountLine,
  topicTerminalLine,
} from '../lib/explore.js';
import { fetchTopic } from '../lib/explore-api.js';
import { isOfflineFailure } from '../lib/offline.js';

/**
 * One topic, and every source under it.
 *
 * An index, not a stack of cards: a row is a pointer to somewhere rather than
 * the thing itself, and a column of cards is the shape law 7 rejects. The count
 * leads, and the list ends in a sentence that distinguishes "that was all of
 * them" from "that was as many as we are showing" — only the second is
 * something a reader can act on.
 *
 * A parent topic includes its children's sources, so opening Philosophy from the
 * catalogue lists the number the catalogue just promised.
 */

const KIND_LABEL: Record<string, string> = {
  book: 'Book',
  film: 'Film',
  documentary: 'Documentary',
  podcast: 'Podcast',
  paper: 'Paper',
  essay: 'Essay',
  lecture: 'Lecture',
  video: 'Video',
  interview: 'Interview',
  other: 'Source',
};

function sourceLine(kind: string, year: number | null): string {
  const label = KIND_LABEL[kind] ?? KIND_LABEL.other!;
  return year ? `${year} · ${label}` : label;
}

export function Topic({ slug, onNavigate }: { slug: string; onNavigate: (to: string) => void }) {
  const [limit, setLimit] = useState(TOPIC_PAGE);
  const [page, setPage] = useState<TopicPage | null>(null);
  /*
   * `missing` is its own state, not `page === null` with no error. A slug that
   * does not exist and a request that failed are different things to be told,
   * and collapsing them is the bug class `routes/Review.tsx:14-28` records.
   */
  const [missing, setMissing] = useState(false);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchTopic(slug, limit, controller.signal)
      .then((p) => {
        if (controller.signal.aborted) return;
        setPage(p);
        setMissing(p === null);
        setSettled(true);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        console.error('Topic request failed', e);
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [slug, limit, attempt]);

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Topic</p>
        <h1>Could not open this topic.</h1>
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

  if (!settled) return <p className="meta">Loading…</p>;

  if (missing || !page) {
    return (
      <section className="stack measure">
        <p className="meta">Topic</p>
        <h1>Nothing here.</h1>
        <p>
          There is no topic at this address, or nothing has been published under it yet. The
          catalogue lists every topic with sources behind it.
        </p>
        <button type="button" className="btn" onClick={() => onNavigate('/explore')}>
          Open the catalogue
        </button>
      </section>
    );
  }

  const next = expandLimit(limit);
  const truncated = page.counts.shown < page.counts.sources;

  return (
    <section className="stack measure">
      <p className="meta">
        {page.topic.parentLabel ? `Explore · ${page.topic.parentLabel}` : 'Explore'}
      </p>
      <h1>{page.topic.label}</h1>
      <p className="explore__totals">{topicCountLine(page)}</p>

      <ol className="explore__sources">
        {page.sources.map((source) => (
          <li key={source.id} className="explore__source">
            <p className="pull-card__chip">{sourceLine(source.kind, source.year)}</p>
            <button
              type="button"
              className="btn btn--plain explore__source-title"
              onClick={() => onNavigate(`/source/${source.id}`)}
            >
              {source.title}
            </button>
            {source.subtitle ? <p className="explore__source-sub">{source.subtitle}</p> : null}
            <p className="explore__source-meta meta">
              {source.ideas} {source.ideas === 1 ? 'idea' : 'ideas'}
              {/*
                Stated in words, not carried by a colour (design law 5), and
                worded as what it measures: a directly remembered count, not the
                Delta's semantic coverage, which stays on the source page.
              */}
              {source.known > 0 ? ` · ${source.known} you know` : ''}
            </p>
          </li>
        ))}
      </ol>

      <hr className="rule" />
      <p className="meta">{topicTerminalLine(page)}</p>

      {/*
        One expansion, and then the control is gone — `expandLimit` returns null
        rather than a larger number, so no sequence of presses grows this list
        without end. That is law 7 as a function rather than as a promise.
      */}
      {truncated && next !== null && (
        <button type="button" className="btn" onClick={() => setLimit(next)}>
          Show the remaining {page.counts.sources - page.counts.shown}
        </button>
      )}

      {page.topic.parentSlug && (
        <button
          type="button"
          className="btn btn--plain"
          onClick={() => onNavigate(`/topic/${encodeURIComponent(page.topic.parentSlug!)}`)}
        >
          All of {page.topic.parentLabel}
        </button>
      )}
    </section>
  );
}
