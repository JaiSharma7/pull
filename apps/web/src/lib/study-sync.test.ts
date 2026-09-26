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
const session = vi.hoisted(() => ({ current: 'u1' as string | null }));
vi.mock('./supabase.js', () => ({ getCurrentUserId: () => session.current }));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
});

/*
 * Web Locks as far as the hold uses them: a lock is held until its callback settles, and
 * `ifAvailable` answers null for one that is held. Node has none, so each test says whether
 * the page has them.
 */
type LockCallback = (lock: { name: string } | null) => Promise<unknown>;
const heldLocks = new Set<string>();
const locks = {
  async request(name: string, a: LockCallback | { ifAvailable?: boolean }, b?: LockCallback) {
    const [options, callback] = typeof a === 'function' ? [{}, a] : [a, b!];
    if (heldLocks.has(name)) {
      if (options.ifAvailable) return callback(null);
      throw new Error('a test never waits on a lock');
    }
    heldLocks.add(name);
    try {
      return await callback({ name });
    } finally {
      heldLocks.delete(name);
    }
  },
};
const nav: { locks?: typeof locks } = {};
vi.stubGlobal('navigator', nav);

const { flushJudging, holdJudging, releaseAllJudging, releaseJudging, sendAnswer, sendProgress } =
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
  session.current = 'u1';
  delete nav.locks;
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
  // A hold left by another page of the same reader's -- one closed while its reader judged.
  const holdElsewhere = (userId = 'u1', page = 'gone', event: object = held) =>
    store.set(`wap:study-judging:${userId}:${page}`, JSON.stringify(event));
  const sentIds = () => api.recordAnswers.mock.calls.map((c) => c[0][0].clientEventId);
  const ownKey = () => [...store.keys()].find((k) => k.startsWith('wap:study-judging:u1:'));

  beforeEach(() => {
    api.recordAnswers.mockImplementation(async (events: { clientEventId: string }[]) =>
      recorded(events[0]!.clientEventId),
    );
  });

  it('is recorded as not had before the next answer, once', async () => {
    holdElsewhere();
    await sendAnswer('u1', event('next'));
    expect(sentIds()).toEqual(['held', 'next']);
    expect(api.recordAnswers.mock.calls[0]![0][0]).toMatchObject({ selfGrade: 'incorrect' });
    // Taken as it was sent: a second flush has nothing left.
    await flushJudging('u1');
    expect(api.recordAnswers).toHaveBeenCalledTimes(2);
  });

  it('is not sent from under the page still judging it, until the reader leaves', async () => {
    holdJudging('u1', held);
    // The shell's drain, and the next answer's own flush, leave it alone.
    await flushJudging('u1');
    await sendAnswer('u1', event('next'));
    expect(sentIds()).toEqual(['next']);
    // Leaving practice sends it.
    await flushJudging('u1', { own: true });
    expect(sentIds()).toEqual(['next', 'held']);
    expect(ownKey()).toBeUndefined();
  });

  it('is taken from another page only once that page is gone', async () => {
    nav.locks = locks;
    holdElsewhere('u1', 'alive');
    holdElsewhere('u1', 'gone', { ...held, clientEventId: 'gone' });
    heldLocks.add('wap.judging.alive');
    await flushJudging('u1');
    expect(sentIds()).toEqual(['gone']);
    expect(store.has('wap:study-judging:u1:alive')).toBe(true);
    heldLocks.delete('wap.judging.alive');
    await flushJudging('u1');
    expect(sentIds()).toEqual(['gone', 'held']);
  });

  it('is let go by its own judgement, and not by another answer’s', async () => {
    holdJudging('u1', held);
    releaseJudging('u1', 'another');
    expect(ownKey()).toBeDefined();
    releaseJudging('u1', 'held');
    expect(ownKey()).toBeUndefined();
    holdJudging('u1', held);
    releaseJudging('u1');
    await flushJudging('u1', { own: true });
    expect(api.recordAnswers).not.toHaveBeenCalled();
  });

  it('is sent only for the reader signed in, and waits for them', async () => {
    holdElsewhere();
    session.current = 'u2';
    await flushJudging('u1');
    session.current = null;
    await flushJudging('u1');
    expect(api.recordAnswers).not.toHaveBeenCalled();
    session.current = 'u1';
    await flushJudging('u1');
    expect(sentIds()).toEqual(['held']);
  });

  it('is one reader’s, and a malformed record is not sent', async () => {
    holdElsewhere('u1');
    session.current = 'u2';
    await flushJudging('u2');
    expect(api.recordAnswers).not.toHaveBeenCalled();
    holdElsewhere('u2', 'gone', { clientEventId: 'x', itemId: 'q1', response: 1 });
    await flushJudging('u2');
    expect(api.recordAnswers).not.toHaveBeenCalled();
  });

  it('goes from every page with the account', () => {
    holdJudging('u1', held);
    holdElsewhere('u1', 'other');
    holdElsewhere('u2', 'other');
    releaseAllJudging('u1');
    expect([...store.keys()]).toEqual(['wap:study-judging:u2:other']);
  });
});
