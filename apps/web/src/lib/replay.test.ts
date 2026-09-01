import { describe, expect, it } from 'vitest';
import type { PendingWrite } from './offline.js';
import { type ReplayPort, replayWrite } from './replay.js';

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
    gradeRecall: async (pullId, grade) => {
      calls.push(['gradeRecall', pullId, grade]);
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
  };
  return { calls, port };
}

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
      ['gradeRecall', 'p3', 'good'],
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
