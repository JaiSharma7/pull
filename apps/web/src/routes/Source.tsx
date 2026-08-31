import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSourceDelta } from '../lib/api.js';
import { isOfflineFailure } from '../lib/offline.js';
import { anchoredPullId } from '../lib/routes.js';
import { type Highlight, anchor, splitByRanges } from '../lib/highlights.js';
import { createHighlight, deleteHighlight, fetchHighlights } from '../lib/highlights-api.js';
import { fetchRelatedPulls, type RelatedPull } from '../lib/search-api.js';
import { fetchPullLocation, fetchSource, type SourceDetail } from '../lib/source-api.js';
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

/**
 * How an authored edge reads to a person.
 *
 * The enum is `relation_kind` in the database. Anything unrecognised falls through
 * to the raw value rather than being dropped, so a member added by a migration
 * shows up as itself instead of silently disappearing from the page.
 */
const RELATION_LABEL: Record<string, string> = {
  opposes: 'Argues against this',
  elaborates: 'Elaborates on this',
  ancestor: 'This idea came from it',
  descendant: 'Grew out of this idea',
  related: 'Related',
};

/**
 * Where the current selection sits inside one element, as character offsets.
 *
 * The only part of highlighting that must touch the DOM, kept to one function so
 * everything else stays testable in `environment: 'node'`. It measures against
 * `textContent` rather than counting nodes, because the body is rendered as
 * several text runs once anything in it is already marked — so node indices
 * change as highlights accumulate and offsets do not.
 *
 * Selection is keyboard-operable natively (shift with the arrow keys), so this
 * needs no separate keyboard path; the control that acts on it is an ordinary
 * focusable button rather than a floating popover.
 */
function selectionOffsetsIn(
  container: HTMLElement,
): { start: number; end: number; text: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const text = range.toString();
  if (!text.trim()) return null;

  const before = range.cloneRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;

  return { start, end: start + text.length, text };
}

/** Minutes, from the estimate the pipeline stored per Pull. */
function readingMinutes(seconds: number | null): number | null {
  if (seconds === null || seconds <= 0) return null;
  return Math.max(1, Math.round(seconds / 60));
}

export function Source({
  workId,
  summaryId,
  userId,
  onNavigate,
}: {
  workId: string;
  /**
   * The summary a Pull named, when the reader arrived through `/pull/:id`.
   *
   * Without it the page picks a summary of its own accord, and when that differs
   * from the one the Pull belongs to the anchor names an element that is not on the
   * page: a shared link lands at the top of a source whose ideas are not the one
   * that was shared, with every query having succeeded.
   */
  summaryId?: string;
  /**
   * Null for a signed-out visitor, who can read everything here and mark
   * nothing. A highlight is a row keyed to a user; there is no anonymous
   * version of it to offer.
   */
  userId: string | null;
  onNavigate: (to: string) => void;
}) {
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [delta, setDelta] = useState<SourceDelta | null>(null);
  /*
   * Ideas elsewhere in the library that this one is close to.
   *
   * Supplementary, so a failure renders nothing rather than an error: the page's
   * job is this source, and a broken sidebar must not take the source down with
   * it. Empty and failed look the same here on purpose — neither claims there
   * are no related ideas, which is the sentence that would be a lie.
   */
  const [related, setRelated] = useState<RelatedPull[]>([]);
  const [relatedTo, setRelatedTo] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const bodyRefs = useRef<Map<string, HTMLParagraphElement>>(new Map());
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

    fetchSource(workId, summaryId)
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
  }, [workId, summaryId]);

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

  const reloadHighlights = useCallback(() => {
    if (!userId || !detail || detail.pulls.length === 0) return;
    fetchHighlights(
      userId,
      detail.pulls.map((p) => p.id),
    )
      .then(setHighlights)
      // Supplementary: the source reads perfectly well without a reader's marks,
      // and failing to load them must not take the page down.
      .catch((e: unknown) => console.error('Could not load highlights', e));
  }, [userId, detail]);

  useEffect(reloadHighlights, [reloadHighlights]);

  /*
   * Ideas close to the one the reader actually came for.
   *
   * `related_pulls` is anchored on a single Pull, and the honest anchor is the one
   * named by the fragment — a reader who followed a shared `/pull/:id` link came
   * for that idea, not for the source's first. Falls back to the first when there
   * is no anchor, so the section still appears for someone who opened the source
   * directly.
   *
   * Authored `pull_relations` edges come back first and carry a relation kind;
   * the rest are nearest stored embeddings. Neither costs a provider call — the
   * anchor is a column, not a query somebody had to embed.
   */
  useEffect(() => {
    if (!detail || detail.pulls.length === 0) return;
    let live = true;
    const anchored = anchoredPullId(window.location.hash);
    const anchor = detail.pulls.find((p) => p.id === anchored) ?? detail.pulls[0]!;

    fetchRelatedPulls(anchor.id, 5)
      .then((rows) => {
        if (!live) return;
        setRelated(rows);
        setRelatedTo(anchor.headline);
      })
      .catch((e: unknown) => {
        console.error('Related ideas request failed', e);
        /* Supplementary. The source page stands without it. */
      });

    return () => {
      live = false;
    };
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
            ? 'You appear to be offline. This source needs a connection.'
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
                {/*
                  Re-anchored on every render rather than trusting the stored
                  offsets: a highlight whose text has moved follows its words,
                  and one whose text is gone is dropped rather than drawn over
                  whatever now occupies those characters.
                */}
                <p
                  className="source__pull-body"
                  ref={(el) => {
                    if (el) bodyRefs.current.set(p.id, el);
                    else bodyRefs.current.delete(p.id);
                  }}
                >
                  {splitByRanges(
                    p.body,
                    highlights
                      .filter((h) => h.pullId === p.id && h.field === 'body')
                      .map((h) => anchor(p.body, h))
                      .filter((r): r is { start: number; end: number } => r !== null),
                  ).map((seg, i) =>
                    seg.marked ? (
                      <mark key={i} className="source__mark">
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )}
                </p>
                {p.explanation ? <p className="source__pull-more">{p.explanation}</p> : null}
                {p.whyItMatters ? (
                  <p className="source__pull-why">
                    <span className="meta">Why it matters</span> {p.whyItMatters}
                  </p>
                ) : null}
                {minutes ? <p className="meta">{minutes} min</p> : null}

                {userId && (
                  <p className="source__pull-actions">
                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => {
                        const el = bodyRefs.current.get(p.id);
                        if (!el) return;
                        const range = selectionOffsetsIn(el);
                        if (!range) {
                          window.alert('Select some words in this idea first.');
                          return;
                        }
                        const id = globalThis.crypto.randomUUID();
                        // Optimistic, then sent. A highlight that takes a round
                        // trip to appear feels broken at the exact moment the
                        // reader is still looking at what they selected.
                        setHighlights((prev) => [
                          ...prev,
                          { id, pullId: p.id, field: 'body', ...range },
                        ]);
                        window.getSelection()?.removeAllRanges();
                        createHighlight(userId, {
                          id,
                          pullId: p.id,
                          field: 'body',
                          ...range,
                        }).catch((e: unknown) => {
                          console.error('Could not save the highlight', e);
                          reloadHighlights();
                        });
                      }}
                    >
                      Highlight the selection
                    </button>
                    {highlights.some((h) => h.pullId === p.id) && (
                      <button
                        type="button"
                        className="btn btn--plain"
                        onClick={() => {
                          const mine = highlights.filter((h) => h.pullId === p.id);
                          const last = mine[mine.length - 1];
                          if (!last) return;
                          setHighlights((prev) => prev.filter((h) => h.id !== last.id));
                          deleteHighlight(last.id).catch((e: unknown) => {
                            console.error('Could not remove the highlight', e);
                            reloadHighlights();
                          });
                        }}
                      >
                        Remove the last one
                      </button>
                    )}
                  </p>
                )}
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

      {related.length > 0 && (
        <>
          <h2 className="meta source__group">Close to this</h2>
          {relatedTo ? <p className="meta source__related-anchor">{relatedTo}</p> : null}
          <ul className="source__related">
            {related.map((r) => (
              <li key={r.id} className="source__related-item">
                <p className="pull-card__chip">{r.workTitle}</p>
                <button
                  type="button"
                  className="btn btn--plain source__related-link"
                  onClick={() => onNavigate(`/pull/${r.id}`)}
                >
                  {r.headline}
                </button>
                {/*
                  An authored edge and a measured neighbour are different claims and
                  are labelled differently. "Argues against this" is something a
                  person asserted and can be held to; a vector distance is not, and
                  dressing one as the other is how a Counterpull surface starts
                  lying about what it knows.
                */}
                {r.relation ? (
                  <p className="meta source__related-kind">
                    {RELATION_LABEL[r.relation] ?? r.relation}
                    {r.rationale ? ` — ${r.rationale}` : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

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
    fetchPullLocation(pullId)
      .then((found) => {
        if (!live) return;
        // The summary rides along in the query string so the source page renders the
        // one this Pull is actually in, rather than picking another of the work's.
        if (found) onReplace(`/source/${found.workId}?s=${found.summaryId}#p-${pullId}`);
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
