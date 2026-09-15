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
import { MAX_ROWS, pageAfter } from './paging.js';
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
export type { ImportBatch, ImportedItem } from './imports.js';
export { importBatchLabel, importedSummary, isUndoable, SOURCE_KIND_LABEL } from './imports.js';

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

  return (
    rows
      .map((r) => ({
        id: r.id,
        sourceKind: narrowSourceKind(r.source_kind),
        itemCount: r.item_count,
        duplicateCount: r.duplicate_count,
        workCount: r.work_count,
        createdAt: r.created_at,
        undoneAt: r.undone_at,
      }))
      /*
       * Newest first, and the tiebreak is a REAL three-way compare.
       *
       * `(a.id < b.id ? 1 : -1)` never answers 0, so it is not a total order — a value
       * compared with itself came back -1 — and it ordered equal timestamps by id
       * descending while `fetchImportedItems` forty lines below orders its own tiebreak
       * ascending, for the same stated reason. Two batches committed in the same
       * millisecond could therefore sort one way here and the other way there.
       */
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
  );
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
export async function fetchImportedItems(userId: string, workId?: string): Promise<ImportedItem[]> {
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
    // Scoped to one book where the caller only wants one. Studio needs the bodies of
    // the book a reader picked and of no other, and walking four thousand highlights
    // a hundred at a time to draw a row of title buttons is forty round trips for
    // information `fetchImportedWorks` answers in one.
    if (workId) q = q.eq('work_id', workId);
    if (after !== null) q = q.gt('id', after);
    return q;
  }, 'id');

  /*
   * WALKED BY `id`, ORDERED BY `created_at`, and the two cannot be the same column.
   *
   * `import_items.id` is a random uuid, so the keyset walk that pages correctly puts
   * the rows in no useful order at all -- and `groupImported` deliberately does not
   * re-sort within a book, so a shuffled fetch reached the screen as a shuffled book.
   * Worse, `buildImportSource` joins them in that order to send to the model, so a
   * reader's four hundred Kindle highlights were summarised out of sequence.
   *
   * `fetchImports` does the same thing for the same reason: walk on the key that
   * partitions the set, sort once the rows are all in hand. The tiebreak on `id` keeps
   * the order total, so two highlights kept in the same millisecond do not swap
   * between two renders -- which would change the content hash and buy a second
   * summary of one book.
   */
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
    .filter((r): r is ImportedItem => r !== null)
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
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

/**
 * The books this reader has imported, without their highlights.
 *
 * ONE ROW PER BOOK, which is the difference between a bounded request and a walk over
 * everything a reader owns — Studio drew a row of title buttons and paid forty
 * sequential requests with every highlight body in them to do it.
 *
 * Two steps, because PostgREST has no `distinct`. The first walks `import_items` for
 * its `work_id` alone and keysets ON THAT COLUMN, so each page skips the rest of the
 * book it landed in: the walk is bounded by the number of books rather than by the
 * number of highlights, and each row is one uuid. The second asks `works` for their
 * titles in a single `in` list.
 *
 * Read from `import_items` rather than from the reader's summaries, and that is the
 * correction rather than the shape: filtering on `summaries.author_id` returns every
 * work the reader has authored anything on, which includes the works their own Studio
 * generations created — so a pasted essay appeared in the picker as a "book", answered
 * with no highlights when picked, and refused submission with a message about needing
 * 200 characters. A book is a work with imported items in it.
 */
export async function fetchImportedWorks(
  userId: string,
): Promise<{ workId: string; title: string; kind: string | null }[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    let q = supabase
      .from('import_items')
      .select('work_id')
      .eq('user_id', userId)
      .not('pull_id', 'is', null)
      .not('work_id', 'is', null)
      .order('work_id', { ascending: true })
      .limit(MAX_ROWS);
    if (after !== null) q = q.gt('work_id', after);
    const { data, error } = await q;
    if (error) throw rpcError(error);

    const rows = (data ?? []).filter((r): r is { work_id: string } => r.work_id !== null);
    if (rows.length === 0) break;
    for (const r of rows) if (ids[ids.length - 1] !== r.work_id) ids.push(r.work_id);
    // Past the last book this page reached, so the next request starts at the next one
    // rather than at the next highlight.
    after = rows[rows.length - 1]!.work_id;
    if (rows.length < MAX_ROWS) break;
  }
  if (ids.length === 0) return [];

  /*
   * The titles, IN BATCHES, because `max_rows` bounds a response by rows and not by
   * how the filter was written. A single `in` list of 140 ids is a perfectly valid
   * request that comes back with 100 rows and no indication the rest exist, so a
   * reader with more than a hundred imported books quietly lost the tail of their own
   * shelf — and with it the ability to generate from those books at all. Law 3 does
   * not put a number on stashing, so nothing here may either. `MAX_ROWS` is the
   * server's own cap, so each request is one round trip that comes back whole.
   */
  const found: { workId: string; title: string; kind: string | null }[] = [];
  for (let i = 0; i < ids.length; i += MAX_ROWS) {
    const { data, error } = await supabase
      .from('works')
      .select('id, title, kind')
      .in('id', ids.slice(i, i + MAX_ROWS));
    if (error) throw rpcError(error);
    for (const w of data ?? []) found.push({ workId: w.id, title: w.title, kind: w.kind });
  }

  return found.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * How many highlights this reader has kept, without reading one of them.
 *
 * `head: true` asks PostgREST for the count header and no rows at all, so the whole
 * answer is one request whatever the number is. The alternative the Library used to
 * run — walk every `import_items` row a hundred at a time, each carrying its pull's
 * body, and take `.length` — is forty round trips and several megabytes to print one
 * sentence, and it grew with exactly the thing law 3 promises is unlimited.
 *
 * Scoped to one book when a `workId` is given, which is what the open group needs
 * before its rows have landed.
 */
export async function countImportedItems(userId: string, workId?: string): Promise<number> {
  let q = supabase
    .from('import_items')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .not('pull_id', 'is', null);
  if (workId) q = q.eq('work_id', workId);
  const { count, error } = await q;
  if (error) throw rpcError(error);
  return count ?? 0;
}
