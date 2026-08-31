import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Enough, PullCard } from '@wap/ui';
import { Interrupt, type InterruptAnswer } from '../components/Interrupt.js';
import * as api from '../lib/api.js';
import {
  cachePulls,
  drainPending,
  hasPending,
  isOfflineFailure,
  onPendingQueued,
  onReconnect,
  queueMutation,
  readCachedPulls,
} from '../lib/offline.js';
import { loadSession, persist, resetSession } from '../lib/session.js';
import { speak } from '../lib/speech.js';
import { nextSubmissionStamp } from '../lib/submission.js';
import { getCurrentUserId } from '../lib/supabase.js';
import type { FeedResponse, FeedRow, InterleaveSlot } from '../lib/types.js';

type Item =
  | { type: 'pull'; row: FeedRow; index: number }
  | { type: 'interrupt'; slot: InterleaveSlot; row: FeedRow; index: number };

/** Retry schedule for writes queued while the browser is still online. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Weave the interrupt slots into the row list.
 *
 * A slot replaces the card at that index with a question about an *earlier*
 * card — asking about something the reader has just this second read would be
 * recognition, not recall.
 */
function weave(rows: FeedRow[], slots: InterleaveSlot[]): Item[] {
  const bySlot = new Map(slots.map((s) => [s.slotIndex, s]));
  const out: Item[] = [];
  rows.forEach((row, i) => {
    const slot = bySlot.get(i);
    // Only ask about a card this page has actually rendered. Once a session has
    // pages behind it the planner can place a slot at index 0, where there is
    // no earlier card *here* — and `Math.max(0, i - 3)` would resolve to the
    // card at the slot itself, asking the reader to recall something still on
    // screen. The earlier pages' rows are not in hand, so the honest move is to
    // let that slot pass rather than invent a target for it.
    if (slot && i > 0) {
      const earlier = rows[Math.max(0, i - 3)];
      if (earlier) out.push({ type: 'interrupt', slot, row: earlier, index: i });
    }
    out.push({ type: 'pull', row, index: i });
  });
  return out;
}

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
}: {
  userId: string | null;
  onStats?: (stats: FeedStats) => void;
}) {
  const [session, setSession] = useState(loadSession);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    api
      .fetchFeed({
        seed: session.seed,
        page: 0,
        cardsBefore: session.cardsSeen,
        usedBudget: session.interruptsShown,
      })
      .then((f) => {
        if (cancelled) return;
        setFeed(f);
        // A successful load is the only proof the connection is back that this
        // component gets. The banner was previously cleared only by the `online`
        // event, which never fires when the failure happened with `onLine` true —
        // so a transport failure would raise it and nothing would lower it again.
        setOffline(false);
        void cachePulls(f.rows);
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
        const cached = isOfflineFailure(e) ? await readCachedPulls() : [];

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
            skippedKnownCount: null,
            minutesSaved: null,
            interleaveSlots: [],
            page: 0,
          });
          setOffline(true);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the seed alone. Including the interrupt budget
    // would refetch page 0 every time a question is answered, replacing the
    // list while the reader is partway down it — and cards already seen are by
    // then recorded as impressions, so they would not even come back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.seed, reloads]);

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
        async (write) => {
          if (write.kind === 'save') await api.savePull(write.pullId, userId);
          else if (write.kind === 'unsave') await api.unsavePull(write.pullId, userId);
          else if (write.kind === 'explain')
            await api.saveExplanation(userId, write.pullId, write.text, write.mutationId);
          else if (write.kind === 'conviction')
            await api.setConviction(
              write.pullId,
              write.stance,
              write.mutationId,
              write.submittedAt,
            );
          else await api.recordRead(write.pullId, 0, 0);
        },
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

  const items = useMemo(() => (feed ? weave(feed.rows, feed.interleaveSlots) : []), [feed]);

  const onSave = useCallback(
    async (row: FeedRow) => {
      if (!userId) return;
      const wasSaved = saved.has(row.id);
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
      } catch {
        // The write failed, but the reader's intent should survive a tunnel:
        // keep the optimistic state and replay it on reconnect.
        await queueMutation(userId, { kind: wasSaved ? 'unsave' : 'save', pullId: row.id });
      }
    },
    [saved, userId],
  );

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
      const writes: Promise<unknown>[] = [
        api.recordInterrupt({
          pullId: item.row.id,
          kind: item.slot.kind,
          slot: item.slot.slotIndex,
          response: responded ? 'answered' : 'dismissed',
          ...(answer?.grade ? { grade: answer.grade } : {}),
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
        const mutationId = crypto.randomUUID();
        const submittedAt = nextSubmissionStamp();
        writes.push(
          // Nothing to clean up on success. Ordering is the server's: it
          // declines a stance older than the one on record, so a retry that
          // arrives after a newer decision is a no-op wherever it comes from.
          // Deciding that here meant scanning a queue that cannot yet contain
          // a request still in flight.
          api.setConviction(item.row.id, stance, mutationId, submittedAt).catch(() => {
            // Only queueable for a signed-in reader: a pending write has to
            // belong to someone, or the drain cannot tell whose it is.
            if (userId)
              return queueMutation(userId, {
                kind: 'conviction',
                pullId: item.row.id,
                stance,
                mutationId,
                submittedAt,
              });
          }),
        );
      }
      if (answer?.explanation && userId) {
        const text = answer.explanation;
        const mutationId = crypto.randomUUID();
        writes.push(
          api
            .saveExplanation(userId, item.row.id, text, mutationId)
            .catch(() =>
              queueMutation(userId, { kind: 'explain', pullId: item.row.id, text, mutationId }),
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
        <p>Could not load your feed just now.</p>
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
    return <p className="meta">Loading…</p>;
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

      {feed.skippedKnownCount !== null && feed.skippedKnownCount > 0 && (
        <p className="meta" data-testid="delta-banner">
          Skipped {feed.skippedKnownCount} {feed.skippedKnownCount === 1 ? 'idea' : 'ideas'} you
          already know —{' '}
          <span style={{ color: 'var(--accent)' }}>about {feed.minutesSaved} min saved</span>
        </p>
      )}

      {items.map((item) =>
        item.type === 'interrupt' ? (
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
          />
        ),
      )}

      <button type="button" className="btn" onClick={() => setDone(true)}>
        That's enough for today
      </button>
    </div>
  );
}

function PullCardInView({
  row,
  saved,
  onSave,
  onRead,
}: {
  row: FeedRow;
  saved: boolean;
  onSave: () => void;
  onRead: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // A card counts as read once it has actually been on screen, not merely
  // rendered below the fold.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) onRead();
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onRead]);

  return (
    <div ref={ref}>
      <PullCard
        source={{ title: row.work.title, kind: row.work.kind, year: row.work.year }}
        headline={row.headline}
        body={row.body}
        whyItMatters={row.whyItMatters}
        example={row.example}
        sourceTrail={row.summaryTitle}
        saved={saved}
        onSave={onSave}
        onListen={() => speak(`${row.headline}. ${row.body}`)}
      />
    </div>
  );
}
