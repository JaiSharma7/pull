import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Enough, PullCard } from '@wap/ui';
import { Interrupt, type InterruptAnswer } from '../components/Interrupt.js';
import * as api from '../lib/api.js';
import {
  cachePulls,
  drainPending,
  hasPending,
  onPendingQueued,
  onReconnect,
  queueMutation,
  readCachedPulls,
} from '../lib/offline.js';
import { loadSession, persist, resetSession } from '../lib/session.js';
import { speak } from '../lib/speech.js';
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
    if (slot) {
      const earlier = rows[Math.max(0, i - 3)];
      if (earlier) out.push({ type: 'interrupt', slot, row: earlier, index: i });
    }
    out.push({ type: 'pull', row, index: i });
  });
  return out;
}

export function Feed({ userId }: { userId: string | null }) {
  const [session, setSession] = useState(loadSession);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [done, setDone] = useState(false);
  const [offline, setOffline] = useState(false);
  const [readCount, setReadCount] = useState(0);
  const [recalled, setRecalled] = useState(0);
  /** Interrupt slots already answered or skipped, so they are not shown twice. */
  const [handledSlots, setHandledSlots] = useState<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());
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
        void cachePulls(f.rows);
      })
      .catch(async (e: unknown) => {
        if (cancelled) return;
        // Offline reading is free and unlimited, so a dropped connection falls
        // back to what is cached rather than showing an error.
        const cached = await readCachedPulls();
        if (cached.length > 0) {
          setFeed({
            rows: cached,
            skippedKnownCount: 0,
            minutesSaved: 0,
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
  }, [session.seed]);

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
          else if (write.kind === 'conviction') await api.setConviction(write.pullId, write.stance);
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
    // connectivity never changed, so the entry needs a timer of its own or it
    // waits for a reload. Backs off while it keeps failing and resets once the
    // queue clears, so an unreachable server is retried patiently rather than
    // hammered.
    const retryLater = () => {
      if (stopped || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void (async () => {
          await drain();
          if (stopped) return;
          if (await hasPending(userId)) {
            backoff = Math.min(backoff * 2, RETRY_MAX_MS);
            retryLater();
          } else {
            backoff = RETRY_BASE_MS;
          }
        })();
      }, backoff);
    };

    // Writes can be queued by a transient server failure that never flips
    // navigator.onLine, and a reload while already online fires no `online`
    // event at all. Either way they would sit unapplied forever, so drain once
    // on mount as well as on reconnect.
    if (typeof navigator === 'undefined' || navigator.onLine) void drain();

    const offReconnect = onReconnect(() => {
      backoff = RETRY_BASE_MS;
      void drain();
    });
    const offQueued = onPendingQueued(retryLater);

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
      const next = new Set(saved);
      const wasSaved = next.has(row.id);
      if (wasSaved) next.delete(row.id);
      else next.add(row.id);
      setSaved(next); // optimistic — saving is free and unlimited, so never blocks
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
        writes.push(
          api.setConviction(item.row.id, stance).catch(() => {
            // Only queueable for a signed-in reader: a pending write has to
            // belong to someone, or the drain cannot tell whose it is.
            if (userId)
              return queueMutation(userId, { kind: 'conviction', pullId: item.row.id, stance });
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
      // Only a recall grade counts as recall. A conviction or counterpull answer
      // is a stance, not a memory test, and counting it would overstate the
      // number the Enough screen reports.
      if (answer?.grade) setRecalled((n) => n + 1);
      setSession((s) => persist({ ...s, interruptsShown: s.interruptsShown + 1 }));
    },
    [handledSlots, userId],
  );

  if (error) {
    return (
      <p role="alert" className="measure">
        Could not load the feed: {error}
      </p>
    );
  }

  if (!feed) {
    return <p className="meta">Loading…</p>;
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

      {feed.skippedKnownCount > 0 && (
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
