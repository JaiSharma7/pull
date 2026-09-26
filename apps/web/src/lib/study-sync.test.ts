import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Sending a study event, without a network or IndexedDB: the recorder and the queue are
 * supplied, and what is asserted is where each outcome goes -- recorded, kept for later, or
 * given up -- and that an answer left unjudged is recorded before the next one.
 */
const api = vi.hoisted(() => ({
  recordAnswers: vi.fn(),
  recordProgress: vi.fn(),
  queueMutation: vi.fn(async () => true),
}));
vi.mock('./study-course-api.js', () => ({
  recordAnswers: api.recordAnswers,
  recordProgress: api.recordProgress,
}));
vi.mock('./offline.js', () => ({ queueMutation: api.queueMutation }));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { flushJudging, holdJudging, releaseJudging, sendAnswer, sendProgress } =
  await import('./study-sync.js');

const event = (id = 'e1') => ({ clientEventId: id, itemId: 'q1', response: 'restudying' });
const pgError = (code: string) => {
  // The shape `rpcError` gives a PostgREST refusal.
  const e = new Error(`failed with ${code}`);
  e.name = `PostgrestError ${code}`;
  return e;
};
const recorded = (clientEventId: string) => ({
  recorded: 1,
  duplicates: 0,
  refused: [],
  results: [
    {
      clientEventId,
      itemId: 'q1',
      correct: true,
      grading: 'deterministic',
      hinted: false,
      provesRecall: true,
    },
  ],
});

beforeEach(() => {
  api.recordAnswers.mockReset();
  api.recordProgress.mockReset();
  api.queueMutation.mockClear();
  store.clear();
});

describe('sendAnswer', () => {
  it('keeps what a retry would record: a lost race, a lock wait, a missing session', async () => {
    for (const code of ['40P01', '40001', '57014', '55P03', '28000']) {
      api.recordAnswers.mockRejectedValueOnce(pgError(code));
      const out = await sendAnswer('u1', event());
      expect(out.sent, code).toBe('queued');
    }
    expect(api.queueMutation).toHaveBeenCalledTimes(5);
  });

  it('gives up only on a refusal a retry cannot change', async () => {
    api.recordAnswers.mockRejectedValueOnce(pgError('23503'));
    expect((await sendAnswer('u1', event())).sent).toBe('failed');
    expect(api.queueMutation).not.toHaveBeenCalled();
  });

  it('says a limit is the day, not the connection, and keeps the answer', async () => {
    api.recordAnswers.mockResolvedValueOnce({
      recorded: 0,
      duplicates: 0,
      refused: [{ index: 0, clientEventId: 'e1', reason: 'limit' }],
      results: [],
    });
    expect((await sendAnswer('u1', event())).sent).toBe('full');
    expect(api.queueMutation).toHaveBeenCalledOnce();
  });

  it('drops an answer to a question that is gone', async () => {
    api.recordAnswers.mockResolvedValueOnce({
      recorded: 0,
      duplicates: 0,
      refused: [{ index: 0, clientEventId: 'e1', reason: 'not_found' }],
      results: [],
    });
    expect((await sendAnswer('u1', event())).sent).toBe('refused');
    expect(api.queueMutation).not.toHaveBeenCalled();
  });
});

describe('sendProgress', () => {
  it('keeps a lock wait as an answer does', async () => {
    api.recordProgress.mockRejectedValueOnce(pgError('57014'));
    const out = await sendProgress('u1', {
      clientEventId: 'p1',
      kind: 'lesson_read',
      lessonId: 'l1',
      occurredAt: '2026-09-26T00:00:00Z',
    });
    expect(out).toBe('queued');
  });
});

describe('an answer left unjudged', () => {
  const held = {
    clientEventId: 'held',
    itemId: 'q1',
    response: 'no idea',
    selfGrade: 'incorrect' as const,
  };

  it('is recorded as not had before the next answer, once', async () => {
    holdJudging('u1', held);
    api.recordAnswers.mockImplementation(async (events: { clientEventId: string }[]) =>
      recorded(events[0]!.clientEventId),
    );
    await sendAnswer('u1', event('next'));
    expect(api.recordAnswers.mock.calls.map((c) => c[0][0].clientEventId)).toEqual([
      'held',
      'next',
    ]);
    expect(api.recordAnswers.mock.calls[0]![0][0]).toMatchObject({ selfGrade: 'incorrect' });
    // Taken as it was sent: a second flush has nothing left.
    await flushJudging('u1');
    expect(api.recordAnswers).toHaveBeenCalledTimes(2);
  });

  it('is let go when the reader judges it', async () => {
    holdJudging('u1', held);
    releaseJudging('u1');
    await flushJudging('u1');
    expect(api.recordAnswers).not.toHaveBeenCalled();
  });

  it('is one reader’s, and a malformed record is not sent', async () => {
    holdJudging('u1', held);
    await flushJudging('u2');
    expect(api.recordAnswers).not.toHaveBeenCalled();
    store.set('wap:study-judging:u2', '{"clientEventId":"x","itemId":"q1","response":1}');
    await flushJudging('u2');
    expect(api.recordAnswers).not.toHaveBeenCalled();
  });
});
