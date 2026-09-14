import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Enough, PullCard, textAtDepth } from '@wap/ui';
import { Interrupt, type InterruptAnswer } from '../components/Interrupt.js';
import * as api from '../lib/api.js';
import {
  cachePulls,
  drainPending,
  hasPending,
  isOfflineFailure,
  onPendingQueued,
  onReconnect,
  queueIfOffline,
  queueMutation,
  readCachedPulls,
} from '../lib/offline.js';
import { createDwellTracker, MIN_DWELL_MS } from '../lib/dwell.js';
import { isPlaying, isQueued, usePlayer } from '../components/PlayerProvider.js';
import type { Track } from '../lib/player.js';
import { IN_VIEW_THRESHOLDS, isGenuinelyInView } from '../lib/in-view.js';
import { appendPage, weave, type Item, type LoadedFeed } from '../lib/feed-items.js';
import { type ReplayPort, replayWrite } from '../lib/replay.js';
import { loadSession, persist, resetSession } from '../lib/session.js';
import { shareCapability, shareLabel, shareNote, shareOrCopy, shareTarget } from '../lib/share.js';
import { speechSupported } from '../lib/speech.js';
import * as stashApi from '../lib/stash-api.js';
import { mutationId, nextSubmissionStamp } from '../lib/submission.js';
import { getCurrentUserId } from '../lib/supabase.js';
import type { FeedRow } from '../lib/types.js';

/** Retry schedule for writes queued while the browser is still online. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Whether this browser can speak at all, decided once.
 *
 * `speechSupported()` is a capability, not state: it cannot change between renders,
 * and calling it per card per render would be the same answer twenty times over.
 * Where it is false the Listen control is not rendered at all rather than rendered
 * dead — a button that silently does nothing is the one way to make a free feature
 * feel broken (law 3).
 */
const CAN_SPEAK = speechSupported();
const SHARE_LABEL = shareLabel(shareCapability(navigator));

/**
 * The calls a queued write replays into.
 *
 * Named once here rather than built per drain, and handed to `replayWrite` as a
 * port so that the mapping itself — which kind becomes which call — stays
 * testable without a Supabase client.
 */
const REPLAY_PORT: ReplayPort = {
  savePull: api.savePull,
  unsavePull: api.unsavePull,
  recordRead: api.recordRead,
  gradeRecall: api.gradeRecall,
  saveExplanation: api.saveExplanation,
  setConviction: api.setConviction,
  updateSavedItem: stashApi.updateSavedItem,
  createStash: stashApi.createStash,
  deleteStash: stashApi.deleteStash,
};

/**
 * What the session rail shows.
 *
 * Reported upward rather than fetched again up there: these are the same
 * numbers the Enough screen ends on, and reading them twice from two places is
 * how two views of one session start disagreeing with each other.
 */
export interface FeedStats {
  read: number;
  saved: number;
  recalled: number;
  skippedKnown: number | null;
  minutesSaved: number | null;
}

export function Feed({
  userId,
  onStats,
  refreshKey = 0,
  onOpenSource,
}: {
  userId: string | null;
  onStats?: (stats: FeedStats) => void;
  /**
   * Open the source behind a card.
   *
   * Optional so `Feed` stays renderable without a router — the design specimen does
   * exactly that — and so a shell with nowhere to send the reader renders the chip
   * as the plain metadata it has always been rather than a control that goes nowhere.
   */
  onOpenSource?: (workId: string) => void;
  /**
   * Bumped by the shell when something outside this component changed what the
   * feed should contain — today, a reader saving their preferences.
   *
   * The seed deliberately survives a preference change: it is what keeps the
   * interrupt plan and the jitter stable across a sitting, and re-rolling it to
   * force a refetch would reshuffle the whole session as a side effect of
   * changing one topic. So this is a separate signal rather than a new seed.
   *
   * Without it the screen is the failure it was built to fix: a reader weights
   * a topic up, returns to a feed ranked by their old preferences, and is shown
   * a control that did nothing.
   */
  refreshKey?: number;
}) {
  const [session, setSession] = useState(loadSession);
  const [feed, setFeed] = useState<LoadedFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * A failed "More ideas", kept apart from `error`.
   *
   * `error` replaces the whole screen, which is right when there is nothing to show
   * and wrong when there are twenty cards the reader is halfway through. A page that
   * fails to load must not take the page that succeeded with it.
   */
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /*
   * Listening is the player's, not the feed's.
   *
   * This screen used to hold a `speakingId` and call `speak` directly, which made
   * playback a property of a mounted card: scrolling on left the voice running with
   * no control that could reach it, and the tab switch that hides this component
   * would have orphaned it entirely. The queue now lives above the shell
   * (`components/PlayerProvider.tsx`) and the feed only hands it tracks.
   */
  const player = usePlayer();

  /*
   * Sources this reader has just asked to see less of.
   *
   * Local, and deliberately not a refetch. `muted_works` is what `get_feed` reads,
   * so the mute is already durable and the next page will not carry the source at
   * all; re-fetching page 0 to prove it would throw away the reader's place in a
   * feed they are halfway through — the same reasoning the render site gives for
   * keeping `Feed` mounted across a tab change.
   *
   * The card the reader pressed on stays in place as a line they can undo, and the
   * rest of that source's cards go quietly. Those were never rejected; they were
   * withdrawn, and a column of "you muted this" notices for cards nobody had
   * reached yet would be the app arguing with itself.
   */
  /*
   * Keyed by WORK, both halves. `from` was one card id for the whole feed, so muting a
   * second source silently replaced the first source's notice: its cards stayed hidden
   * and its Undo went with the notice, leaving no way back from a mute the reader had
   * just made. A map from work id to the card that was pressed on is what "the card
   * that was pressed on becomes the notice" actually requires.
   */
  const [muted, setMuted] = useState<Map<string, string>>(new Map());
  const [muteError, setMuteError] = useState<string | null>(null);

  /*
   * What the share control actually did, which was previously unobservable.
   *
   * `shareOrCopy` has always returned an outcome and all three callers threw it
   * away, so on the copy path the button said "Copy link", copied, and said
   * nothing -- and a clipboard the browser refused looked identical to success.
   * Scoped to one Pull rather than the screen because the feed shows several and
   * a bare "Link copied." beside the wrong one is its own small lie.
   */
  const [shareStatus, setShareStatus] = useState<{ pullId: string; note: string } | null>(null);

  async function share(row: FeedRow) {
    setShareStatus(null);
    const note = shareNote(
      await shareOrCopy(
        shareTarget({
          origin: window.location.origin,
          pullId: row.id,
          headline: row.headline,
          workTitle: row.work.title,
        }),
      ),
    );
    setShareStatus(note ? { pullId: row.id, note } : null);
  }
  /*
   * How much detail the reader wants, kept for the session rather than per card.
   *
   * Someone who opens one Pull to its full argument is saying something about how
   * they read, not about that idea, and making them turn the dial again on every
   * card would make a preference into a chore. `clampDepth` in `@wap/ui`
   * reconciles it with each card, since not every Pull has all five stops.
   *
   * Starts at 1 — the claim, which is what the card has always shown. Stop 0 is
   * the headline alone, an option rather than the state to drop a reader into: a
   * feed of bare headlines is a table of contents.
   */
  const [depth, setDepth] = useState(1);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [done, setDone] = useState(false);
  const [offline, setOffline] = useState(false);
  const [readCount, setReadCount] = useState(0);
  const [recalled, setRecalled] = useState(0);
  /** Bumped by the retry button to re-run the fetch without disturbing the seed. */
  const [reloads, setReloads] = useState(0);
  /**
   * The ids saved *in this session* — a set, not a count.
   *
   * `saved` is the reader's whole persistent library: `fetchSavedPullIds` loads
   * every id so cards render with the right state. Reporting its size under
   * "This session" credited a returning reader with all of it before they had
   * done anything, which is the one kind of number this product must not
   * inflate — the rail exists to say what this sitting was worth, and a counter
   * that opens at 200 says nothing at all.
   *
   * A scalar incremented on save and decremented on un-save was the first fix
   * and was still wrong: save one new Pull, then un-save something kept last
   * week, and the count goes 1 → 0 while the new save is still there. Only the
   * identity of what was saved can answer "this session", so that is what is
   * tracked. Its siblings `read` and `recalled` both start empty; this matches.
   */
  const [savedThisSession, setSavedThisSession] = useState<Set<string>>(new Set());
  /** Interrupt slots already answered or skipped, so they are not shown twice. */
  const [handledSlots, setHandledSlots] = useState<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());

  // Push the session numbers up whenever they move. Effect rather than a call
  // inside each handler, so no future counter can be added and silently not
  // reach the rail.
  useEffect(() => {
    onStats?.({
      read: readCount,
      saved: savedThisSession.size,
      recalled,
      // ?? null, not ?? 0: the rail must show "--" for "we do not know"
      // rather than a zero it cannot stand behind.
      skippedKnown: feed?.skippedKnownCount ?? null,
      minutesSaved: feed?.minutesSaved ?? null,
    });
  }, [onStats, readCount, savedThisSession, recalled, feed]);

  useEffect(() => {
    let cancelled = false;
    // Page 0 is planned against whatever the session has already read, and there is
    // no previous placement to carry — `p_last_placed` stays absent so the planner
    // falls back to its own sentinel.
    const cardsBefore = session.cardsSeen;
    api
      .fetchFeed({
        seed: session.seed,
        page: 0,
        cardsBefore,
        usedBudget: session.interruptsShown,
      })
      .then((f) => {
        if (cancelled) return;
        // `null` prev, so this replaces rather than appends: a re-run of this effect
        // is a fresh start (a new seed, a retry, a preference change), and appending
        // would stack the old rows under the new ones.
        setFeed(appendPage(null, f, cardsBefore));
        // A successful load is the only proof the connection is back that this
        // component gets. The banner was previously cleared only by the `online`
        // event, which never fires when the failure happened with `onLine` true —
        // so a transport failure would raise it and nothing would lower it again.
        setOffline(false);
        void cachePulls(userId, f.rows);
      })
      .catch(async (e: unknown) => {
        if (cancelled) return;

        // Kept whatever happens: the detail is what makes a report actionable, and
        // it stops being available the moment it is turned into a display string.
        console.error('Feed request failed', e);

        /*
         * Falling back to cache is for being offline, and only for being offline.
         *
         * This used to fall back whenever the cache had anything, so a 500 or an
         * expired token rendered "Offline — reading from your downloaded copies"
         * over stale content on a working connection. A confident wrong diagnosis
         * is worse than none: it hides the failures most worth seeing early, and
         * tells the reader to go check their wifi instead.
         */
        const cached = isOfflineFailure(e) ? await readCachedPulls(userId) : [];

        // Re-checked after the await, not only before it. Opening IndexedDB and
        // reading it is a real gap, and this branch is now reachable twice over:
        // the retry button re-runs the effect, and so does "Keep reading anyway".
        // A stale handler resuming here would clobber the newer request's state
        // and raise the offline banner over rows it did not fetch.
        if (cancelled) return;

        if (cached.length > 0) {
          // null, not 0: the Delta never ran, and "nothing skipped" is a
          // claim about the session we have no basis for making.
          setFeed({
            rows: cached,
            slots: [],
            skippedKnownCount: null,
            minutesSaved: null,
            lastPlaced: null,
            nextPage: 1,
            // The cache is everything there is offline, so there is no more to ask
            // for. Offering "More ideas" here would be a button that can only fail.
            exhausted: true,
          });
          setOffline(true);
        } else {
          /*
           * Offline with nothing cached is still offline.
           *
           * `isOfflineFailure(e)` was computed above to decide whether to read the
           * cache and then thrown away, so an empty cache fell through to the generic
           * "Could not load your feed just now." with a Try again button that can only
           * fail. `Review.tsx` already distinguishes the two.
           *
           * This branch is newly common because of this very PR: the v2 upgrade drops
           * every v1 cache row, and a second account on a shared device — the case the
           * change exists for — starts with nothing cached at all. So the first reader
           * to go into a tunnel after it lands is the one told the wrong thing.
           */
          setOffline(isOfflineFailure(e));
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the seed and the account. Including the interrupt
    // budget would refetch page 0 every time a question is answered, replacing
    // the list while the reader is partway down it — and cards already seen are
    // by then recorded as impressions, so they would not even come back.
    //
    // `userId` IS in the list, and the disable above it is only about the budget.
    // This effect reads it (the cache write, and the cache read in the `catch`),
    // and `loadMore` already depends on it. Today `App.tsx` unmounts this
    // component on a session change so the id cannot move under a stable seed —
    // but nothing in this file enforces that, and the failure if it ever stops
    // being true is the offline path rendering the previous account's cached rows
    // to the next reader, which is the property this whole PR exists to
    // establish. It never changes on a stable session, so listing it costs
    // nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.seed, reloads, refreshKey, userId]);

  useEffect(() => {
    if (!userId) return;
    api
      .fetchSavedPullIds(userId)
      .then(setSaved)
      .catch(() => undefined);
  }, [userId]);

  // Writes made while disconnected replay in order once the connection returns.
  useEffect(() => {
    if (!userId) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoff = RETRY_BASE_MS;
    let stopped = false;

    const drain = () => {
      setOffline(false);
      return drainPending(
        userId,
        // Every kind is mapped in `replayWrite`, including the ones the Review
        // screen and the Library queue. This component is kept mounted by the
        // shell precisely so the session's state survives a tab switch, which
        // makes it the one place a drain can live.
        (write) => replayWrite(userId, write, REPLAY_PORT),
        // Read from the live auth session, not from component state. Signing
        // out unmounts this component rather than re-rendering it, so a ref
        // would stop updating at exactly the moment it matters and the drain
        // would keep believing this account was still present.
        () => getCurrentUserId() === userId,
      );
    };

    // A write can fail while the browser is still online — a 500, a timeout, a
    // server that is up but unwell. No `online` event follows, because
    // connectivity never changed, so the queue needs a timer of its own or it
    // waits for a reload.
    const scheduleRetry = () => {
      if (stopped || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void drainAndReschedule();
      }, backoff);
    };

    // Every path into the queue ends here, because what decides whether to
    // retry is whether anything is still pending — not which event got us here.
    // Hanging the schedule off the queued-write notification alone left the
    // case that needs it most uncovered: a page that loads with an entry
    // already queued emits no notification, so a failing mount drain would sit
    // there until an unrelated reconnect. Backs off while the server stays
    // unwell and resets once the queue clears.
    const drainAndReschedule = async () => {
      await drain();
      if (stopped) return;
      if (await hasPending(userId)) {
        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
        scheduleRetry();
      } else {
        backoff = RETRY_BASE_MS;
      }
    };

    // Writes can be queued by a transient server failure that never flips
    // navigator.onLine, and a reload while already online fires no `online`
    // event at all. Either way they would sit unapplied forever, so drain once
    // on mount as well as on reconnect.
    if (typeof navigator === 'undefined' || navigator.onLine) void drainAndReschedule();

    const offReconnect = onReconnect(() => {
      backoff = RETRY_BASE_MS;
      void drainAndReschedule();
    });
    // A write that just failed is not worth retrying this instant — let the
    // backoff run first.
    const offQueued = onPendingQueued(scheduleRetry);

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      offReconnect();
      offQueued();
    };
  }, [userId]);

  /*
   * The next page.
   *
   * A button rather than infinite scroll, deliberately. `docs/product.md` lists
   * engagement metrics as an anti-goal, and an endless list that loads itself as you
   * approach the bottom is the mechanic this product exists in opposition to. Asking
   * for more is a decision the reader makes; the alternative makes it for them.
   *
   * Pages accumulate, so the reader keeps their place and the interleave planner can
   * reach back into earlier pages for something to ask about.
   */
  const loadMore = useCallback(() => {
    if (!feed || loadingMore || feed.exhausted) return;
    setLoadingMore(true);
    setMoreError(null);
    // Snapshot both at request time. They advance as the reader scrolls, and the
    // planner's answer has to be interpreted against the values it was given.
    const cardsBefore = session.cardsSeen;
    api
      .fetchFeed({
        seed: session.seed,
        page: feed.nextPage,
        cardsBefore,
        usedBudget: session.interruptsShown,
        lastPlaced: feed.lastPlaced,
      })
      .then((next) => {
        void cachePulls(userId, next.rows);
        setFeed((prev) => (prev ? appendPage(prev, next, cardsBefore) : prev));
      })
      .catch((e: unknown) => {
        console.error('Feed page request failed', e);
        setMoreError(
          isOfflineFailure(e)
            ? 'Could not reach the library. Everything above is still yours to read.'
            : 'Could not load more just now.',
        );
      })
      .finally(() => setLoadingMore(false));
  }, [feed, loadingMore, session.seed, session.cardsSeen, session.interruptsShown, userId]);

  const items = useMemo(() => (feed ? weave(feed.rows, feed.slots) : []), [feed]);

  const onSave = useCallback(
    async (row: FeedRow) => {
      if (!userId) return;
      const wasSaved = saved.has(row.id);
      // Captured before the optimistic update, because a revert has to put this
      // set back rather than mirror `wasSaved`: a Pull kept last week is saved
      // but was never counted this session, and mirroring would count it now.
      const wasCountedThisSession = savedThisSession.has(row.id);
      // Updated from the previous state, not from the set this render captured.
      // Two saves tapped before React commits would otherwise both start from
      // the same snapshot, and the second would drop the first — leaving a card
      // saved server-side but rendered unsaved, where the next tap deletes it.
      setSaved((prev) => {
        const next = new Set(prev);
        if (wasSaved) next.delete(row.id);
        else next.add(row.id);
        return next;
      }); // optimistic — saving is free and unlimited, so never blocks
      // Keyed by id so un-saving only discounts a save this session actually
      // made. Un-saving something kept last week is not this session undoing
      // anything, and must not cancel out a Pull kept a minute ago.
      setSavedThisSession((prev) => {
        const next = new Set(prev);
        if (wasSaved) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      try {
        await (wasSaved ? api.unsavePull(row.id, userId) : api.savePull(row.id, userId));
      } catch (e: unknown) {
        /*
         * The write failed, but the reader's intent should survive a tunnel: keep
         * the optimistic state and replay it on reconnect.
         *
         * Only what the network lost, though. This used to queue on ANY failure,
         * which is the confident wrong diagnosis the feed request above refuses to
         * make about the cache, and `queueIfOffline` is the same judgement
         * `Library.tsx` already makes for the same writes.
         *
         * It became load-bearing in 20260910010000. `saved_items_insert_own` now
         * refuses a save against a Pull the reader cannot read, with 42501, and that
         * refusal is PERMANENT -- where before this the only 42501 a save could get
         * was a request that went out as `anon` because the session refresh had
         * failed, which drains as soon as it succeeds. `isPermanentFailure` does not
         * list 42501 and must not, for exactly that reason (rpc-error.ts says so at
         * length), so a queued one is never dropped: it holds `hasPending` true and
         * the retry timer alive for the life of the tab, it survives reload in
         * IndexedDB, and -- because `runDrain` only drops a refused write on a pass
         * where nothing was held back -- it also stops every genuinely permanent
         * write queued behind it from ever being dropped. Queueing only transport
         * failures keeps that whole class out of the queue instead of teaching the
         * queue to recognise it -- FOR THE ONLINE HALF ONLY, which is all this call site
         * can reach. A save queued in a tunnel and replayed after the withdrawal still
         * enters the queue and is still kept there when the replay is refused, because
         * `isPermanentFailure` cannot tell that refusal from a request that went out as
         * `anon` after a failed token refresh -- and it is right not to guess.
         *
         * That remaining path is named in 20260910010000's "does not fix". Two attempts
         * to close it from inside the drain were written and withdrawn during review:
         * both inferred "the session was attached" from another write succeeding in the
         * same pass, and the inference is false twice over. A token can expire midway
         * through a pass whose first write landed; and `unsavePull`, `updateSavedItem`
         * and `deleteStash` are bare DELETE/UPDATE with no `.select()`, so as `anon`
         * they return 204 with zero rows -- a "success" with nothing attached at all.
         * Measured, both of them. Closing it needs a real attachment signal at refusal
         * time, which belongs with the queue rather than in a migration's PR.
         */
        if (await queueIfOffline(userId, e, { kind: wasSaved ? 'unsave' : 'save', pullId: row.id }))
          return;

        /*
         * The server refused it, so the optimistic state above is now a lie and the
         * card would read "Saved" until the next reload disagreed. Put both sets back
         * the way the tap found them -- functionally, for the reason the optimistic
         * update is functional: a second tap may have landed while this was in flight.
         *
         * The detail goes to the console rather than the screen, as every other
         * failure on this route does: a reader who taps Save on an idea whose source
         * has just been withdrawn needs the pill to tell the truth, not a sentence
         * about row-level security.
         */
        console.error(wasSaved ? 'Could not unsave' : 'Could not save', e);
        setSaved((prev) => {
          const next = new Set(prev);
          if (wasSaved) next.add(row.id);
          else next.delete(row.id);
          return next;
        });
        setSavedThisSession((prev) => {
          const next = new Set(prev);
          if (wasCountedThisSession) next.add(row.id);
          else next.delete(row.id);
          return next;
        });
      }
    },
    [saved, savedThisSession, userId],
  );

  /*
   * One tracker for the whole feed, not one per card.
   *
   * Dwell is a property of the session rather than of a component: a card that
   * unmounts on a tab switch and remounts on the way back is the same idea being read
   * twice, and per-card state would report those as two short glances instead of one
   * long read.
   */
  const dwellRef = useRef(createDwellTracker());

  const onCardVisible = useCallback((pullId: string, visible: boolean) => {
    const t = dwellRef.current;
    if (visible) t.enter(pullId, Date.now());
    else t.leave(pullId, Date.now());
  }, []);

  /*
   * Send what has been measured, and keep the tab honest about what counts.
   *
   * `record_read` resolves conflicts with `greatest(existing, excluded)`, so these
   * carry running totals and are safe to repeat — which is what makes the `pagehide`
   * flush worth attempting even though its delivery cannot be checked.
   *
   * `visibilitychange` does double duty: it stops the clock on a backgrounded tab,
   * and it is the only reliable "the reader is leaving" signal on mobile Safari,
   * where `beforeunload` frequently never fires at all.
   */
  useEffect(() => {
    const t = dwellRef.current;
    const flush = () => {
      for (const { id, dwellMs } of t.report(Date.now())) {
        api.recordRead(id, dwellMs, 0).catch(() => {
          // Losing a dwell report costs a measurement, never a read: the read itself
          // was recorded when the card first came into view. Totals are cumulative,
          // so the next flush carries the same ground this one did.
        });
      }
    };

    const onVisibility = () => {
      const visible = document.visibilityState === 'visible';
      t.setVisible(visible, Date.now());
      if (!visible) flush();
    };

    // A minute is a compromise: often enough that a long read is not lost with the
    // tab, rare enough that it is not a write per scroll.
    const timer = setInterval(flush, 60_000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const onRead = useCallback(
    (row: FeedRow, index: number) => {
      if (seenRef.current.has(row.id)) return;
      seenRef.current.add(row.id);
      setReadCount((n) => n + 1);
      // The planner's warm-up and its minimum gap are measured in cards read
      // across the whole session, not within a page, so this has to advance or
      // `p_cards_before` stays 0 and every page is planned as if it were the
      // first one.
      setSession((s) => persist({ ...s, cardsSeen: s.cardsSeen + 1 }));
      api.recordRead(row.id, 0, index).catch(() => {
        // Offline reading should still produce history, impressions and
        // knowledge states once the connection returns — but only for a signed-in
        // reader, since a queued write has to belong to someone.
        if (userId) void queueMutation(userId, { kind: 'read', pullId: row.id });
      });
    },
    [userId],
  );

  /*
   * A card, as something to hear.
   *
   * The text is taken at the reader's CURRENT depth, which is why this is built at
   * the moment of the press rather than stored with the queue: "Listen" on a card
   * showing the claim should read the claim, and on the same card opened to the
   * full argument should read the argument.
   */
  const trackFor = useCallback(
    (row: FeedRow): Track => ({
      id: row.id,
      title: row.work.title,
      text: textAtDepth({ ...row, hasSource: Boolean(onOpenSource) }, depth),
    }),
    [depth, onOpenSource],
  );

  /*
   * Listen, and stop listening.
   *
   * Pressing Listen on the card that is already playing stops the player rather than
   * restarting it, which is the toggle `PullCard`'s `listening` prop describes.
   * Pressing it on any other card plays that one next — `playNow` keeps the queue
   * and puts the card after the current track, so a reader who has queued five
   * things and then hears one they want now does not lose the other four.
   */
  const onListen = useCallback(
    (row: FeedRow) => {
      if (isPlaying(player.state, row.id)) {
        player.stop();
        return;
      }
      player.playNow(trackFor(row));
    },
    [player, trackFor],
  );

  /*
   * Queue, and unqueue. The queue is the reader's list, so the same press takes a
   * card back out of it; `remove` on the track being spoken moves the player on
   * rather than leaving it reading something the reader just removed.
   */
  const onQueue = useCallback(
    (row: FeedRow) => {
      if (isQueued(player.state, row.id)) player.remove(row.id);
      else player.enqueue([trackFor(row)]);
    },
    [player, trackFor],
  );

  /*
   * Less like this.
   *
   * Optimistic, and rolled back on failure: the reader is looking at the card they
   * pressed on, and a source that visibly stays after being muted reads as a
   * control that does not work. A signed-out visitor has no row to write, so the
   * control is not offered to one.
   */
  /*
   * ROLLED BACK FUNCTIONALLY, undoing one work rather than restoring a snapshot.
   *
   * Both handlers used to close over `muted` and write that object back on failure,
   * which discards everything that happened while the request was in flight: mute A,
   * mute B successfully, A fails, and B's mute is wiped from the screen while its row
   * sits on the server -- so the feed disagrees with itself until the next page, which
   * will not carry B. Touching only the work this call is about cannot do that.
   */
  const onMute = useCallback(
    async (row: FeedRow) => {
      if (!userId) return;
      setMuteError(null);
      setMuted((prev) => new Map(prev).set(row.work.id, row.id));
      try {
        await api.muteWork(row.work.id, row.id, userId);
      } catch (e: unknown) {
        console.error('Could not mute the source', e);
        setMuted((prev) => {
          const next = new Map(prev);
          next.delete(row.work.id);
          return next;
        });
        setMuteError('Could not mute that source just now. It is still in your feed.');
      }
    },
    [userId],
  );

  const onUnmute = useCallback(
    async (row: FeedRow) => {
      if (!userId) return;
      setMuteError(null);
      const shown = muted.get(row.work.id) ?? row.id;
      setMuted((prev) => {
        const next = new Map(prev);
        next.delete(row.work.id);
        return next;
      });
      try {
        await api.unmuteWork(row.work.id, userId);
      } catch (e: unknown) {
        console.error('Could not unmute the source', e);
        setMuted((prev) => new Map(prev).set(row.work.id, shown));
        setMuteError('Could not undo that just now.');
      }
    },
    [muted, userId],
  );

  const onInterrupt = useCallback(
    async (item: Extract<Item, { type: 'interrupt' }>, answer: InterruptAnswer | null) => {
      // A question is answered once. Without this guard the card stays mounted
      // and clickable, so repeated clicks would write duplicate interrupt
      // events, re-record convictions and recall grades, and inflate the
      // session's interrupt budget from a single question.
      const slotKey = `${item.index}-${item.row.id}`;
      if (handledSlots.has(slotKey)) return;
      setHandledSlots((prev) => new Set(prev).add(slotKey));

      const responded = answer !== null;

      // Settled independently, not chained. `record_interrupt` is telemetry;
      // the stance and the explanation are the reader's own data. Awaiting them
      // behind it meant one failed telemetry write silently discarded both.
      /*
       * One id for the interrupt and the grade it carries.
       *
       * `record_interrupt` inserts its own row keyed by this id and only then
       * calls `grade_recall`, so a replay stops at the interrupt row and never
       * reaches the arithmetic — one interrupt, one event, one grade, one session
       * bump, however many times the request is retried. Two ids would have made
       * the interrupt idempotent and left the grade able to apply twice.
       */
      /*
       * `mutationId()` rather than `crypto.randomUUID()` directly, and this is the same
       * premise `Review.tsx` acts on: it is undefined in a non-secure context, which
       * `lib/offline.ts` names as live. A throw HERE is worse than there, because
       * `setHandledSlots` above has already marked the slot handled — so the reader's
       * stance and explanation would be discarded with no banner and no retry, by an
       * exception nothing catches.
       */
      const interruptMutationId = mutationId();
      const interruptSubmittedAt = nextSubmissionStamp();
      const interruptGrade = answer?.grade;
      const writes: Promise<unknown>[] = [
        api
          .recordInterrupt({
            pullId: item.row.id,
            kind: item.slot.kind,
            slot: item.slot.slotIndex,
            response: responded ? 'answered' : 'dismissed',
            mutationId: interruptMutationId,
            submittedAt: interruptSubmittedAt,
            ...(interruptGrade ? { grade: interruptGrade } : {}),
            ...(answer?.confidence ? { confidence: answer.confidence } : {}),
            ...(answer?.questionId ? { questionId: answer.questionId } : {}),
            ...(typeof answer?.latencyMs === 'number' ? { latencyMs: answer.latencyMs } : {}),
            ...(answer?.answer ? { answer: answer.answer } : {}),
          })
          .catch((e: unknown) => {
            /*
             * The grade rides on telemetry, and only the telemetry was allowed to fail.
             *
             * This promise went straight into `allSettled` with no catch, so a lost
             * response took the recall answer with it — the one thing in the interrupt
             * that is a measurement of the reader rather than of the session. The
             * stance and the explanation below were queued from the first version of
             * this change; the grade in the middle was not.
             *
             * Queued as the grade alone, under the interrupt's OWN mutation id. That
             * is what makes the replay safe in both directions: if the interrupt did
             * land and only the response was lost, `grade_recall` finds the
             * `recall_events` row already keyed by this id and returns the state
             * untouched; if it never landed, the grade applies once. The interrupt row
             * itself is not reconstructed, and should not be — an impression
             * regenerates the moment the reader scrolls past the card again, which is
             * the distinction the comment above already draws.
             */
            if (!userId || !interruptGrade) return;
            return queueMutation(
              userId,
              {
                kind: 'recall',
                pullId: item.row.id,
                grade: interruptGrade,
                mutationId: interruptMutationId,
                submittedAt: interruptSubmittedAt,
                recallKind: item.slot.kind,
                ...(answer?.confidence ? { confidence: answer.confidence } : {}),
                ...(answer?.questionId ? { questionId: answer.questionId } : {}),
                ...(typeof answer?.latencyMs === 'number' ? { latencyMs: answer.latencyMs } : {}),
                ...(answer?.answer ? { answer: answer.answer } : {}),
              },
              e,
            );
          }),
      ];
      // Both of the reader's own answers are queued on failure. Each exists
      // nowhere else — a stance is a considered judgement and an explanation is
      // several sentences they composed — where an impression regenerates the
      // moment they scroll past the card again. Replay is safe for both:
      // `set_conviction` no-ops on an unchanged stance, and the explanation
      // carries a mutation id that makes a retry collide with the write it is
      // replaying rather than duplicate it.
      if (answer?.stance) {
        const stance = answer.stance;
        const stanceId = mutationId();
        const submittedAt = nextSubmissionStamp();
        writes.push(
          // Nothing to clean up on success. Ordering is the server's: it
          // declines a stance older than the one on record, so a retry that
          // arrives after a newer decision is a no-op wherever it comes from.
          // Deciding that here meant scanning a queue that cannot yet contain
          // a request still in flight.
          api.setConviction(item.row.id, stance, stanceId, submittedAt).catch((e: unknown) => {
            // Only queueable for a signed-in reader: a pending write has to
            // belong to someone, or the drain cannot tell whose it is.
            if (userId)
              return queueMutation(
                userId,
                {
                  kind: 'conviction',
                  pullId: item.row.id,
                  stance,
                  mutationId: stanceId,
                  submittedAt,
                },
                e,
              );
          }),
        );
      }
      if (answer?.explanation && userId) {
        const text = answer.explanation;
        const explanationId = mutationId();
        writes.push(
          api
            .saveExplanation(userId, item.row.id, text, explanationId)
            .catch((e: unknown) =>
              queueMutation(
                userId,
                { kind: 'explain', pullId: item.row.id, text, mutationId: explanationId },
                e,
              ),
            ),
        );
      }
      // Never rejects, so a dropped write cannot break the reading session.
      await Promise.allSettled(writes);
      // Only the two variants that actually test retrieval count. A conviction
      // or counterpull answer is a stance, and a delta probe is calibration —
      // answering "already knew it" is a claim about the past, not a memory
      // retrieved now. Keyed on the interrupt's kind rather than on a grade
      // being present, because a probe carries one too.
      if (item.slot.kind === 'recall' || item.slot.kind === 'say_it_back') {
        if (answer?.grade) setRecalled((n) => n + 1);
      }
      setSession((s) => persist({ ...s, interruptsShown: s.interruptsShown + 1 }));
    },
    [handledSlots, userId],
  );

  /*
   * A sentence a reader can act on, and a way to act on it.
   *
   * `rpc-error.ts` fixed the "[object Object]" this used to render, but the result
   * was that a stranger now read `permission denied for function get_feed` — which
   * is unhelpful *and* leaks schema internals. The detail belongs in the console,
   * where it is available to whoever is debugging and to nobody else.
   *
   * The retry matters as much as the wording. There was no way out of this screen
   * except a manual reload, which on a transient failure is a reader lost to a
   * problem that had already gone away.
   */
  if (error) {
    return (
      <div className="stack measure" role="alert">
        {/*
          Two sentences, because they ask for two different things. A reader in a
          tunnel with an empty cache needs to know it is the connection and that
          nothing is wrong with their account; a reader whose request was refused
          needs the retry. `Review.tsx` already drew this distinction and this
          screen did not, so the offline reader got the generic sentence and a
          button that could only fail.
        */}
        <p>
          {offline
            ? 'You appear to be offline, and there is nothing downloaded on this device yet.'
            : 'Could not load your feed just now.'}
        </p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setError(null);
            setFeed(null);
            // An explicit nonce rather than touching the session: the fetch effect
            // is keyed on `session.seed`, so a new session object with the same
            // seed would not re-run it, and changing the seed would reshuffle the
            // feed — discarding the reader's place as the price of retrying.
            setReloads((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!feed) {
    return (
      <p className="meta" role="status">
        Loading…
      </p>
    );
  }

  /*
   * Nothing to read is not the same as having read enough.
   *
   * These two were one condition, so a reader the catalogue had nothing for was
   * congratulated for finishing it: "Enough for today. Ideas read 0 · Recalled 0",
   * on their first screen, having done nothing. Worse, the one way out —
   * "Keep reading anyway" — refetched with a new seed, got zero rows again, and
   * rendered the identical screen. A dead end that reads as an achievement.
   *
   * This is the state a brand-new reader hits before generation has populated
   * `pulls`, which is precisely the state this project is in on the day it opens.
   */
  if (feed.rows.length === 0 && readCount === 0) {
    return (
      <div className="stack measure">
        <p className="meta">For You</p>
        <h1 style={{ fontSize: 'var(--step-3)' }}>Nothing here yet.</h1>
        <p>
          New Pulls are still being drawn from their sources. This is a young library — check back
          shortly and there will be something worth keeping.
        </p>

        <hr className="rule" />

        {/*
          It says what will arrive, not only that nothing has. An empty state that reports
          emptiness and stops gives a reader no reason to come back, and this is the one
          screen where explaining the product is not filler. No icon and no illustration —
          both are what a product reaches for when it does not trust its own sentence. No
          retry button either: nothing is broken, so a control that re-runs the same query
          and returns the same nothing is a dead end wearing an affordance, which is the
          exact bug this state was split out of.
        */}
        <p className="meta">What arrives here</p>
        <p style={{ color: 'var(--text-soft)' }}>
          Ideas from books, films, papers, talks and documentaries — one at a time, anchored to a
          real source and argued with rather than summarised.
        </p>
      </div>
    );
  }

  if (done || feed.rows.length === 0) {
    return (
      <Enough
        ideasRead={readCount}
        recalled={recalled}
        minutesSaved={feed.minutesSaved}
        onContinue={() => {
          setSession(resetSession());
          setDone(false);
          seenRef.current.clear();
          // The session is being reset, so its tallies reset with it. Carrying
          // them over would report both halves summed against a `minutesSaved`
          // that describes only the second — two spans on one screen.
          setReadCount(0);
          setRecalled(0);
        }}
      />
    );
  }

  return (
    <div className="stack" style={{ '--stack-gap': 'var(--space-6)' } as React.CSSProperties}>
      {offline && (
        <p className="meta" role="status">
          Offline — reading from your downloaded copies.
        </p>
      )}

      {/* Guarded on both, not just the count: the banner interpolates
          minutesSaved, and React renders null as empty — so decoupling them
          would silently print "about  min saved". */}
      {feed.skippedKnownCount !== null &&
        feed.skippedKnownCount > 0 &&
        feed.minutesSaved !== null && (
          <p className="meta" data-testid="delta-banner">
            Skipped {feed.skippedKnownCount} {feed.skippedKnownCount === 1 ? 'idea' : 'ideas'} you
            already know —{' '}
            <span style={{ color: 'var(--accent)' }}>about {feed.minutesSaved} min saved</span>
          </p>
        )}

      {items.map((item) =>
        muted.has(item.row.work.id) ? (
          /*
            The card that was pressed on becomes the notice; every other card of the
            same source goes. One entry per muted work, so a reader who mutes three
            sources keeps three notices and three ways back — which a single `from`
            could not do, and did not.
          */
          item.type === 'pull' && muted.get(item.row.work.id) === item.row.id ? (
            <p key={item.row.id} className="meta feed__muted" role="status">
              You will see less of {item.row.work.title}.{' '}
              <button
                type="button"
                className="btn btn--plain"
                onClick={() => void onUnmute(item.row)}
              >
                Undo
              </button>
            </p>
          ) : null
        ) : item.type === 'interrupt' ? (
          // An answered question is done with. Leaving it mounted would let a
          // second click write another interrupt event and another grade.
          handledSlots.has(`${item.index}-${item.row.id}`) ? null : (
            <Interrupt
              key={`i-${item.index}-${item.row.id}`}
              kind={item.slot.kind}
              pull={item.row}
              onAnswer={(a) => void onInterrupt(item, a)}
              onDismiss={() => void onInterrupt(item, null)}
            />
          )
        ) : (
          <PullCardInView
            key={item.row.id}
            row={item.row}
            saved={saved.has(item.row.id)}
            onSave={() => void onSave(item.row)}
            onRead={() => onRead(item.row, item.index)}
            onVisible={(visible) => onCardVisible(item.row.id, visible)}
            onOpenSource={onOpenSource ? () => onOpenSource(item.row.work.id) : undefined}
            listening={isPlaying(player.state, item.row.id)}
            onListen={CAN_SPEAK ? () => onListen(item.row) : undefined}
            queued={isQueued(player.state, item.row.id)}
            onQueue={CAN_SPEAK ? () => onQueue(item.row) : undefined}
            reason={item.row.reason ?? null}
            onMute={userId ? () => void onMute(item.row) : undefined}
            onShare={() => void share(item.row)}
            shareNote={shareStatus?.pullId === item.row.id ? shareStatus.note : null}
            shareLabel={SHARE_LABEL}
            depth={depth}
            onDepthChange={setDepth}
          />
        ),
      )}

      {muteError && (
        <p className="meta" role="status">
          {muteError}
        </p>
      )}

      {moreError && (
        <p className="meta" role="status">
          {moreError}
        </p>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {/*
          Hidden once the library is exhausted rather than disabled: a control that
          can only tell you "no" is worse than no control, and the reader still has
          "That's enough for today" to end on.
        */}
        {!feed.exhausted && (
          <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Finding more…' : 'More ideas'}
          </button>
        )}
        <button type="button" className="btn" onClick={() => setDone(true)}>
          That's enough for today
        </button>
      </div>
    </div>
  );
}

function PullCardInView({
  row,
  saved,
  onSave,
  onRead,
  onVisible,
  onOpenSource,
  onListen,
  listening,
  onQueue,
  queued,
  reason,
  onMute,
  onShare,
  shareNote: shareOutcomeNote,
  shareLabel: shareControlLabel,
  depth,
  onDepthChange,
}: {
  row: FeedRow;
  saved: boolean;
  onSave: () => void;
  onRead: () => void;
  /** Called with true when the card comes into view and false when it leaves. */
  onVisible: (visible: boolean) => void;
  onOpenSource?: () => void;
  /** Absent where the browser cannot speak, so no dead control is rendered. */
  onListen?: () => void;
  listening: boolean;
  /** Absent for the same reason `onListen` is. */
  onQueue?: () => void;
  queued: boolean;
  /** Why this card, from `get_feed`; null where nothing about it was measured. */
  reason: string | null;
  /** Absent for a visitor, who has no row to write a mute into. */
  onMute?: () => void;
  onShare: () => void;
  /** What the last share attempt did, or null when there is nothing to say. */
  shareNote: string | null;
  /** Renamed on the way in so it does not shadow the `shareLabel` helper. */
  shareLabel: string;
  /** The session's depth, so the dial does not reset on every card. */
  depth: number;
  onDepthChange: (depth: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /*
   * The callbacks, held rather than depended on.
   *
   * The observer effect used to list `[onRead, onVisible]`, and both are fresh arrow
   * closures minted at the call site on every render of `Feed` — which now re-renders
   * on every player transition, because `usePlayer()` subscribes it to the whole
   * reducer. So pressing Pause on the bar, or dragging the sleep timer, tore down and
   * rebuilt every visible card's `IntersectionObserver`: the cleanup cleared the
   * pending `MIN_DWELL_MS` timer, reset `fired`, and fired `onVisible(false)`, which
   * stops the dwell clock until the new observer's first callback arrives
   * asynchronously. A reader using the player while the feed was on screen lost dwell
   * measurement and could lose the read event entirely — which this file spends a
   * great deal of effort not getting wrong in the other direction.
   *
   * Refs read at call time instead, so the observer outlives a re-render and the
   * effect depends on nothing that changes.
   */
  const onReadRef = useRef(onRead);
  const onVisibleRef = useRef(onVisible);
  useEffect(() => {
    onReadRef.current = onRead;
    onVisibleRef.current = onVisible;
  });

  /*
   * Both edges now, not just the first one.
   *
   * This observer only ever reported `isIntersecting`, which is all "counts as read"
   * needs — but it is half of what "how long was it read for" needs, and that is why
   * `dwell_ms` was written as a literal 0 at the one call site and every row in
   * production holds zero.
   *
   * `onVisible(false)` on unmount as well as on leaving the viewport: a card removed
   * by a tab switch or a re-render never fires a non-intersecting entry, and without
   * the cleanup its interval stays open until something else closes it.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    /*
     * A card has to be looked at for a moment before it counts as read.
     *
     * `onRead` used to fire on the first intersecting entry, so flicking through
     * twenty cards recorded twenty reads, twenty history rows and twenty knowledge
     * states — and then told the reader they had read twenty ideas. This file spends
     * a great deal of effort not inflating that number (see the comments on
     * `readCount` and on keeping the feed mounted); this was the one path that did.
     *
     * `MIN_DWELL_MS` already exists in `lib/dwell.ts` and says exactly what this
     * needs — "below this it is a card passing through the viewport on the way
     * somewhere else" — and nothing used it for the read event.
     *
     * The timer is cancelled on leaving, so scrolling past costs nothing. Only the
     * *first* qualifying dwell fires: `fired` makes a card that is scrolled back to
     * still one read, which is what `handledSlots` assumes downstream.
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fired = false;

    /*
     * The same definition of "on screen" as the interrupt's clock (`lib/in-view.ts`),
     * and for the same reason: a single threshold of 0.6 is unreachable for any card
     * taller than 1.67x the viewport, so on a phone a long card scrolled through
     * never started the dwell timer, never fired `onRead`, and left no history row
     * and no knowledge state. Six tenths of the card, or six tenths of the viewport,
     * whichever comes first; the dense threshold schedule is what makes the second
     * rule observable.
     */
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (isGenuinelyInView(e, 0.6)) {
            if (!fired && timer === undefined) {
              timer = setTimeout(() => {
                fired = true;
                timer = undefined;
                onReadRef.current();
              }, MIN_DWELL_MS);
            }
          } else if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          onVisibleRef.current(e.isIntersecting);
        }
      },
      { threshold: [...IN_VIEW_THRESHOLDS] },
    );
    io.observe(el);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      io.disconnect();
      onVisibleRef.current(false);
    };
    // Nothing: the observer is set up once per mounted card and reads its callbacks
    // through refs. See the block above.
  }, []);

  return (
    // `feed__item` is the scroll-snap target. It wraps the card rather than being the
    // card, so the snap point sits at the top of the whole unit including its margin.
    <div ref={ref} className="feed__item">
      <PullCard
        source={{ title: row.work.title, kind: row.work.kind, year: row.work.year }}
        headline={row.headline}
        body={row.body}
        whyItMatters={row.whyItMatters}
        example={row.example}
        explanation={row.explanation}
        sourceTrail={row.summaryTitle}
        saved={saved}
        onSave={onSave}
        onListen={onListen}
        listening={listening}
        onQueue={onQueue}
        queued={queued}
        reason={reason}
        onMute={onMute}
        onOpenSource={onOpenSource}
        onShare={onShare}
        shareLabel={shareControlLabel}
        depth={depth}
        onDepthChange={onDepthChange}
      />
      {/* Inside `feed__item`, not beside it: that div is the scroll-snap
          target, and a sibling would break the card into two snap units. */}
      {shareOutcomeNote && (
        <p className="meta" role="status">
          {shareOutcomeNote}
        </p>
      )}
    </div>
  );
}
