import type * as api from './api.js';
import type { PendingWrite } from './offline.js';
import type * as stashApi from './stash-api.js';

/**
 * How a queued write turns back into the call that makes it real.
 *
 * This lived inside the Feed's drain effect as an if/else chain ending in a bare
 * `else await api.recordRead(write.pullId, 0, 0)` — a default branch that
 * silently claimed every kind it had not been taught. That is fine while every
 * member of `PendingWrite` carries a `pullId`; the moment one does not, a
 * collection delete replays as a read of `undefined` and nobody hears about it.
 * A `switch` over the discriminant with no default makes the compiler refuse the
 * next kind that is added without a branch here.
 *
 * It is also the reason this is a module rather than a closure. The suite runs
 * in `environment: 'node'`, so anything inside a component is untestable, and
 * "which call does this queued write become" is exactly the kind of ordinary
 * mapping that should not need a browser to check.
 *
 * The calls arrive as a port rather than being imported for real: `api.ts` and
 * `stash-api.ts` construct the Supabase client on import and throw without
 * `VITE_*` env, so a value import here would make this module untestable for a
 * dependency it only needs at runtime. The two `import type` lines above are
 * erased, and they are what keeps the port honest — the shapes are read off the
 * real functions, so a signature that changes breaks this file rather than
 * drifting away from it silently.
 */
export type ReplayPort = Pick<
  typeof api,
  'savePull' | 'unsavePull' | 'recordRead' | 'gradeRecall' | 'saveExplanation' | 'setConviction'
> &
  Pick<typeof stashApi, 'updateSavedItem' | 'createStash' | 'deleteStash'>;

export async function replayWrite(
  userId: string,
  write: PendingWrite,
  port: ReplayPort,
): Promise<void> {
  switch (write.kind) {
    case 'save':
      await port.savePull(write.pullId, userId);
      return;
    case 'unsave':
      await port.unsavePull(write.pullId, userId);
      return;
    /*
     * Dwell and position are zero, and that is the honest value rather than a
     * placeholder: nothing measured them for a card read offline, and inventing
     * a plausible number would put fiction into the knowledge model.
     */
    case 'read':
      await port.recordRead(write.pullId, 0, 0);
      return;
    // Queued by the Review screen, which has no drain of its own.
    case 'recall':
      // The provenance travels with the replay or the id is pointless: it is
      // what lets the server tell this attempt from a new one. An entry queued
      // before the field existed carries none and is applied, which is the old
      // behaviour and the right one for a write queued under the old rules.
      await port.gradeRecall(
        write.pullId,
        write.grade,
        write.mutationId && typeof write.submittedAt === 'number'
          ? {
              mutationId: write.mutationId,
              submittedAt: write.submittedAt,
              ...(write.confidence ? { confidence: write.confidence } : {}),
              ...(write.questionId ? { questionId: write.questionId } : {}),
              ...(write.recallKind ? { kind: write.recallKind } : {}),
              ...(typeof write.latencyMs === 'number' ? { latencyMs: write.latencyMs } : {}),
              ...(write.answer ? { answer: write.answer } : {}),
            }
          : undefined,
      );
      return;
    case 'explain':
      await port.saveExplanation(userId, write.pullId, write.text, write.mutationId);
      return;
    case 'conviction':
      await port.setConviction(write.pullId, write.stance, write.mutationId, write.submittedAt);
      return;
    case 'organise':
      await port.updateSavedItem(write.saveId, write.patch);
      return;
    case 'stash-create':
      await port.createStash(userId, {
        id: write.stashId,
        name: write.name,
        parentId: write.parentId,
      });
      return;
    case 'stash-delete':
      await port.deleteStash(write.stashId);
      return;
  }
  /*
   * Same guard, and here it is doing more than documenting itself: the drain
   * deletes an entry as soon as `apply` resolves, so a kind that fell through
   * this switch and returned would be reported as applied and thrown away. The
   * `never` refuses the next kind added without a branch; the throw keeps an
   * entry left behind by an older version of the app queued rather than losing
   * a write nobody made.
   */
  const unknown: never = write;
  throw new Error(`No replay for queued write ${String((unknown as { kind?: unknown }).kind)}`);
}
