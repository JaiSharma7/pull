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
import type { ImportBatch, ImportedItem } from './imports.js';
import type { ImportItem } from './ingestion.js';
import { pageAfter } from './paging.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/*
 * RE-EXPORTED ONLY WHERE A CALLER OF THIS MODULE ACTUALLY NEEDS IT.
 *
 * `foldChunks`, `CommitChunk` and `ImportedWork` used to be here too, and nothing took
 * them from this file -- every consumer imports them from `./import-fold.js`. The first
 * two are the ones that mattered: they exist precisely so the chunking is reachable
 * WITHOUT `lib/supabase.ts`, and offering them through the module that imports it is an
 * invitation to re-create the collect failure the split was made to prevent. Review
 * found all three unused.
 */
export type { ImportResult, ImportSourceKind, UndoResult } from './import-fold.js';
export { hashFile, mergeAttempts, PartialImportError } from './import-fold.js';
export type { ImportBatch, ImportedItem, ImportedWorkGroup } from './imports.js';
export {
  groupImported,
  importBatchLabel,
  importedSummary,
  isUndoable,
  SOURCE_KIND_LABEL,
} from './imports.js';

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
 * for what did land, carried on `PartialImportError`, which is what makes Undo reachable
 * after a partial import. Pass that id back as `resumeImportId` to retry: the rest of the
 * file then joins the batch the first attempt opened, rather than opening a second one
 * that a single Undo could not take back.
 */
export async function commitImport(
  sourceKind: ImportSourceKind,
  fileHash: string | null,
  items: readonly ImportItem[],
  resumeImportId: string | null = null,
): Promise<ImportResult> {
  return foldChunks(
    items,
    async (chunk, importId) => {
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
    },
    resumeImportId,
  );
}

/**
 * Take a whole batch back. Idempotent: a second call reports `alreadyUndone` and, having
 * nothing left to count, omits `alsoRemoved` -- which is why that field is optional.
 *
 * A null body is refused rather than cast. PostgREST hands back `null` data for a
 * function that returned SQL NULL, and `as unknown as UndoResult` would turn that into an
 * object whose every field is `undefined` -- a silent no-op Undo that reports success.
 * `commitImport` has guarded this since it was written; this did not.
 */
export async function undoImport(importId: string): Promise<UndoResult> {
  const { data, error } = await supabase.rpc('undo_import', { p_import_id: importId });
  if (error) throw rpcError(error);
  if (!data) throw new Error('The undo returned nothing, so nothing can be said about it.');
  return data as unknown as UndoResult;
}

/* --- Reading back what was kept ------------------------------------------ */

/**
 * The reader's import batches, newest first.
 *
 * Paged, because `max_rows` is 100 and law 3 promises unlimited stashing: a
 * reader who has imported a hundred and one files must not be shown a hundred
 * with nothing saying the list is partial. Keyed on `id` rather than offset, for
 * the reason `paging.ts` sets out — an offset shifts under a concurrent write,
 * and this reader's other tab can be committing an import while this walk runs.
 *
 * `id` order is not `created_at` order (it is a uuid), so the walk is unordered
 * and the sort happens here, over rows that are all in hand.
 */
export async function fetchImports(userId: string): Promise<ImportBatch[]> {
  const rows = await pageAfter<{
    id: string;
    source_kind: string;
    item_count: number;
    duplicate_count: number;
    work_count: number;
    created_at: string;
    undone_at: string | null;
  }>((after, limit) => {
    let q = supabase
      .from('imports')
      .select('id, source_kind, item_count, duplicate_count, work_count, created_at, undone_at')
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .limit(limit);
    if (after !== null) q = q.gt('id', after);
    return q;
  }, 'id');

  return rows
    .map((r) => ({
      id: r.id,
      sourceKind: narrowSourceKind(r.source_kind),
      itemCount: r.item_count,
      duplicateCount: r.duplicate_count,
      workCount: r.work_count,
      createdAt: r.created_at,
      undoneAt: r.undone_at,
    }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
}

/**
 * Every highlight this reader still has from an import, with the book it came
 * from.
 *
 * `pull_id` is `on delete set null`, so an undone batch leaves its `import_items`
 * rows behind with nothing attached — those are history, not library, and are
 * filtered out here rather than rendered as blanks.
 *
 * The work and the pull ride on the row as embeds. A row whose pull or work has
 * gone is dropped for the reason `fetchBeliefs` drops one: an entry the reader
 * cannot open is not something they can do anything with, and "(unavailable)" is
 * worse than its absence.
 */
export async function fetchImportedItems(userId: string): Promise<ImportedItem[]> {
  const rows = await pageAfter<EmbeddedImportItem>((after, limit) => {
    let q = supabase
      .from('import_items')
      .select(
        'id, import_id, pull_id, locator, created_at, pulls(headline, body), works(id, title, kind)',
      )
      .eq('user_id', userId)
      .not('pull_id', 'is', null)
      .order('id', { ascending: true })
      .limit(limit);
    if (after !== null) q = q.gt('id', after);
    return q;
  }, 'id');

  return rows
    .map((r): ImportedItem | null => {
      if (!r.pull_id || !r.pulls || !r.works) return null;
      return {
        id: r.id,
        importId: r.import_id,
        pullId: r.pull_id,
        headline: r.pulls.headline,
        body: r.pulls.body,
        locator: r.locator,
        workId: r.works.id,
        workTitle: r.works.title,
        workKind: r.works.kind,
        createdAt: r.created_at,
      };
    })
    .filter((r): r is ImportedItem => r !== null);
}

interface EmbeddedImportItem {
  id: string;
  import_id: string;
  pull_id: string | null;
  locator: string | null;
  created_at: string;
  pulls: { headline: string; body: string } | null;
  works: { id: string; title: string; kind: string | null } | null;
}

function narrowSourceKind(value: string): ImportSourceKind {
  return value === 'kindle' || value === 'readwise' || value === 'csv' || value === 'paste'
    ? value
    : 'csv';
}
