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
// The page's own events, as far as the hold listens to them.
const pageEvents = new Map<string, (e: Event) => void>();
vi.stubGlobal('addEventListener', (type: string, fn: (e: Event) => void) =>
  pageEvents.set(type, fn),
);

const {
  flushJudging,
  holdJudging,
  refreshJudging,
  releaseAllJudging,
  releaseJudging,
  sendAnswer,
  sendProgress,
} = await import('./study-sync.js');

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
  // This page's copies in memory, from the test before.
  releaseAllJudging('u1');
  releaseAllJudging('u2');
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
    nav.locks = locks;
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
    nav.locks = locks;
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

  it('is sent as judged when the page closed before the judgement landed', async () => {
    nav.locks = locks;
    holdElsewhere('u1', 'gone', { ...held, selfGrade: 'correct' });
    await flushJudging('u1');
    expect(api.recordAnswers.mock.calls[0]![0][0]).toMatchObject({
      clientEventId: 'held',
      selfGrade: 'correct',
    });
  });

  it('holds the page for its life, and says so', () => {
    nav.locks = locks;
    holdJudging('u1', held);
    expect([...heldLocks].some((n) => n.startsWith('wap.judging.'))).toBe(true);
  });

  it('is sent, not overwritten, when the next hold takes its place', async () => {
    holdJudging('u1', held);
    // The same answer, judged: the hold becomes the judgement, and nothing is sent.
    holdJudging('u1', { ...held, selfGrade: 'correct' });
    expect(api.recordAnswers).not.toHaveBeenCalled();
    // The next question's: the one it replaces goes first.
    holdJudging('u1', { ...held, clientEventId: 'next', itemId: 'q2' });
    await vi.waitFor(() => expect(sentIds()).toEqual(['held']));
    expect(api.recordAnswers.mock.calls[0]![0][0]).toMatchObject({ selfGrade: 'correct' });
    // Not under someone else's session, where it would be refused: queued for its reader.
    session.current = 'u2';
    holdJudging('u1', { ...held, clientEventId: 'third' });
    await Promise.resolve();
    expect(sentIds()).toEqual(['held']);
    expect(api.queueMutation).toHaveBeenCalledWith('u1', {
      kind: 'study-answer',
      event: expect.objectContaining({ clientEventId: 'next' }),
    });
  });

  it('lets go of a hold another page took, rather than writing it back', async () => {
    holdJudging('u1', held);
    // Taken by another page -- or removed with the account in another tab.
    store.delete(ownKey()!);
    refreshJudging(Date.now());
    expect(ownKey()).toBeUndefined();
    await flushJudging('u1', { own: true });
    expect(api.recordAnswers).not.toHaveBeenCalled();
  });

  it('says when the page goes, so another page can take its holds at once', () => {
    holdJudging('u1', held);
    // Kept in the back-forward cache, it has not gone.
    pageEvents.get('pagehide')!({ persisted: true } as unknown as Event);
    expect(JSON.parse(store.get(ownKey()!)!).heldAt).toBeGreaterThan(0);
    pageEvents.get('pagehide')!({ persisted: false } as unknown as Event);
    expect(JSON.parse(store.get(ownKey()!)!)).toMatchObject({ clientEventId: 'held', heldAt: 0 });
  });

  it('never leaves an older copy in storage to hide a newer one', async () => {
    holdJudging('u1', held);
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    holdJudging('u1', { ...held, clientEventId: 'next', itemId: 'q2' });
    setItem.mockRestore();
    expect(ownKey()).toBeUndefined();
    await flushJudging('u1', { own: true });
    await vi.waitFor(() => expect(sentIds().sort()).toEqual(['held', 'next']));
  });

  it('is taken from a page without Web Locks only once that page has gone quiet', async () => {
    holdElsewhere('u1', 'live', { ...held, heldAt: Date.now() });
    holdElsewhere('u1', 'quiet', { ...held, clientEventId: 'quiet', heldAt: Date.now() - 240_000 });
    await flushJudging('u1');
    expect(sentIds()).toEqual(['quiet']);
    expect(store.has('wap:study-judging:u1:live')).toBe(true);
  });

  it('is kept in memory when the page has no storage, and sent when the reader leaves', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    holdJudging('u1', held);
    setItem.mockRestore();
    expect(ownKey()).toBeUndefined();
    await flushJudging('u1', { own: true });
    expect(sentIds()).toEqual(['held']);
  });

  it('goes from every page with the account', () => {
    holdJudging('u1', held);
    holdElsewhere('u1', 'other');
    holdElsewhere('u2', 'other');
    releaseAllJudging('u1');
    expect([...store.keys()]).toEqual(['wap:study-judging:u2:other']);
  });
});
