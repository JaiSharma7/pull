/**
 * The network half of keeping highlights.
 *
 * `lib/ingestion.ts` parses and shapes; this is the only thing that sends. The split is
 * what makes the shaping testable without a database, and it is why every bound the RPC
 * enforces is mirrored there rather than here.
 *
 * Two RPCs, both `security definer`, because a reader may not insert the
 * works/summaries/pulls triple and must not be given policies that would let them. See
 * `20260905110000_your_highlights_are_yours_to_keep.sql`.
 */

import { chunkItems, type ImportItem, MAX_ITEMS_PER_CALL } from './ingestion.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/** A book an import touched, as `commit_import` reports it. */
export interface ImportedWork {
  workId: string;
  title: string;
  slug: string;
}

export interface ImportResult {
  importId: string | null;
  added: number;
  duplicates: number;
  /** True when a ceiling stopped the import short. The screen says which count is short. */
  ceilingReached: boolean;
  works: ImportedWork[];
}

export interface UndoResult {
  importId: string;
  removed: number;
  alreadyUndone: boolean;
  alsoRemoved: {
    questions: number;
    grades: number;
    notes: number;
    highlights: number;
    explanations: number;
    convictions: number;
  };
}

/**
 * The sha256 of the file, as 64 lowercase hex characters.
 *
 * `imports.file_hash` has a `^[0-9a-f]{64}$` check and the reuse window matches on it, so
 * this is what joins six chunks of one clippings file into one batch — and therefore what
 * makes one Undo take the whole file back rather than a sixth of it.
 *
 * Returns null rather than throwing when `crypto.subtle` is unavailable. It is
 * secure-context-gated, so over plain http there is no digest to compute — and the RPC
 * takes a null hash: `commit_import` gives a hashless source a five-minute reuse window
 * matched on `source_kind` alone, which still covers a chunked upload. Losing the hash
 * costs a weaker window; throwing would cost the reader their import.
 */
export async function hashFile(content: string): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

export type ImportSourceKind = 'kindle' | 'readwise' | 'csv' | 'paste';

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
export async function commitImport(
  sourceKind: ImportSourceKind,
  fileHash: string | null,
  items: readonly ImportItem[],
): Promise<ImportResult> {
  const chunks = chunkItems(items, MAX_ITEMS_PER_CALL);

  const total: ImportResult = {
    importId: null,
    added: 0,
    duplicates: 0,
    ceilingReached: false,
    works: [],
  };

  // Deduplicated by id: a book that appears in four chunks is one book, and the reader
  // is told how many books they kept.
  const byWorkId = new Map<string, ImportedWork>();

  for (const chunk of chunks) {
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
      ...(total.importId ? { p_import_id: total.importId } : {}),
    });

    if (error) throw rpcError(error);

    const result = (data ?? {}) as Partial<ImportResult>;
    total.importId = result.importId ?? total.importId;
    total.added += result.added ?? 0;
    total.duplicates += result.duplicates ?? 0;
    total.ceilingReached = total.ceilingReached || Boolean(result.ceilingReached);
    for (const w of result.works ?? []) byWorkId.set(w.workId, w);

    // Past a ceiling nothing later can be stored either, so the remaining chunks would
    // each be a round trip that adds nothing. `commit_import` reports the stop rather
    // than raising precisely so the client can act on it.
    if (total.ceilingReached) break;
  }

  total.works = [...byWorkId.values()].sort((a, b) => a.title.localeCompare(b.title));
  return total;
}

/** Take a whole batch back. Idempotent: a second call reports `alreadyUndone`. */
export async function undoImport(importId: string): Promise<UndoResult> {
  const { data, error } = await supabase.rpc('undo_import', { p_import_id: importId });
  if (error) throw rpcError(error);
  return data as unknown as UndoResult;
}
