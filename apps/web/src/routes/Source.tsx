import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PullCard, clampDepth, depthLevels, textAtDepth } from '@wap/ui';
import { RememberThis } from '../components/RememberThis.js';
import { fetchSavedAmong, fetchSourceDelta, savePull, unsavePull } from '../lib/api.js';
import { isOfflineFailure } from '../lib/offline.js';
import { isPlaying, isQueued, usePlayer } from '../components/PlayerProvider.js';
import type { Track } from '../lib/player.js';
import { speechSupported } from '../lib/speech.js';
import { anchoredPullId } from '../lib/routes.js';
import { isSchemaMismatch } from '../lib/rpc-error.js';
import { type Highlight, anchor, splitByRanges } from '../lib/highlights.js';
import { createHighlight, deleteHighlight, fetchHighlights } from '../lib/highlights-api.js';
import { fetchRelatedPulls, type RelatedPull } from '../lib/search-api.js';
import { relationLabel } from '../lib/relations.js';
import { shareCapability, shareLabel, shareNote, shareOrCopy, shareTarget } from '../lib/share.js';
import { fetchUserQuestions, retireQuestion, type UserQuestion } from '../lib/questions-api.js';
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

/**
 * Whether this browser can speak, decided once — as `Feed` and `Library` decide
 * it. A control that cannot work is withheld rather than drawn dead.
 */
const CAN_SPEAK = speechSupported();

/**
 * How deep a source page opens.
 *
 * The feed opens at the claim, because a feed of full arguments is not a feed.
 * A reader who has navigated to a source has already said they want the long
 * version, so this opens at the deepest stop the card has; `clampDepth` inside
 * `PullCard` brings it in for a Pull with fewer.
 *
 * The stored `estimated_read_seconds` is no longer printed beside the idea. The
 * dial's labels are computed from the words actually on screen at 210wpm, which
 * `packages/ui/src/depth.ts` raises to a law precisely so that two durations
 * cannot disagree in front of a reader.
 */
const READING_DEPTH = 3;

/** Shared, because a new Set every render would be a new identity every render. */
const EMPTY_SAVED: ReadonlySet<string> = new Set();

/**
 * The way out of this page, which is not the same door for everyone.
 *
 * `/` is the feed only for a reader who has one: the shell treats every
 * non-public path as gated, so `onNavigate('/')` from a signed-out visitor
 * renders the sign-in screen. "Back to the feed" therefore named a destination
 * that visitor does not have and delivered a wall — the exact thing guest
 * reading exists to remove. The catalogue is public, it is where a visitor most
 * likely arrived from, and it is what the sign-in screen itself offers them.
 */
function BackControl({
  userId,
  onNavigate,
}: {
  userId: string | null;
  onNavigate: (to: string) => void;
  /**
   * Report this source's name upward, so the browser tab and the history entry can
   * say what the page is.
   *
   * `App` knows the address and not the title — the title only exists once the
   * request comes back — so it arrives this way rather than being derived.
   */
  onTitle?: (title: string | null) => void;
}) {
  const signedOut = userId === null;
  return (
    <button
      type="button"
      className="btn btn--plain"
      onClick={() => onNavigate(signedOut ? '/explore' : '/')}
    >
      {signedOut ? 'Browse the catalogue' : 'Back to the feed'}
    </button>
  );
}

export function Source({
  workId,
  summaryId,
  userId,
  onNavigate,
  onTitle,
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
  /**
   * Report this source's name upward, so the browser tab and the history entry can
   * say what the page is.
   *
   * `App` knows the address and not the title — the title only exists once the
   * request comes back — so it arrives this way rather than being derived.
   */
  onTitle?: (title: string | null) => void;
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
  /*
   * The reader's own questions on the ideas of this source, and the one they are
   * writing.
   *
   * The form belongs to one idea, and so does everything typed into it. An earlier
   * version of this note said a pull id for the open flag was what achieved that -- it
   * was half of it, and the half that did not carry the reader's words.
   */
  /*
   * THE ROWS CARRY WHOSE THEY ARE.
   *
   * `<Source>` is keyed by source, not by account, so signing out and back in as somebody
   * else in the same tab leaves this state in place, and `reloadQuestions` early-returns
   * on a missing `userId` without clearing it — for the length of the refetch the previous
   * account's questions, which are prose they wrote, would be on screen. Stored beside the
   * rows rather than reset in an effect, because `react-hooks/set-state-in-effect` refuses
   * that (rightly: it is a cascading render for something the render can simply derive).
   */
  const [myQuestions, setMyQuestions] = useState<{ userId: string | null; rows: UserQuestion[] }>({
    userId: null,
    rows: [],
  });
  const [questionsFailed, setQuestionsFailed] = useState(false);
  /*
   * A retire that was refused, and which idea it was about.
   *
   * It used to be reported through the ask form's own error slot, which the form
   * no longer owns -- `components/RememberThis.tsx` holds one draft and knows
   * nothing about a question that already exists. Said rather than only logged: a
   * row that silently reappears reads as a bug rather than as a refusal, and if
   * the reload fails too the reader is left believing a question is retired while
   * Review keeps asking it.
   */
  const [retireFailed, setRetireFailed] = useState<string | null>(null);
  /*
   * The element a selection is measured against, per idea.
   *
   * It used to be the page's own `<p class="source__pull-body">`. The body now
   * lives inside `PullCard`, which owns that paragraph, so the mark-bearing span
   * `renderBody` returns is what carries the ref instead. `selectionOffsetsIn`
   * measures against `textContent` from the element it is handed, so a span
   * wrapping exactly the body text gives exactly the same offsets the paragraph
   * did — and a Pull whose dial is turned below the claim has no such element,
   * which is why the highlight control checks for one before offering itself.
   */
  const bodyRefs = useRef<Map<string, HTMLElement>>(new Map());

  /*
   * A source page is a reading view, so it reads at the deepest stop and keeps one
   * depth for the screen — the reasoning `Feed` and `Library` give for keeping one:
   * it is a preference about how to read, not a property of any single idea.
   */
  const [depth, setDepth] = useState(READING_DEPTH);

  /**
   * The idea whose Highlight control was pressed with nothing selected.
   *
   * One at a time, and cleared by the next successful mark: two ideas cannot both
   * be waiting for a selection, because there is one selection.
   */
  const [highlightHint, setHighlightHint] = useState<string | null>(null);

  /** The listening queue, which lives above the shell and outlives this page. */
  const player = usePlayer();

  /*
   * Whether each idea's claim is on screen at the current depth, computed once.
   *
   * Highlighting measures a selection against the body, and the dial can turn the body
   * off — the shortest stop is the headline alone — so the control is withheld there
   * rather than left to fail silently on a missing ref. `depthLevels` tokenises every
   * field of every Pull, and doing it inside the map ran it per card on every render,
   * including renders about a share note or a saved id. Keyed on the two things it
   * actually depends on.
   *
   * Above the early returns, with the other hooks: `pulls` only exists after `detail`
   * has loaded, and a hook that runs only on the renders where it does is a hook that
   * changes order.
   */
  const shownAtDepth = useMemo(() => {
    const shown = new Map<string, boolean>();
    for (const p of detail?.pulls ?? []) {
      const levels = depthLevels({ ...p, hasSource: false });
      shown.set(
        p.id,
        levels.slice(0, clampDepth(depth, levels) + 1).some((l) => l.key === 'claim'),
      );
    }
    return shown;
  }, [detail, depth]);

  /*
   * What this reader has already kept, so the card's Save control says which way
   * it points. Fetched once per reader rather than per idea; a failure is silent
   * and leaves every card unsaved, which is recoverable in one press and is the
   * right way for a non-essential decoration to fail.
   */
  const [savedIds, setSaved] = useState<Set<string>>(new Set());
  /*
   * Read through the signed-in check rather than cleared on sign-out. Emptying it
   * in the effect would be a `setState` synchronously inside one — a cascading
   * render the lint rule refuses, and for good reason — and there is nothing to
   * clear: a visitor is offered no Save control at all, so a set left over from a
   * previous session is never consulted.
   */
  const saved = userId ? savedIds : EMPTY_SAVED;
  useEffect(() => {
    const ids = detail?.pulls.map((p) => p.id) ?? [];
    if (!userId || ids.length === 0) return;
    let cancelled = false;
    /*
     * Asked for THESE ideas, not for the whole library. `fetchSavedPullIds` walks all
     * of `saved_items` a hundred rows at a time — law 3 promises unlimited stashing, so
     * a reader with five thousand saves paid fifty sequential round trips to decorate
     * eighteen Save controls.
     */
    fetchSavedAmong(userId, ids)
      .then((kept) => {
        if (!cancelled) setSaved(kept);
      })
      .catch(() => {
        // A Save control that opens unpressed is wrong about a kept idea until the
        // next press, and pressing it is idempotent (`savePull` swallows 23505).
      });
    return () => {
      cancelled = true;
    };
  }, [userId, detail]);
  /*
   * Four states, not two. `null` detail with no error is loading; a resolved `null`
   * from `fetchSource` is a work that does not exist; an error is an error. Review
   * has already cost this repo one screen that reported failure as good news, and
   * the fix there was exactly this distinction.
   */
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * Whether the app and the database disagree about what exists, rather than a fault.
   *
   * Kept apart from `error` because it changes what is true, not just what is said:
   * every other failure here is worth trying again, and this one will fail identically
   * every time until somebody deploys something. Which somebody, and which direction,
   * the error does not say — see `isSchemaMismatch` — so the sentence below does not
   * guess, and the command goes to the console where an operator will find it.
   */
  const [schemaMismatch, setSchemaMismatch] = useState(false);
  const [offline, setOffline] = useState(false);
  /*
   * What the last share did, and which idea it was for.
   *
   * `shareOrCopy` reports one of three outcomes and this page discarded it: the
   * clipboard path copied a link with no confirmation, and a browser that
   * refused the clipboard produced nothing at all — indistinguishable from a
   * button that does not work. Per Pull, because the control is.
   */
  const [shareStatus, setShareStatus] = useState<{ pullId: string; note: string } | null>(null);

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
        // The summary's own title where it has one, the work's otherwise — the same
        // choice the heading makes, so the tab and the page agree.
        onTitle?.(d.summaryTitle ?? d.work.title);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setOffline(isOfflineFailure(e));
        const mismatch = isSchemaMismatch(e);
        setSchemaMismatch(mismatch);
        if (mismatch) {
          // The operator's half. Not in the page: /source/:id is reachable signed out,
          // so a CLI command there is stack detail shown to every visitor, aimed at
          // somebody who is not among them.
          console.warn(
            'This deployment asked for something the database does not have. If the ' +
              'database is behind: `supabase db push`. If a migration has just been ' +
              "applied: `notify pgrst, 'reload schema'`. If the page is an old cached " +
              'bundle: reload.',
            e,
          );
        }
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
  }, [onTitle, workId, summaryId]);

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

  /*
   * Which load of the highlights is still the truth.
   *
   * `reloadHighlights` is called from three places — the effect below and both
   * write failures — and it replaces the array wholesale. So a load that started
   * before an optimistic insert resolves after it and takes that highlight back
   * off the screen even though the insert succeeded, returning only on a
   * remount: a mark vanishing while the reader is still looking at the words
   * they marked. Every load takes a ticket, and every local change to the array
   * takes one too, which is what makes the loads in flight stale.
   *
   * The counter is never reset, so a ticket issued before a remount cannot
   * collide with one issued after it. Whether there is still a screen to answer
   * is the separate flag: the `related` effect below needs only that and uses a
   * plain `live`, but this cannot live inside one effect run — two of its three
   * callers are event handlers.
   */
  const questionLoad = useRef(0);
  const highlightLoad = useRef(0);
  const highlightsLive = useRef(true);

  /** Invalidate the loads in flight, and take the ticket for a new one. */
  const claimQuestionLoad = useCallback(() => {
    questionLoad.current += 1;
    return questionLoad.current;
  }, []);

  const claimHighlightLoad = useCallback(() => {
    highlightLoad.current += 1;
    return highlightLoad.current;
  }, []);

  const setHighlightsLive = useCallback((live: boolean) => {
    highlightsLive.current = live;
  }, []);

  /*
   * Set on both edges rather than only torn down: StrictMode mounts, unmounts
   * and mounts again, so a one-way flag would leave the second mount unable to
   * load anything at all — in development only, which is the worst place for it.
   */
  useEffect(() => {
    setHighlightsLive(true);
    return () => setHighlightsLive(false);
  }, [setHighlightsLive]);

  const reloadHighlights = useCallback(() => {
    if (!userId || !detail || detail.pulls.length === 0) return;
    const ticket = claimHighlightLoad();
    fetchHighlights(
      userId,
      detail.pulls.map((p) => p.id),
    )
      .then((rows) => {
        if (highlightsLive.current && ticket === highlightLoad.current) setHighlights(rows);
      })
      // Supplementary: the source reads perfectly well without a reader's marks,
      // and failing to load them must not take the page down.
      .catch((e: unknown) => console.error('Could not load highlights', e));
  }, [userId, detail, claimHighlightLoad]);

  useEffect(reloadHighlights, [reloadHighlights]);

  const reloadQuestions = useCallback(() => {
    if (!userId || !detail || detail.pulls.length === 0) return;
    const ticket = claimQuestionLoad();
    fetchUserQuestions(detail.pulls.map((p) => p.id))
      .then((rows) => {
        // Review finding. Saving a question reloads while the page's first load may
        // still be in flight, and whichever answered LAST won regardless of which
        // snapshot it read -- so a question just kept could vanish until the page was
        // remounted. An optimistically retired one coming back is the same hazard and
        // is NOT closed by this line, which an earlier version of this comment claimed:
        // a ticket orders reloads against each other, and a local edit to the array is
        // only covered by claiming one itself. The Retire below does.
        if (ticket === questionLoad.current) {
          setMyQuestions({ userId, rows });
          setQuestionsFailed(false);
        }
      })
      // Supplementary in the same sense the highlights are: the source reads perfectly
      // well without the reader's own questions, and failing to load them must not take
      // the page down.
      .catch((e: unknown) => {
        console.error('Could not load your questions', e);
        // SAID, because its absence is a claim. The list is headed "Your question about
        // this idea" and is hidden when empty, so a failed load reads as "you have
        // written none here" -- which may be false, and this is the only screen that can
        // retire one.
        if (ticket === questionLoad.current) setQuestionsFailed(true);
      });
  }, [userId, detail, claimQuestionLoad]);

  useEffect(reloadQuestions, [reloadQuestions]);

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

  /*
   * The share, and what it did.
   *
   * Cleared before the attempt so a previous "Link copied." cannot stand in
   * front of a share that has just failed — the reader would take the older
   * sentence as the answer to the newer press.
   */
  async function share(pullId: string, headline: string) {
    setShareStatus(null);
    const outcome = await shareOrCopy(
      shareTarget({
        origin: window.location.origin,
        pullId,
        headline,
        workTitle: detail ? (detail.summaryTitle ?? detail.work.title) : null,
      }),
    );
    const note = shareNote(outcome);
    setShareStatus(note ? { pullId, note } : null);
  }

  /*
   * Keep an idea, or stop keeping it.
   *
   * Optimistic, and rolled back on failure, for the reason a highlight is: the
   * reader is looking at the control they just pressed. `savePull` treats a
   * duplicate as success, so a Save that raced a stale `saved` set still ends in
   * the state the press asked for.
   */
  async function onSave(pullId: string) {
    if (!userId) return;
    const wasSaved = saved.has(pullId);
    setSaved((prev) => {
      const next = new Set(prev);
      if (wasSaved) next.delete(pullId);
      else next.add(pullId);
      return next;
    });
    try {
      if (wasSaved) await unsavePull(pullId, userId);
      else await savePull(pullId, userId);
    } catch {
      setSaved((prev) => {
        const next = new Set(prev);
        if (wasSaved) next.add(pullId);
        else next.delete(pullId);
        return next;
      });
    }
  }

  if (missing) {
    return (
      <section className="measure">
        <h1 className="prose__heading">Not found</h1>
        <p>There is no source here. It may have been retired since you last saw it.</p>
        <BackControl userId={userId} onNavigate={onNavigate} />
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
            : schemaMismatch
              ? 'This page asked the library for something it does not have — the app and the ' +
                'database are out of step. Nothing you can do will change that, and trying ' +
                'again will not either; it needs whoever runs this deployment.'
              : 'Something went wrong reaching the library.'}
        </p>
        <p className="meta">{error}</p>
        <BackControl userId={userId} onNavigate={onNavigate} />
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="measure">
        <p className="meta" role="status">
          Loading…
        </p>
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

      {/*
        The byline and the link to the original — the first outbound source link this
        app has ever had.

        The README has said "every idea is anchored to a real source you can open"
        since round 1 and it was not true: there was no `href` to any original
        anywhere, and `works` had no column that could hold one. That is not a copy
        problem. Law 4 is "analysis, not reproduction", and the argument for why
        publishing commentary is fair rather than substitutive is precisely that it
        sends the reader to the source. A summary of a book with no author credited and
        nothing linking out is the artefact that argument disclaims.

        Rendered together and immediately under the title, because that is where a
        citation belongs — putting it at the foot of the page would make it something
        the reader finds after deciding, rather than while.

        Both are optional and independently so. `source_url` is null for every work
        generated before the column existed and for any job that supplied pasted text;
        `authors` is empty wherever nothing has credited one yet. The page renders
        without either rather than assuming.

        `rel="noreferrer noopener"` matches the one other external link in the app
        (Colophon): `noopener` because a target-blank link otherwise hands the opened
        page a live `window.opener` reference back into this one.
      */}
      {(work.authors.length > 0 || work.sourceUrl) && (
        <p className="meta source__attribution">
          {work.authors.length > 0 && <span>{work.authors.join(' · ')}</span>}
          {work.authors.length > 0 && work.sourceUrl && <span aria-hidden="true"> · </span>}
          {work.sourceUrl && (
            <a href={work.sourceUrl} target="_blank" rel="noreferrer noopener">
              Read the original
            </a>
          )}
        </p>
      )}

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
            // Filtered once. This used to be a `.some()` guard followed by a `.filter()`
            // inside an immediately-invoked function -- and that IIFE runs during render,
            // so `react-hooks/refs` traced the ticket ref `reloadQuestions` now touches
            // through it and refused the file. Two passes became one, and the rule can
            // see that an `onClick` is not render.
            // Only this reader's, and only once they have been loaded for THIS account.
            const mine =
              myQuestions.userId === userId
                ? myQuestions.rows.filter((q) => q.pullId === p.id)
                : [];
            const bodyShown = shownAtDepth.get(p.id) ?? false;
            const track = (): Track => ({
              id: p.id,
              title: work.title,
              text: textAtDepth({ ...p, hasSource: false }, depth),
            });
            return (
              <li key={p.id} id={`p-${p.id}`} className="source__pull">
                {/*
                  The same card the feed draws, because this is the same idea.

                  The page used to render its own headline and paragraphs, so a
                  reader who arrived from a shared link met a different object from
                  the one they had been reading a moment earlier — no dial, no
                  Listen, no Save, and a body they could highlight but not keep.

                  `onOpenSource` is deliberately absent: the reader is already on
                  the source, so the dial stops at the full argument rather than
                  offering a door to the page it is on.
                */}
                <PullCard
                  source={{ title: work.title, kind: work.kind, year: work.year }}
                  headline={p.headline}
                  body={p.body}
                  whyItMatters={p.whyItMatters}
                  explanation={p.explanation}
                  sourceTrail={detail.summaryTitle}
                  depth={depth}
                  onDepthChange={setDepth}
                  saved={saved.has(p.id)}
                  onSave={userId ? () => void onSave(p.id) : undefined}
                  listening={isPlaying(player.state, p.id)}
                  onListen={
                    CAN_SPEAK
                      ? () => {
                          if (isPlaying(player.state, p.id)) player.stop();
                          else player.playNow(track());
                        }
                      : undefined
                  }
                  queued={isQueued(player.state, p.id)}
                  onQueue={
                    CAN_SPEAK
                      ? () => {
                          if (isQueued(player.state, p.id)) player.remove(p.id);
                          else player.enqueue([track()]);
                        }
                      : undefined
                  }
                  /*
                    Re-anchored on every render rather than trusting the stored
                    offsets: a highlight whose text has moved follows its words,
                    and one whose text is gone is dropped rather than drawn over
                    whatever now occupies those characters.

                    Inline content only — this is rendered inside the card's own
                    paragraph — so the marks come back wrapped in a span, which is
                    also what carries the ref the selection is measured against.
                  */
                  renderBody={(text, field) =>
                    field === 'body' ? (
                      <span
                        ref={(el) => {
                          if (el) bodyRefs.current.set(p.id, el);
                          else bodyRefs.current.delete(p.id);
                        }}
                      >
                        {splitByRanges(
                          text,
                          highlights
                            .filter((h) => h.pullId === p.id && h.field === 'body')
                            .map((h) => anchor(text, h))
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
                      </span>
                    ) : (
                      text
                    )
                  }
                />

                <p className="source__pull-actions">
                  {/*
                    Share is offered to everyone, including a signed-out visitor:
                    the link they would send opens on the idea now, and handing
                    one along needs no account. Highlighting does — a highlight is
                    a row keyed to a user, and there is no anonymous version of it.
                  */}
                  <button
                    type="button"
                    className="btn btn--plain"
                    onClick={() => void share(p.id, p.headline)}
                  >
                    {shareLabel(shareCapability(navigator))}
                  </button>
                  {shareStatus?.pullId === p.id ? (
                    <>
                      {' '}
                      <span className="meta" role="status">
                        {shareStatus.note}
                      </span>
                    </>
                  ) : null}
                </p>

                {userId && bodyShown && (
                  <p className="source__pull-actions">
                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => {
                        const el = bodyRefs.current.get(p.id);
                        if (!el) return;
                        const range = selectionOffsetsIn(el);
                        if (!range) {
                          // On the screen, beside the control, not in a modal. The
                          // last of the five native dialogs `docs/contributing-map.md`
                          // lists: `window.alert` blocks, cannot be read in the app's
                          // voice, and on a phone is a system sheet that looks like it
                          // came from somewhere else — over a message whose whole
                          // content is "look at the thing behind me".
                          setHighlightHint(p.id);
                          return;
                        }
                        setHighlightHint(null);
                        const id = globalThis.crypto.randomUUID();
                        // Optimistic, then sent. A highlight that takes a round
                        // trip to appear feels broken at the exact moment the
                        // reader is still looking at what they selected — and
                        // any load already in flight predates this mark, so it
                        // is no longer allowed to answer for the array.
                        claimHighlightLoad();
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
                    </button>{' '}
                    {highlights.some((h) => h.pullId === p.id) && (
                      <button
                        type="button"
                        className="btn btn--plain"
                        onClick={() => {
                          const mine = highlights.filter((h) => h.pullId === p.id);
                          const last = mine[mine.length - 1];
                          if (!last) return;
                          // Same reasoning as the insert: a load in flight would
                          // otherwise put this one back.
                          claimHighlightLoad();
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

                {highlightHint === p.id ? (
                  <p className="meta" role="status">
                    Select some words in this idea first, then press Highlight.
                  </p>
                ) : null}

                {/* REMEMBER THIS. The other half of what a reader can do with an
                    idea they are looking at: mark the words, or write the question
                    they want to be asked about them later.

                    Lifted into `components/RememberThis.tsx` so the Library can offer
                    the same thing on an imported highlight. Everything that made this
                    careful -- the submission id that goes with the wording, the
                    not-optimistic save, the transport error that is not a constraint
                    message -- moved with it. */}
                {userId && <RememberThis pullId={p.id} onKept={reloadQuestions} idPrefix="ask" />}

                {userId && questionsFailed && mine.length === 0 && (
                  <p className="meta">Could not load your questions for this idea.</p>
                )}

                {retireFailed === p.id && (
                  <p className="source__ask-error" role="alert">
                    That question is still in your review.
                  </p>
                )}

                {userId && mine.length > 0 && (
                  <div className="source__ask-list">
                    <p className="meta">
                      {mine.length === 1
                        ? 'Your question about this idea'
                        : `Your ${mine.length} questions about this idea`}
                    </p>
                    <ul>
                      {mine.map((q) => (
                        <li key={q.id}>
                          {q.prompt}
                          {/* THE ANSWER THEY TYPED, SHOWN BACK TO THEM.
                                  Review finding: supplying one stores the question as a
                                  `short_answer`, and nothing put those words in front of
                                  the reader again -- the field asked for something and
                                  then swallowed it. Review reveals the idea's own body on
                                  this release and 3d is what renders the reader's answer
                                  against it; until then, this is where they can read what
                                  they wrote. */}
                          {q.answer && <span className="source__ask-answer">{q.answer}</span>}{' '}
                          <button
                            type="button"
                            className="btn btn--plain"
                            aria-label={`Retire: ${q.prompt}`}
                            onClick={() => {
                              // Optimistic here, unlike the write: removing a row
                              // from a list the reader is looking at is reversible
                              // by the reload in the catch, and a Retire that takes
                              // a round trip to disappear reads as a dead button.
                              //
                              // AND IT TAKES A TICKET, which it did not. Both reviewers
                              // demonstrated the same sequence: a reload is already in
                              // flight (saving a question starts one), the reader retires
                              // an older question, the write lands, and then the earlier
                              // reload resolves and repaints its pre-retire snapshot. The
                              // question comes back and the button reads as dead. The
                              // ticket comment above claimed this was already covered; a
                              // ticket only orders reloads against each other, so every
                              // local change to the array has to claim one too -- which is
                              // what both highlight mutations do, ten lines apart.
                              claimQuestionLoad();
                              setRetireFailed(null);
                              setMyQuestions((prev) => ({
                                ...prev,
                                rows: prev.rows.filter((x) => x.id !== q.id),
                              }));
                              retireQuestion(q.id).catch((e: unknown) => {
                                console.error('Could not retire the question', e);
                                // Said, not only logged: a row that silently reappears
                                // reads as the bug above rather than as a refusal, and if
                                // the reload fails too the reader is left believing a
                                // question is retired while Review keeps asking it.
                                setRetireFailed(p.id);
                                reloadQuestions();
                              });
                            }}
                          >
                            Retire
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
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
                  lying about what it knows. And an edge is read from the side the
                  reader is standing on: `direction` says which, and the two maps in
                  `lib/relations.ts` say what it means from there.
                */}
                {r.relation ? (
                  <p className="meta source__related-kind">
                    {relationLabel(r.relation, r.direction)}
                    {r.rationale ? ` — ${r.rationale}` : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="source__foot">
        <BackControl userId={userId} onNavigate={onNavigate} />
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
  userId,
  onReplace,
  onNavigate,
}: {
  pullId: string;
  /** Null for a visitor, for whom "back" is the catalogue rather than the feed. */
  userId: string | null;
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
        <BackControl userId={userId} onNavigate={onNavigate} />
      </section>
    );
  }

  return (
    <section className="measure">
      <p className="meta">Finding that Pull…</p>
    </section>
  );
}
