import { useEffect, useState } from 'react';
import { isOfflineFailure } from '../lib/offline.js';
import { searchCatalogue } from '../lib/search-api.js';
import {
  classifyQuery,
  countLine,
  isEmptyResult,
  normaliseQuery,
  terminalLine,
  type SearchResult,
} from '../lib/search.js';

/**
 * Finding one idea among the library's.
 *
 * Until this screen there were 156 ideas across 42 sources and no way to reach a
 * particular one: the only routes to a source page were a card chip, a Daily Pull
 * item, or a History row. That is the largest single hole in the product, and it
 * was cheap to close — `pulls_headline_trgm`, `works_title_trgm` and
 * `pulls_embedding_hnsw` had all existed since round 1 with nothing querying them.
 *
 * No model runs here. `search_catalogue` is full-text ranking plus one pgvector
 * average over embeddings written at generation time, so the reader's query is
 * never embedded (law 2), and the search costs the same as any other read: nothing.
 *
 * TWO THINGS THE LAYOUT IS DOING ON PURPOSE.
 *
 * The count leads the results rather than trailing them. Law 7 says a session has
 * visible edges, and a result list is a session too — a list that merely runs out
 * has told the reader nothing about how much there was.
 *
 * And there is no pagination and no infinite scroll. Beyond what fits, the screen
 * says how many were left and asks for a narrower query. Refusing to paginate is
 * the feature: this is a library catalogue, not a search engine, and "here are
 * four hundred results" is the shape of answer this product exists not to give.
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

export function Search({
  query,
  onNavigate,
  onSearch,
}: {
  /**
   * The query, owned by the URL.
   *
   * `/search?q=liberty` has to be a thing you can send someone, so the address is
   * the single source of truth and the input below is seeded from it rather than
   * the other way round. Submitting pushes a new URL and the fetch follows.
   */
  query: string;
  onNavigate: (to: string) => void;
  onSearch: (query: string) => void;
}) {
  /*
   * The draft, re-seeded when the URL changes.
   *
   * Adjusted during render rather than in an effect. Back and forward move the
   * URL, and the box has to follow or the reader is looking at results for one
   * query with another still typed above them — but doing that in an effect
   * paints the stale value first and corrects it on the next frame, which is the
   * cascading render `react-hooks/set-state-in-effect` exists to stop. Setting
   * state during render of the same component is the supported way to reset
   * state when an input changes; React re-runs the render immediately and
   * nothing is committed in between.
   */
  const [draft, setDraft] = useState(query);
  const [seededFrom, setSeededFrom] = useState(query);
  if (seededFrom !== query) {
    setSeededFrom(query);
    setDraft(query);
  }

  /*
   * The answer carries the question it answers.
   *
   * Every other way of doing this needs an effect to clear the previous result
   * when the query changes, and a cleared-result effect is one render behind by
   * construction: for one frame the screen shows results for the old query under
   * the new one. Tagging the answer with its query makes staleness a comparison
   * rather than a lifecycle, so there is no frame in which the wrong thing is on
   * screen and nothing has to be reset.
   */
  const [answer, setAnswer] = useState<{ query: string; result: SearchResult } | null>(null);
  const [failure, setFailure] = useState<{
    query: string;
    message: string;
    offline: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);

  const q = normaliseQuery(query);
  const state = classifyQuery(query);
  const result = answer && answer.query === q ? answer.result : null;
  const error = failure && failure.query === q ? failure : null;
  const loading = state === 'ready' && result === null && error === null;

  useEffect(() => {
    if (state !== 'ready') return;

    /*
     * Abort the previous request rather than flag it.
     *
     * Two searches in quick succession can land out of order, and unlike most
     * races both responses are well-formed — there is nothing in the second
     * result that says it is stale. Tagging by query would be enough to ignore
     * it; aborting also stops the work.
     */
    const controller = new AbortController();

    searchCatalogue(q, { signal: controller.signal })
      .then((r) => {
        if (controller.signal.aborted) return;
        setAnswer({ query: q, result: r });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        // Detail to the console; the reader gets a sentence rather than a SQLSTATE.
        console.error('Search request failed', e);
        setFailure({
          query: q,
          message: e instanceof Error ? e.message : String(e),
          offline: isOfflineFailure(e),
        });
      });

    return () => controller.abort();
  }, [q, state, attempt]);

  const form = (
    <form
      className="search__form"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(normaliseQuery(draft));
      }}
    >
      <label className="field__label" htmlFor="search-input">
        Search the library
      </label>
      <div className="search__row">
        <input
          id="search-input"
          className="field__input"
          type="search"
          name="q"
          value={draft}
          autoComplete="off"
          /*
            No search-as-you-type. It is law 7 applied to text: results that
            rewrite themselves under the reader's hands are a stream, and it
            triples the query volume for no gain a person asked for.
          */
          onChange={(e) => setDraft(e.target.value)}
          placeholder="An idea, a title, an author"
        />
        <button type="submit" className="btn btn--primary">
          Search
        </button>
      </div>
    </form>
  );

  function body() {
    if (state === 'empty') {
      return (
        <>
          <hr className="rule" />
          <p className="meta">What is in here</p>
          <p>
            Every idea the library holds, and every source behind them. Searching matches the words
            in an idea — and then finds the ones close to it in meaning, which is how a search for
            something you half-remember still lands.
          </p>
        </>
      );
    }

    if (state === 'too-short') {
      return <p className="meta">A little more to go on — two characters at least.</p>;
    }

    if (error) {
      return (
        <section role="alert" className="stack">
          <hr className="rule" />
          <h2>Could not search the library.</h2>
          <p>
            {error.offline
              ? 'You appear to be offline. Saved Pulls are still readable in your Library.'
              : 'Something went wrong reaching the library.'}
          </p>
          <p className="meta">{error.message}</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setFailure(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </section>
      );
    }

    if (loading) return <p className="meta">Searching…</p>;
    if (!result) return null;

    if (isEmptyResult(result)) {
      return (
        <>
          <hr className="rule" />
          <h2>Nothing matches “{result.query}”.</h2>
          <p>
            The library is young — {result.counts.sources === 0 ? 'this' : 'that'} idea may simply
            not be in it yet. A shorter phrase, or a word from the idea rather than about it,
            usually finds more.
          </p>
        </>
      );
    }

    return (
      <>
        {/* The count first: how much there is, before any of it. */}
        <p className="search__count">{countLine(result)}</p>
        <hr className="rule" />

        {result.ideas.length > 0 && (
          <>
            <p className="meta">Ideas</p>
            <ol className="search__list">
              {result.ideas.map((idea) => (
                <li key={idea.id} className="search__item">
                  <p className="pull-card__chip">
                    {idea.workTitle}
                    {idea.workYear ? ` · ${idea.workYear}` : ''}
                  </p>
                  <h3 className="search__headline">{idea.headline}</h3>
                  <p className="search__body">{idea.body}</p>
                  <p className="search__actions">
                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => onNavigate(`/pull/${idea.id}`)}
                    >
                      Read it in its source
                    </button>
                    {/*
                      Annotated, never filtered — and stated in words rather than
                      shown in a colour, because colour is never the only signal
                      (design law 5). A reader must be able to find something they
                      read last week; the Delta decides what to serve unbidden, not
                      what may be looked for.
                    */}
                    {idea.alreadyKnown && <span className="meta search__known">You know this</span>}
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}

        {result.sources.length > 0 && (
          <>
            <hr className="rule" />
            <p className="meta">Sources</p>
            <ul className="search__list">
              {result.sources.map((source) => (
                <li key={source.id} className="search__item">
                  <p className="pull-card__chip">{sourceLine(source.kind, source.year)}</p>
                  <h3 className="search__headline">{source.title}</h3>
                  {source.subtitle ? <p className="search__body">{source.subtitle}</p> : null}
                  <p className="search__actions">
                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => onNavigate(`/source/${source.id}`)}
                    >
                      Open the source
                    </button>
                    {source.matchingIdeas > 0 && (
                      <span className="meta">
                        {source.matchingIdeas} matching{' '}
                        {source.matchingIdeas === 1 ? 'idea' : 'ideas'}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}

        {result.alsoClose.length > 0 && (
          <>
            <hr className="rule" />
            {/*
              The half of the search that has no keywords in it. These come from
              averaging the embeddings of the best word-matches and asking the HNSW
              index what sits near that point — stored vectors, no model, nothing
              billed. Kept in their own section because they are a weaker claim
              than a word match and should not be presented as one.
            */}
            <p className="meta">Close to these, in other words</p>
            <ul className="search__list search__list--close">
              {result.alsoClose.map((n) => (
                <li key={n.id} className="search__item">
                  <p className="pull-card__chip">{n.workTitle}</p>
                  <button
                    type="button"
                    className="btn btn--plain search__close-link"
                    onClick={() => onNavigate(`/pull/${n.id}`)}
                  >
                    {n.headline}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* The end is a sentence, not an absence. */}
        <hr className="rule" />
        <p className="meta">{terminalLine(result)}</p>
      </>
    );
  }

  return (
    <section className="stack measure">
      <p className="meta">Search</p>
      {state === 'empty' && <h1>What are you looking for?</h1>}
      {form}
      {body()}
    </section>
  );
}
