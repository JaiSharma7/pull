import { describe, expect, it } from 'vitest';
import { type PendingWrite, writeScope } from './offline.js';
import { type ReplayPort, replayWrite, StudyLimitReached } from './replay.js';

/**
 * Which call a queued write becomes.
 *
 * This mapping used to be an if/else chain inside the Feed's drain effect whose
 * last branch was a bare `else await api.recordRead(write.pullId, 0, 0)` — a
 * default that quietly claimed every kind it had not been taught. That is safe
 * only while every member of `PendingWrite` carries a `pullId`. The Library's
 * writes do not: an organising patch names a `saved_items` row and a collection
 * write names a `stashes` row, so under the old chain a deleted collection
 * replayed as a read of `undefined` and nothing said so.
 *
 * The suite runs in `environment: 'node'`, which is exactly why the mapping is a
 * module taking a port rather than a closure over `api.ts` — importing that
 * constructs a Supabase client and throws without `VITE_*` env.
 */

const USER = 'reader-1';

type Call = [string, ...unknown[]];

function recorder(): { calls: Call[]; port: ReplayPort } {
  const calls: Call[] = [];
  const port: ReplayPort = {
    savePull: async (pullId, userId) => {
      calls.push(['savePull', pullId, userId]);
    },
    unsavePull: async (pullId, userId) => {
      calls.push(['unsavePull', pullId, userId]);
    },
    recordRead: async (pullId, dwellMs, position) => {
      calls.push(['recordRead', pullId, dwellMs, position]);
    },
    gradeRecall: async (pullId, grade, provenance) => {
      calls.push(['gradeRecall', pullId, grade, provenance]);
    },
    saveExplanation: async (userId, pullId, text, mutationId) => {
      calls.push(['saveExplanation', userId, pullId, text, mutationId]);
    },
    setConviction: async (pullId, stance, mutationId, submittedAt) => {
      calls.push(['setConviction', pullId, stance, mutationId, submittedAt]);
    },
    updateSavedItem: async (saveId, patch) => {
      calls.push(['updateSavedItem', saveId, patch]);
    },
    createStash: async (userId, stash) => {
      calls.push(['createStash', userId, stash]);
    },
    deleteStash: async (id) => {
      calls.push(['deleteStash', id]);
    },
    recordProgress: async (events) => {
      calls.push(['recordProgress', events]);
      return { recorded: 1, duplicates: 0, refused: [] };
    },
    recordAnswers: async (events) => {
      calls.push(['recordAnswers', events]);
      return { recorded: 1, duplicates: 0, refused: [], results: [] };
    },
  };
  return { calls, port };
}

describe('a queued grade carries its own identity', () => {
  it('replays with the mutation id and everything recorded beside it', async () => {
    // The id is the whole point: `grade_recall` inserts the event keyed by it and
    // a replay of one already on record returns the state untouched. Dropping it
    // on the way out of the queue would leave the retry indistinguishable from a
    // new grade — which is the double-apply this mechanism exists to prevent.
    const { calls, port } = recorder();
    await replayWrite(
      USER,
      {
        kind: 'recall',
        pullId: 'p9',
        grade: 'hard',
        mutationId: 'm-grade',
        submittedAt: 1_700_000_000_123,
        confidence: 'sure',
        recallKind: 'calibration',
        latencyMs: 4_200,
      },
      port,
    );
    expect(calls).toEqual([
      [
        'gradeRecall',
        'p9',
        'hard',
        {
          mutationId: 'm-grade',
          submittedAt: 1_700_000_000_123,
          confidence: 'sure',
          kind: 'calibration',
          latencyMs: 4_200,
        },
      ],
    ]);
  });

  it('applies an entry queued before the field existed, rather than refusing it', async () => {
    // Half a provenance is not a provenance: without both halves the server
    // cannot order it or recognise it, so it is sent bare and applied.
    const { calls, port } = recorder();
    await replayWrite(USER, { kind: 'recall', pullId: 'p8', grade: 'good' }, port);
    await replayWrite(
      USER,
      { kind: 'recall', pullId: 'p7', grade: 'good', mutationId: 'm-no-stamp' },
      port,
    );
    expect(calls).toEqual([
      ['gradeRecall', 'p8', 'good', undefined],
      ['gradeRecall', 'p7', 'good', undefined],
    ]);
  });
});

describe('replayWrite', () => {
  it('turns every queued kind into the call that applies it', async () => {
    const writes: PendingWrite[] = [
      { kind: 'save', pullId: 'p1' },
      { kind: 'unsave', pullId: 'p1' },
      { kind: 'read', pullId: 'p2' },
      { kind: 'recall', pullId: 'p3', grade: 'good' },
      { kind: 'explain', pullId: 'p4', text: 'Because it compounds.', mutationId: 'm1' },
      {
        kind: 'conviction',
        pullId: 'p5',
        stance: 'disagree',
        mutationId: 'm2',
        submittedAt: 1_700_000_000_000,
      },
      { kind: 'organise', saveId: 'sv1', patch: { stashId: 'st1' } },
      { kind: 'stash-create', stashId: 'st2', name: 'Field notes', parentId: null },
      { kind: 'stash-delete', stashId: 'st3' },
    ];

    const { calls, port } = recorder();
    for (const write of writes) await replayWrite(USER, write, port);

    expect(calls).toEqual([
      ['savePull', 'p1', USER],
      ['unsavePull', 'p1', USER],
      // Zero dwell and zero position because nothing measured them offline.
      // Inventing a plausible number would put fiction into the knowledge model.
      ['recordRead', 'p2', 0, 0],
      // No provenance: an entry queued before the field existed replays as it
      // did, which is what makes it applicable at all — without an id the
      // server has nothing to recognise, so it must apply the write.
      ['gradeRecall', 'p3', 'good', undefined],
      ['saveExplanation', USER, 'p4', 'Because it compounds.', 'm1'],
      ['setConviction', 'p5', 'disagree', 'm2', 1_700_000_000_000],
      ['updateSavedItem', 'sv1', { stashId: 'st1' }],
      ['createStash', USER, { id: 'st2', name: 'Field notes', parentId: null }],
      ['deleteStash', 'st3'],
    ]);
  });

  it('replays an organising patch as a saved-item update, never as a read', async () => {
    // The exact shape of the old default branch: a write with no `pullId`
    // reaching `recordRead` and recording a read of `undefined`.
    const { calls, port } = recorder();
    await replayWrite(USER, { kind: 'organise', saveId: 'sv1', patch: { archived: true } }, port);

    expect(calls.map(([fn]) => fn)).toEqual(['updateSavedItem']);
    expect(calls).toEqual([['updateSavedItem', 'sv1', { archived: true }]]);
  });

  it('replays a collection create with the id the client minted', async () => {
    // Without the id, `createStash` lets Postgres pick one and a retry after a
    // lost response makes a second folder with the same name. With it, the retry
    // collides on the primary key and `createStash` treats that as success.
    const { calls, port } = recorder();
    await replayWrite(
      USER,
      { kind: 'stash-create', stashId: 'st-9', name: 'Field notes', parentId: 'st-1' },
      port,
    );

    expect(calls).toEqual([
      ['createStash', USER, { id: 'st-9', name: 'Field notes', parentId: 'st-1' }],
    ]);
  });

  it('refuses a kind it has no branch for, rather than reporting it applied', async () => {
    // Only reachable for an entry IndexedDB kept across a version of the app
    // that dropped a kind — the compiler forbids it within one version. The
    // drain deletes an entry the moment `apply` resolves, so returning quietly
    // here would throw away a write that was never made.
    const { calls, port } = recorder();
    await expect(
      replayWrite(USER, { kind: 'from-a-later-version' } as unknown as PendingWrite, port),
    ).rejects.toThrow(/from-a-later-version/);
    expect(calls).toEqual([]);
  });

  it('makes exactly one call per write', async () => {
    // A drain deletes the entry once `apply` resolves, so a kind that quietly
    // did nothing would drop the write and report it applied.
    const { calls, port } = recorder();
    await replayWrite(USER, { kind: 'stash-delete', stashId: 'st3' }, port);
    expect(calls).toHaveLength(1);
  });
});

describe('a queued study event', () => {
  const progress = {
    clientEventId: 'e1',
    kind: 'lesson_read' as const,
    lessonId: 'l1',
    occurredAt: '2026-09-25T10:00:00.000Z',
  };
  const answer = { clientEventId: 'a1', itemId: 'q1', response: [1, 0, 2] };

  it('replays as a batch of one, with everything it carried', async () => {
    const { calls, port } = recorder();
    await replayWrite(USER, { kind: 'study-progress', event: progress }, port);
    await replayWrite(USER, { kind: 'study-answer', event: answer }, port);
    expect(calls).toEqual([
      ['recordProgress', [progress]],
      ['recordAnswers', [answer]],
    ]);
  });

  it('stays queued when refused for today, and is dropped when refused for good', async () => {
    const { port } = recorder();
    const limited: ReplayPort = {
      ...port,
      recordAnswers: async () => ({
        recorded: 0,
        duplicates: 0,
        refused: [{ index: 0, clientEventId: 'a1', reason: 'limit' }],
        results: [],
      }),
    };
    await expect(
      replayWrite(USER, { kind: 'study-answer', event: answer }, limited),
    ).rejects.toBeInstanceOf(StudyLimitReached);

    const gone: ReplayPort = {
      ...port,
      recordProgress: async () => ({
        recorded: 0,
        duplicates: 0,
        refused: [{ index: 0, clientEventId: 'e1', reason: 'not_found' }],
      }),
    };
    await expect(
      replayWrite(USER, { kind: 'study-progress', event: progress }, gone),
    ).resolves.toBeUndefined();
  });

  it('keeps a course’s study answers in one order, and a lesson’s events in theirs', () => {
    // An answer to another question on the same idea is hinted by, and moves the memory
    // after, the one before it: they wait for each other -- within their course.
    expect(writeScope({ kind: 'study-answer', event: answer, courseId: 'c1' })).toBe(
      'study-answers:c1',
    );
    expect(
      writeScope({ kind: 'study-answer', event: { ...answer, itemId: 'q2' }, courseId: 'c1' }),
    ).toBe('study-answers:c1');
    expect(writeScope({ kind: 'study-answer', event: answer, courseId: 'c2' })).toBe(
      'study-answers:c2',
    );
    // Queued without its course, it keeps its question's order.
    expect(writeScope({ kind: 'study-answer', event: answer })).toBe('study-item:q1');
    expect(writeScope({ kind: 'study-progress', event: progress })).toBe('study-lesson:l1');
    expect(
      writeScope({
        kind: 'study-progress',
        event: { clientEventId: 'e2', kind: 'item_shown', itemId: 'q1', occurredAt: 'x' },
      }),
    ).toBe('study-item:q1');
  });
});
