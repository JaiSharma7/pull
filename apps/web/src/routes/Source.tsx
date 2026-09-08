import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { fetchSourceDelta } from '../lib/api.js';
import { isOfflineFailure } from '../lib/offline.js';
import { anchoredPullId } from '../lib/routes.js';
import { isSchemaMismatch, TRANSPORT_ERROR } from '../lib/rpc-error.js';
import { type Highlight, anchor, splitByRanges } from '../lib/highlights.js';
import { createHighlight, deleteHighlight, fetchHighlights } from '../lib/highlights-api.js';
import { fetchRelatedPulls, type RelatedPull } from '../lib/search-api.js';
import { shareCapability, shareLabel, shareNote, shareOrCopy, shareTarget } from '../lib/share.js';
import { askReducer, draftFor, draftQuestion, EMPTY_ASK } from '../lib/questions.js';
import {
  fetchUserQuestions,
  rememberPull,
  retireQuestion,
  type UserQuestion,
} from '../lib/questions-api.js';
import { fetchPullLocation, fetchSource, type SourceDetail } from '../lib/source-api.js';
import { mutationId } from '../lib/submission.js';
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
  supports: 'Supports this',
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
  /*
   * KEYED BY IDEA, all of it, which it was not.
   *
   * `asking` was a pull id and `askPrompt`, `askAnswer`, `askError` and `askBusy` were
   * one value each for the whole page -- so the open flag was per-idea and every value
   * carrying the reader's words was shared. Opening a second idea's form ran the toggle,
   * which cleared the boxes, and a question composed under the first was gone. A save
   * landing while another form was open closed it and wiped it. A refusal on one idea
   * rendered under whichever form happened to be open, or nowhere at all. All three were
   * demonstrated in review.
   *
   * The machine is in `lib/questions.ts` so it can be driven by a test: this suite runs
   * in `environment: 'node'` with no React harness, so a state machine inside a component
   * is one nothing can check, which is exactly how three of these shipped.
   */
  const [ask, dispatchAsk] = useReducer(askReducer, EMPTY_ASK);
  const [questionsFailed, setQuestionsFailed] = useState(false);
  /*
   * THE MUTATION ID BELONGS TO THE DRAFT, NOT TO THE ATTEMPT.
   *
   * Review finding. It was minted inside the send, so a retry after a lost response
   * carried a NEW id -- and `remember_pull` deduplicates on `(user_id,
   * client_mutation_id)`, so a first write it could not report back was invisible to the
   * second. The reader presses Keep twice and owns two copies of one question, which
   * then splits their per-question history in half.
   *
   * Held until the write is confirmed, and cleared when the reader EDITS. An id that
   * outlived an edit would be worse than a fresh one: the RPC would answer with the
   * FIRST question and silently discard the new wording.
   */
  const askMutations = useRef<Record<string, string>>({});
  const bodyRefs = useRef<Map<string, HTMLParagraphElement>>(new Map());
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

  /**
   * Write the question in the box, and put the idea into review.
   *
   * NOT OPTIMISTIC, unlike the highlight above it, and the difference is what failure
   * costs. A highlight that fails to save is a mark that disappears from text still on
   * screen; the reader sees it go and can select again. A question is a sentence they
   * composed, and showing it as saved before it is would let them navigate away from
   * words that were never stored. So the box holds what they typed until the row exists.
   *
   * The mutation id is minted BEFORE the send, which is what makes a retry after a
   * timeout safe: `remember_pull` matches on `(user_id, client_mutation_id)` and returns
   * the first call's question rather than writing a second one.
   */
  const saveQuestion = useCallback(
    async (pullId: string) => {
      if (ask.busyFor) return;
      const draft = draftQuestion(draftFor(ask, pullId));
      if (!draft.ok) {
        dispatchAsk({ type: 'failed', pullId, message: draft.error });
        return;
      }

      dispatchAsk({ type: 'sending', pullId });
      try {
        await rememberPull(pullId, {
          prompt: draft.prompt,
          answer: draft.answer,
          kind: draft.kind,
          mutationId: (askMutations.current[pullId] ??= mutationId()),
        });
        delete askMutations.current[pullId];
        dispatchAsk({ type: 'kept', pullId });
        reloadQuestions();
      } catch (e: unknown) {
        /*
         * A REQUEST THAT NEVER LEFT THE DEVICE IS NOT A CONSTRAINT MESSAGE. postgrest-js
         * resolves rather than rejects on a dead connection, so `rpcError` hands back an
         * Error whose `message` is the verbatim "TypeError: Failed to fetch" -- which is
         * what a reader on a train was shown under a form they had just filled in. The
         * name is what tells the two apart, and every other write path in this app
         * branches on it. Review finding.
         */
        dispatchAsk({
          type: 'failed',
          pullId,
          message:
            e instanceof Error && e.name === TRANSPORT_ERROR
              ? 'That has not reached your account — you look offline. It stays in the box.'
              : e instanceof Error
                ? e.message
                : 'That question did not reach your account.',
        });
      }
    },
    [ask, reloadQuestions],
  );

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
            const minutes = readingMinutes(p.estimatedReadSeconds);
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
                    {/* REMEMBER THIS. The other half of what a reader can do with an
                        idea they are looking at: mark the words, or write the question
                        they want to be asked about them later.

                        `remember_pull` does three things at once, and the copy below
                        says all three, because a button that silently schedules
                        something is a button that surprises people: it stores the
                        question, saves the idea, and puts it into review. */}
                    <button
                      type="button"
                      className="btn btn--plain"
                      aria-expanded={ask.openFor === p.id}
                      aria-controls={`ask-form-${p.id}`}
                      onClick={() => {
                        /*
                         * A DISMISSAL DROPS THIS IDEA'S DRAFT AND ITS ID TOGETHER, and
                         * opening a different idea drops neither -- which is the whole
                         * correction. The id has to go with the words for the reason the
                         * ref carries: a Keep whose response was lost may still have
                         * committed, so an id that outlives the sentence it was minted
                         * for makes the RPC answer with the FIRST question and discard
                         * the new wording.
                         */
                        if (ask.openFor === p.id) delete askMutations.current[p.id];
                        dispatchAsk({ type: 'toggle', pullId: p.id });
                      }}
                    >
                      {ask.openFor === p.id ? 'Never mind' : 'Remember this'}
                    </button>
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

                {userId && ask.openFor === p.id && (
                  <div className="source__ask" id={`ask-form-${p.id}`}>
                    <label className="field__label" htmlFor={`ask-prompt-${p.id}`}>
                      What should this idea ask you?
                    </label>
                    <textarea
                      id={`ask-prompt-${p.id}`}
                      className="field__textarea"
                      rows={2}
                      value={draftFor(ask, p.id).prompt}
                      aria-invalid={Boolean(ask.errors[p.id])}
                      aria-describedby={ask.errors[p.id] ? `ask-error-${p.id}` : undefined}
                      onChange={(e) => {
                        // The id goes with the wording it was minted for. Editing after a
                        // failed Keep is a NEW question, and reusing the id would have the
                        // RPC answer with the old one.
                        delete askMutations.current[p.id];
                        dispatchAsk({
                          type: 'edit',
                          pullId: p.id,
                          field: 'prompt',
                          value: e.target.value,
                        });
                      }}
                      placeholder="What does an obstacle become?"
                    />
                    <label className="field__label" htmlFor={`ask-answer-${p.id}`}>
                      The answer
                    </label>
                    {/* Sentence case and not `.meta`, which is mono and UPPERCASED. A
                        label is two or three words and reads fine shouted; this is a
                        sentence, and CLAUDE.md's law 1 leaves typography to do the work
                        rather than raising the app's voice at the reader mid-explanation.
                        (Named, because `docs/design.md` numbers its own laws differently
                        and a PR in this series was already pulled up for citing the
                        wrong one.) */}
                    <p className="source__ask-hint" id={`ask-answer-hint-${p.id}`}>
                      Optional, and kept with the question so you can read it back here. Review
                      shows you the idea and you mark yourself either way.
                    </p>
                    <textarea
                      id={`ask-answer-${p.id}`}
                      className="field__textarea"
                      aria-describedby={`ask-answer-hint-${p.id}`}
                      rows={2}
                      value={draftFor(ask, p.id).answer}
                      onChange={(e) => {
                        delete askMutations.current[p.id];
                        dispatchAsk({
                          type: 'edit',
                          pullId: p.id,
                          field: 'answer',
                          value: e.target.value,
                        });
                      }}
                    />
                    {/* `.source__ask-error`, not `.meta`. The hint two elements up argues
                        that reader-facing prose must not be mono and uppercased, and the
                        refusal was rendering in exactly that — so an error looked
                        identical to the neutral sentence beside it and `role="alert"` was
                        the only thing distinguishing them, which is a signal for screen
                        readers and none at all for everyone else. The accent plus a rule,
                        so it differs by more than hue. */}
                    {ask.errors[p.id] && (
                      <p className="source__ask-error" id={`ask-error-${p.id}`} role="alert">
                        {ask.errors[p.id]}
                      </p>
                    )}
                    <p>
                      <button
                        type="button"
                        className="btn"
                        aria-disabled={ask.busyFor === p.id}
                        aria-describedby={`ask-consequence-${p.id}`}
                        onClick={() => void saveQuestion(p.id)}
                      >
                        {ask.busyFor === p.id ? 'Keeping…' : 'Keep this question'}
                      </button>{' '}
                      {/* Described BY the button, not merely next to it: a screen-reader
                          user tabbing here heard "Keep this question, button" and none of
                          what it silently does. */}
                      <span className="meta" id={`ask-consequence-${p.id}`}>
                        Keeping it also saves this idea and puts it in your review.
                      </span>
                    </p>
                  </div>
                )}

                {userId && ask.keptFor === p.id && ask.openFor !== p.id && (
                  <p className="meta" role="status">
                    {/* NOT "from tomorrow", and not "here". `remember_pull` inserts
                        `knowledge_states` with `on conflict do nothing`, so an idea
                        already in review keeps the schedule it had -- which may be two
                        months out. `questions-api.ts` says so in as many words while this
                        line promised otherwise, and the RPC returns nothing the screen
                        could use to tell. And it is Review that asks, not this page. */}
                    Kept. It will come up in your reviews.
                  </p>
                )}

                {userId && questionsFailed && mine.length === 0 && (
                  <p className="meta">Could not load your questions for this idea.</p>
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
                                dispatchAsk({
                                  type: 'failed',
                                  pullId: p.id,
                                  message: 'That question is still in your review.',
                                });
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
