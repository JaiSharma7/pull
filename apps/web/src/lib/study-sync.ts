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
import { isOfflineFailure, queueMutation } from './offline.js';
import { sqlState } from './rpc-error.js';
import type { ProgressEvent } from './study-course.js';
import { recordAnswers, recordProgress } from './study-course-api.js';
import type { AnswerEvent, AnswerResult } from './study-practice.js';

/** What became of an event: recorded (or already), kept for later, refused, or lost. */
export type Sent = 'recorded' | 'queued' | 'refused' | 'failed';

/** Postgres gave up on the transaction, not on the event: a deadlock, or a serialization failure. */
const TRANSIENT = new Set(['40P01', '40001']);

/**
 * A failure worth queueing: the request never reached Postgres, reached a server that could
 * not answer, or lost a race another transaction won -- sent again, it is recorded. Any other
 * refusal from Postgres itself -- it has a SQLSTATE -- will not change on a retry, and
 * queueing it would only replay it forever.
 */
function worthQueueing(error: unknown): boolean {
  const state = sqlState(error);
  return isOfflineFailure(error) || state === undefined || TRANSIENT.has(state);
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
  try {
    const recorded = await recordAnswers([event]);
    const result = recorded.results[0] ?? null;
    if (result) return { sent: 'recorded', result };
    const refusal = recorded.refused[0];
    if (refusal?.reason === 'limit') {
      const queued = await queueMutation(userId, { kind: 'study-answer', event });
      return { sent: queued ? 'queued' : 'failed', result: null };
    }
    return { sent: 'refused', result: null };
  } catch (error: unknown) {
    if (!worthQueueing(error)) return { sent: 'failed', result: null };
    const queued = await queueMutation(userId, { kind: 'study-answer', event });
    return { sent: queued ? 'queued' : 'failed', result: null };
  }
}
