/**
 * Sending a study course's events -- progress and answers -- so that none is lost to a
 * dropped connection.
 *
 * Each goes to the server at once. When it cannot get there, it goes into the app's offline
 * queue (`offline.ts`), which the shell drains when the connection returns (`replay.ts`), so
 * a lesson read or a question answered on a train is recorded when the train comes out of
 * the tunnel. Both are safe to send twice: each carries a client event id the server records
 * once. The server's refusals come back in the answer rather than as errors, and they split
 * two ways: `limit` clears at 00:00 UTC, so the event is queued for then; the rest are final
 * -- the lesson or question is gone, or was never shown -- and the event is dropped.
 */
import { queueMutation } from './offline.js';
import { isPermanentFailure } from './rpc-error.js';
import { getCurrentUserId } from './supabase.js';
import type { ProgressEvent } from './study-course.js';
import { recordAnswers, recordProgress } from './study-course-api.js';
import type { AnswerEvent, AnswerResult } from './study-practice.js';

/**
 * What became of an event: recorded (or already); kept for when it can be sent -- `full` when
 * what holds it is the day's limit rather than the connection; refused; or lost.
 */
export type Sent = 'recorded' | 'queued' | 'full' | 'refused' | 'failed';

/**
 * A failure worth queueing: every one the drain would keep. The request never reached
 * Postgres; reached a server that could not answer; lost a race or waited too long for a
 * lock (40P01, 40001, 57014, 55P03); or went out without its session while a refresh failed
 * (28000). Sent again, each is recorded. Only a refusal that cannot change on a retry --
 * `isPermanentFailure`, the drain's own rule -- is not worth keeping. The two used to
 * disagree, and an answer the drain would have kept was dropped at the door.
 */
function worthQueueing(error: unknown): boolean {
  return !isPermanentFailure(error);
}

export async function sendProgress(userId: string, event: ProgressEvent): Promise<Sent> {
  try {
    const result = await recordProgress([event]);
    const refusal = result.refused[0];
    if (!refusal) return 'recorded';
    if (refusal.reason !== 'limit') return 'refused';
    return (await queueMutation(userId, { kind: 'study-progress', event })) ? 'queued' : 'failed';
  } catch (error: unknown) {
    if (!worthQueueing(error)) return 'failed';
    return (await queueMutation(userId, { kind: 'study-progress', event })) ? 'queued' : 'failed';
  }
}

export interface AnswerSent {
  sent: Sent;
  /** The server's grade, when it answered; null when the answer is queued or was refused. */
  result: AnswerResult | null;
}

/** An answer as the offline queue keeps it: with its course, so it waits in that course's order. */
const answerWrite = (event: AnswerEvent, courseId?: string) => ({
  kind: 'study-answer' as const,
  event,
  ...(courseId ? { courseId } : {}),
});

export async function sendAnswer(
  userId: string,
  event: AnswerEvent,
  courseId?: string,
): Promise<AnswerSent> {
  const write = answerWrite(event, courseId);
  // An answer left unjudged goes first, so the one after it is judged as following it -- and
  // when it had to wait in the queue, this one waits behind it rather than overtaking it:
  // the hint the server derives from it is timed as answers arrive.
  const behind = await flushJudging(userId);
  if (behind) {
    const queued = await queueMutation(userId, write);
    return { sent: queued ? behind : 'failed', result: null };
  }
  try {
    const recorded = await recordAnswers([event]);
    const result = recorded.results[0] ?? null;
    if (result) return { sent: 'recorded', result };
    const refusal = recorded.refused[0];
    if (refusal?.reason === 'limit') {
      const queued = await queueMutation(userId, write);
      return { sent: queued ? 'full' : 'failed', result: null };
    }
    return { sent: 'refused', result: null };
  } catch (error: unknown) {
    if (!worthQueueing(error)) return { sent: 'failed', result: null };
    const queued = await queueMutation(userId, write);
    return { sent: queued ? 'queued' : 'failed', result: null };
  }
}

/*
 * An answer shown for judging. Judging a short answer shows the course's answer, so a reader
 * who leaves then has seen it, and the next answer to that question is practice, not proof --
 * which the server can only know from an answer on record. It is held here when judging
 * starts; once the reader judges, the hold is the judgement, until that is recorded or
 * queued. If the page goes first -- or the reader leaves practice before judging -- it is
 * sent as it stands: as judged, or as not had. In local storage, because it must outlive the
 * page (and in memory as well, for a page that has none); it holds what they typed, as a
 * queued answer does, and waits through a sign-out for the same reader.
 *
 * Held per page, not per reader: a flush elsewhere -- the shell's drain, another tab -- must
 * not send a hold whose page is still judging, which recorded the attempt twice, and two
 * tabs judging at once must not let go of each other's. Each page holds a Web Lock for its
 * life, and a hold is taken only from a page whose lock is free: a page that is gone. Without
 * Web Locks (an insecure origin, an old browser) a page keeps its holds' `heldAt` fresh
 * instead, and another page takes one only once it has gone stale. A page takes its own only
 * when the reader leaves practice, or when the next hold would overwrite it. And the
 * judgement is sent with the hold's own event id, so whatever races, the attempt is recorded
 * once.
 */
const PAGE =
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const JUDGING = 'wap:study-judging:';
const judgingKey = (userId: string, page = PAGE) => `${JUDGING}${userId}:${page}`;
const pageLock = (page: string) => `wap.judging.${page}`;
/**
 * How often a page without Web Locks says its holds are live, and when one is not: minutes,
 * as a hidden tab's timers run once a minute at best. A page that goes says so at once
 * (`pagehide`), so its holds are not left waiting that long.
 */
const HEARTBEAT_MS = 15_000;
const STALE_MS = 180_000;

/**
 * This page's holds, as written: the copy a page without storage keeps, and whether storage
 * took it -- a hold gone from storage since was taken, or deleted, by another page.
 */
const mine = new Map<string, { raw: string; stored: boolean }>();

let pageLocked = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;
function keepPageAlive(): void {
  const locks = globalThis.navigator?.locks;
  if (locks) {
    if (pageLocked) return;
    pageLocked = true;
    // Never released while the page lives; the browser releases it when the page goes.
    void locks
      .request(pageLock(PAGE), () => new Promise<void>(() => undefined))
      .catch(() => {
        pageLocked = false;
      });
    return;
  }
  if (heartbeat) return;
  heartbeat = setInterval(() => refreshJudging(Date.now()), HEARTBEAT_MS);
  // Never what keeps a process alive where timers can (a test runner).
  (heartbeat as { unref?: () => void }).unref?.();
  globalThis.addEventListener?.('pagehide', (e: Event) => {
    if (!(e as PageTransitionEvent).persisted) refreshJudging(0);
  });
}

/**
 * Say this page's holds are live as of `at` -- or, at 0, that the page is going and another
 * may take them now. A hold another page has taken, or an account deletion removed, is let
 * go here too, never written back.
 */
export function refreshJudging(at: number): void {
  for (const [key, { raw, stored }] of [...mine]) {
    let gone = false;
    try {
      gone = stored && localStorage.getItem(key) === null;
    } catch {
      /* no storage: nothing else could have taken it */
    }
    if (gone) mine.delete(key);
    else write(key, { ...(JSON.parse(raw) as object), heldAt: at });
  }
}

function write(key: string, value: object): void {
  const raw = JSON.stringify(value);
  try {
    localStorage.setItem(key, raw);
    mine.set(key, { raw, stored: true });
  } catch {
    // No storage, or none left: the copy in memory is all there is, and it goes with the
    // page. An older copy left in storage would be read before it, so it goes.
    mine.set(key, { raw, stored: false });
    try {
      localStorage.removeItem(key);
    } catch {
      /* as above */
    }
  }
}

function read(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) return raw;
  } catch {
    /* as above */
  }
  return mine.get(key)?.raw ?? null;
}

function remove(key: string): void {
  mine.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* as above */
  }
}

/**
 * Hold an answer for this page. A different answer already held here -- a judgement still on
 * its way when the next question went to judging, or one a sign-out left unsent -- is sent
 * first rather than overwritten: the server keeps one answer per event id, so a judgement
 * that did land is not recorded twice. The course goes with it, so a hold sent or queued
 * later keeps its place among that course's answers (`writeScope`).
 */
export function holdJudging(userId: string, event: AnswerEvent, courseId?: string): void {
  keepPageAlive();
  const key = judgingKey(userId);
  const displaced = parseHold(read(key));
  if (displaced && displaced.event.clientEventId !== event.clientEventId) {
    // Under someone else's session it would be refused and lost: queued, it waits for its
    // reader, as their other answers do.
    if (getCurrentUserId() === userId) void sendHold(userId, displaced);
    else void queueMutation(userId, answerWrite(displaced.event, displaced.courseId));
  }
  write(key, { ...event, heldAt: Date.now(), ...(courseId ? { courseId } : {}) });
}

/**
 * Let go of this page's hold -- only the one sent as `clientEventId`, when given, so an answer
 * recorded late does not let go of the hold of the question after it.
 */
export function releaseJudging(userId: string, clientEventId?: string): void {
  const key = judgingKey(userId);
  if (clientEventId !== undefined && parseHold(read(key))?.event.clientEventId !== clientEventId) {
    return;
  }
  remove(key);
}

/** Every page's hold of this reader's, for an account being deleted. */
export function releaseAllJudging(userId: string): void {
  for (const key of judgingKeys(userId)) remove(key);
  for (const key of [...mine.keys()]) if (key.startsWith(`${JUDGING}${userId}:`)) remove(key);
}

function judgingKeys(userId: string): string[] {
  const keys = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(`${JUDGING}${userId}:`)) keys.add(key);
    }
  } catch {
    /* no storage */
  }
  for (const key of mine.keys()) if (key.startsWith(`${JUDGING}${userId}:`)) keys.add(key);
  return [...keys];
}

/** A held answer, and the course it was given in, when the page said. */
interface Held {
  event: AnswerEvent;
  courseId?: string;
}

const sendHold = (userId: string, held: Held) => sendAnswer(userId, held.event, held.courseId);

function parseHold(raw: string | null): Held | null {
  if (raw === null) return null;
  try {
    const held = JSON.parse(raw) as (Partial<AnswerEvent> & { courseId?: unknown }) | null;
    if (
      !held ||
      typeof held.clientEventId !== 'string' ||
      typeof held.itemId !== 'string' ||
      typeof held.response !== 'string' ||
      (held.selfGrade !== 'incorrect' && held.selfGrade !== 'correct')
    ) {
      return null;
    }
    return {
      event: {
        clientEventId: held.clientEventId,
        itemId: held.itemId,
        response: held.response,
        selfGrade: held.selfGrade,
        ...(held.hinted === true ? { hinted: true } : {}),
      },
      ...(typeof held.courseId === 'string' && held.courseId ? { courseId: held.courseId } : {}),
    };
  } catch {
    return null;
  }
}

/** Whether a page without Web Locks has let a hold go stale: it is gone. */
function stale(raw: string | null): boolean {
  try {
    const heldAt = (JSON.parse(raw ?? 'null') as { heldAt?: unknown } | null)?.heldAt;
    return typeof heldAt !== 'number' || Date.now() - heldAt > STALE_MS;
  } catch {
    return true;
  }
}

/** Taken as it is read, so it goes once. */
function takeJudging(key: string): Held | null {
  const held = parseHold(read(key));
  remove(key);
  return held;
}

/**
 * Record the answers this reader left held: every page's that is gone, and this page's own
 * when `own` -- the reader leaving practice -- as judged, or as not had. Only for the reader
 * signed in, asked again before each: sent under someone else's session it was refused and
 * lost, and it is theirs to send when they are back. Says whether one had to wait in the
 * queue instead -- `full` when the day's record is -- so an answer after it can wait too.
 */
export async function flushJudging(
  userId: string,
  { own = false } = {},
): Promise<'queued' | 'full' | null> {
  const signedIn = () => getCurrentUserId() === userId;
  if (!signedIn()) return null;
  let behind: 'queued' | 'full' | null = null;
  const note = ({ sent }: AnswerSent) => {
    if (sent === 'full') behind = 'full';
    else if (sent === 'queued') behind ??= 'queued';
  };
  // This page's own is taken before anything is waited on: a practice run begun meanwhile
  // holds its own answer under the same key.
  const ours = own ? takeJudging(judgingKey(userId)) : null;
  if (ours) note(await sendHold(userId, ours));
  const locks = globalThis.navigator?.locks;
  for (const key of judgingKeys(userId)) {
    if (key === judgingKey(userId)) continue;
    const send = async () => {
      if (!signedIn()) return;
      const held = takeJudging(key);
      if (held) note(await sendHold(userId, held));
    };
    if (locks) {
      const page = key.slice(`${JUDGING}${userId}:`.length);
      await locks.request(pageLock(page), { ifAvailable: true }, async (lock) => {
        if (lock) await send();
      });
    } else if (stale(read(key))) {
      await send();
    }
  }
  return behind;
}
