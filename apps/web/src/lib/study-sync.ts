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

export async function sendAnswer(userId: string, event: AnswerEvent): Promise<AnswerSent> {
  // An answer left unjudged goes first, so the one after it is judged as following it.
  await flushJudging(userId);
  try {
    const recorded = await recordAnswers([event]);
    const result = recorded.results[0] ?? null;
    if (result) return { sent: 'recorded', result };
    const refusal = recorded.refused[0];
    if (refusal?.reason === 'limit') {
      const queued = await queueMutation(userId, { kind: 'study-answer', event });
      return { sent: queued ? 'full' : 'failed', result: null };
    }
    return { sent: 'refused', result: null };
  } catch (error: unknown) {
    if (!worthQueueing(error)) return { sent: 'failed', result: null };
    const queued = await queueMutation(userId, { kind: 'study-answer', event });
    return { sent: queued ? 'queued' : 'failed', result: null };
  }
}

/*
 * An answer shown for judging and not yet judged. Judging a short answer shows the course's
 * answer, so a reader who leaves then has seen it, and the next answer to that question is
 * practice, not proof -- which the server can only know from an answer on record. It is held
 * here when judging starts and let go when the reader judges; if the reader leaves instead --
 * inside the app, or by closing or reloading the page -- it is sent as not had, before any
 * other answer of theirs. In local storage, keyed by reader, because it must outlive the page;
 * it holds what they typed, as a queued answer does, and is cleared with their account.
 */
const judgingKey = (userId: string) => `wap:study-judging:${userId}`;

export function holdJudging(userId: string, event: AnswerEvent): void {
  try {
    localStorage.setItem(judgingKey(userId), JSON.stringify(event));
  } catch {
    /* no storage: judged or not, nothing outlives the page */
  }
}

export function releaseJudging(userId: string): void {
  try {
    localStorage.removeItem(judgingKey(userId));
  } catch {
    /* as above */
  }
}

function takeJudging(userId: string): AnswerEvent | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(judgingKey(userId));
    localStorage.removeItem(judgingKey(userId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const held = JSON.parse(raw) as Partial<AnswerEvent> | null;
    if (
      !held ||
      typeof held.clientEventId !== 'string' ||
      typeof held.itemId !== 'string' ||
      typeof held.response !== 'string' ||
      held.selfGrade !== 'incorrect'
    ) {
      return null;
    }
    return {
      clientEventId: held.clientEventId,
      itemId: held.itemId,
      response: held.response,
      selfGrade: 'incorrect',
      ...(held.hinted === true ? { hinted: true } : {}),
    };
  } catch {
    return null;
  }
}

/** Record an answer left unjudged, as not had. Taken before it is sent, so it goes once. */
export async function flushJudging(userId: string): Promise<void> {
  const held = takeJudging(userId);
  if (held) await sendAnswer(userId, held);
}
