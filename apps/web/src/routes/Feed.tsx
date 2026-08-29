import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Enough, PullCard } from '@wap/ui';
import { Interrupt, type InterruptAnswer } from '../components/Interrupt.js';
import * as api from '../lib/api.js';
import {
  cachePulls,
  drainPending,
  onReconnect,
  queueMutation,
  readCachedPulls,
} from '../lib/offline.js';
import { loadSession, persist, resetSession } from '../lib/session.js';
import { speak } from '../lib/speech.js';
import type { FeedResponse, FeedRow, InterleaveSlot } from '../lib/types.js';

type Item =
  | { type: 'pull'; row: FeedRow; index: number }
  | { type: 'interrupt'; slot: InterleaveSlot; row: FeedRow; index: number };

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
  const seenRef = useRef<Set<string>>(new Set());
  // Kept in a ref so an in-flight drain can re-check the live identity without
  // being torn down and restarted every time this component re-renders.
  const currentUserRef = useRef(userId);
  useEffect(() => {
    currentUserRef.current = userId;
  }, [userId]);

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

    const drain = () => {
      setOffline(false);
      void drainPending(
        userId,
        async ({ kind, pullId }) => {
          if (kind === 'save') await api.savePull(pullId, userId);
          else if (kind === 'unsave') await api.unsavePull(pullId, userId);
          else await api.recordRead(pullId, 0, 0);
        },
        // A drain can outlive a sign-out; without this the previous account's
        // queued reads would be written against the new session.
        () => currentUserRef.current === userId,
      );
    };

    // Writes can be queued by a transient server failure that never flips
    // navigator.onLine, and a reload while already online fires no `online`
    // event at all. Either way they would sit unapplied forever, so drain once
    // on mount as well as on reconnect.
    if (typeof navigator === 'undefined' || navigator.onLine) drain();
    return onReconnect(drain);
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
        await queueMutation(userId, wasSaved ? 'unsave' : 'save', row.id);
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
        if (userId) void queueMutation(userId, 'read', row.id);
      });
    },
    [userId],
  );

  const onInterrupt = useCallback(
    async (item: Extract<Item, { type: 'interrupt' }>, answer: InterruptAnswer | null) => {
      const responded = answer !== null;
      try {
        await api.recordInterrupt({
          pullId: item.row.id,
          kind: item.slot.kind,
          slot: item.slot.slotIndex,
          response: responded ? 'answered' : 'dismissed',
          ...(answer?.grade ? { grade: answer.grade } : {}),
        });
        if (answer?.stance) await api.setConviction(item.row.id, answer.stance);
      } catch {
        /* a dropped interrupt record must never break the reading session */
      }
      if (responded) setRecalled((n) => n + 1);
      setSession((s) => persist({ ...s, interruptsShown: s.interruptsShown + 1 }));
    },
    [],
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
          <Interrupt
            key={`i-${item.index}-${item.row.id}`}
            kind={item.slot.kind}
            pull={item.row}
            onAnswer={(a) => void onInterrupt(item, a)}
            onDismiss={() => void onInterrupt(item, null)}
          />
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
