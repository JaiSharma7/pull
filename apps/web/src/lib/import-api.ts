/**
 * The network half of keeping highlights.
 *
 * `lib/ingestion.ts` parses and shapes, `lib/import-fold.ts` folds the chunks, and this
 * is the only one of the three that sends. The split is what makes the other two
 * testable: this module imports `lib/supabase.ts`, which throws at import under vitest.
 *
 * Two RPCs, both `security definer`, because a reader may not insert the
 * works/summaries/pulls triple and must not be given policies that would let them. See
 * `20260905110000_your_highlights_are_yours_to_keep.sql`.
 */

import {
  foldChunks,
  type ImportResult,
  type ImportSourceKind,
  type UndoResult,
} from './import-fold.js';
import type { ImportItem } from './ingestion.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

export type {
  CommitChunk,
  ImportedWork,
  ImportResult,
  ImportSourceKind,
  UndoResult,
} from './import-fold.js';
export { foldChunks, hashFile } from './import-fold.js';

/**
 * Keep a batch of highlights.
 *
 * Chunked at 500 because that is `max_items_per_call`, and the chunks are joined by
 * `p_import_id`: the first call returns an `importId` and every later call passes it
 * back, so the whole file is one batch. That is a fact the client knows rather than one
 * the server infers from a clock — `commit_import`'s time window is the fallback for a
 * caller that does not say.
 *
 * ACCUMULATED ACROSS CHUNKS, not read off the last one. Each call reports only what that
 * call did, so returning the final chunk's numbers would tell a reader who imported 3,000
 * highlights that they had kept the last 500.
 *
 * A chunk that fails aborts the rest, and what landed stays landed — `commit_import` is
 * one transaction per call, not one per file. The reader gets the error and an `importId`
 * for what did land, which is what makes Undo reachable after a partial import.
 */

/**
 * Keep a batch of highlights.
 *
 * Chunked at 500 because that is `max_items_per_call`. A chunk that fails aborts the
 * rest, and what landed stays landed -- `commit_import` is one transaction per call, not
 * one per file. The reader gets the error, and the `importId` of what did land is what
 * makes Undo reachable after a partial import.
 */
export async function commitImport(
  sourceKind: ImportSourceKind,
  fileHash: string | null,
  items: readonly ImportItem[],
): Promise<ImportResult> {
  return foldChunks(items, async (chunk, importId) => {
    const { data, error } = await supabase.rpc('commit_import', {
      p_source_kind: sourceKind,
      // `as never` on both, for two different reasons the generator creates.
      //
      // `p_file_hash` is `text` with no default, so `db:types` renders it `string` --
      // but the column it feeds is nullable and `commit_import` branches on
      // `p_file_hash is null` to give a hashless source its own reuse window. Omitting
      // the argument is not the same thing: the parameter has no default, so PostgREST
      // would fail to resolve the function at all. Null is the value to send.
      p_file_hash: fileHash as never,
      // `p_items` is `jsonb`, rendered as the recursive `Json` union, which an interface
      // with optional properties is not assignable to however well-formed it is.
      p_items: chunk as never,
      ...(importId ? { p_import_id: importId } : {}),
    });

    if (error) throw rpcError(error);
    return (data ?? {}) as Partial<ImportResult>;
  });
}

/** Take a whole batch back. Idempotent: a second call reports `alreadyUndone`. */
export async function undoImport(importId: string): Promise<UndoResult> {
  const { data, error } = await supabase.rpc('undo_import', { p_import_id: importId });
  if (error) throw rpcError(error);
  return data as unknown as UndoResult;
}
