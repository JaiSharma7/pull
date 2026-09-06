/**
 * The shape of an import, and the fold that turns chunks into one answer.
 *
 * ITS OWN MODULE, AND THAT IS THE WHOLE REASON IT EXISTS. `lib/import-api.ts` imports
 * `lib/supabase.ts`, which builds its client at module scope and throws under vitest's
 * `test` mode -- so a test file that reached this logic through `import-api.ts` failed
 * to COLLECT rather than failing an assertion, which is the shape of the defect that
 * once let a PR report "484 passed" while a whole suite had not run.
 *
 * So the part with a bug in it if there is one -- the chunking, the accumulation, the
 * ceiling -- lives here, imports nothing that touches a network, and is tested directly.
 */

import { chunkItems, type ImportItem, MAX_ITEMS_PER_CALL } from './ingestion.js';

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
 * One `commit_import` call: a chunk in, that call's own counts out.
 *
 * A port, for the reason `replayWrite` takes one -- `lib/supabase.ts` builds its client
 * at module scope, so a test that imports this file to exercise the accumulation below
 * would fail to COLLECT rather than fail an assertion. The chunking is the part with a
 * bug in it if there is one, so it is the part that has to be reachable without a
 * network.
 */
export type CommitChunk = (
  chunk: readonly ImportItem[],
  importId: string | null,
) => Promise<Partial<ImportResult>>;

/**
 * Fold the chunks into one result.
 *
 * ACCUMULATED, not read off the last call. Each `commit_import` reports only what that
 * call did, so returning the final chunk's numbers would tell a reader who imported
 * 3,000 highlights that they had kept the last 500.
 *
 * The `importId` from the first call is threaded into every later one, which is what
 * makes a 3,000-highlight file ONE batch: without it `commit_import` falls back to a
 * time window, and six chunks could land in six batches -- so one Undo would take back
 * a sixth of a library.
 *
 * Exported for its tests. `commitImport` is this with the RPC wired in.
 */
export async function foldChunks(
  items: readonly ImportItem[],
  call: CommitChunk,
): Promise<ImportResult> {
  const total: ImportResult = {
    importId: null,
    added: 0,
    duplicates: 0,
    ceilingReached: false,
    works: [],
  };

  // Deduplicated by id: a book that appears in four chunks is one book, and the reader
  // is told how many books they kept rather than how many chunks mentioned one.
  const byWorkId = new Map<string, ImportedWork>();

  for (const chunk of chunkItems(items, MAX_ITEMS_PER_CALL)) {
    const result = await call(chunk, total.importId);

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
