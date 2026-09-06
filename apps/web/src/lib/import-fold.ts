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
  /**
   * True when `commit_import` hit one of its two ceilings -- 20,000 live items or 2,000
   * books. It does NOT say which, and the two behave oppositely on the server: the item
   * ceiling ends the chunk, the book ceiling declines one title and carries on. So it is
   * a message for the reader ("that is as many as this account can hold"), not a signal
   * to stop sending. See the loop in `foldChunks`.
   */
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
 * A chunk failed after earlier chunks had already landed.
 *
 * `commit_import` is one transaction per CALL, not one per file, so a rejection partway
 * through a 3,000-highlight upload leaves everything before it stored. Rethrowing the
 * bare error loses the `importId` those chunks share -- and that id is the only handle
 * Undo has. The reader would be told the import failed while 1,500 highlights sat in
 * their library with no way to take them back.
 *
 * So the partial result rides on the error. `Ingestion.tsx` renders it beside the
 * failure: what landed, and the button that removes it.
 *
 * Only raised when something actually landed. A first chunk that fails has stored
 * nothing and has no batch id, so that error is rethrown unchanged rather than dressed
 * up as a partial success with an `importId` of null.
 */
export class PartialImportError extends Error {
  readonly partial: ImportResult;

  constructor(cause: unknown, partial: ImportResult) {
    super(cause instanceof Error ? cause.message : 'A chunk of the import did not go through.');
    this.name = 'PartialImportError';
    this.cause = cause;
    this.partial = partial;
  }
}

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
 * EVERY chunk is sent, including after a ceiling is reported. The loop says why.
 *
 * A chunk that fails after an earlier one landed raises `PartialImportError` carrying
 * what did land, so the batch id survives and Undo stays reachable. A first chunk that
 * fails raises whatever it raised.
 *
 * `startImportId` is how a retry rejoins the batch its first attempt opened. Without it
 * the rejoin is `commit_import`'s reuse window, which is a clock -- six hours for a file
 * and five minutes for a paste -- so a reader who came back the next day would open a
 * second batch and one Undo would take back only half their file. Naming the id is the
 * path the RPC documents as the exact one; the window is its fallback for a caller that
 * does not say.
 *
 * Exported for its tests. `commitImport` is this with the RPC wired in.
 */
/**
 * Fold a retry's result into the one already on screen.
 *
 * A resumed attempt resends the WHOLE file, so its counters describe that attempt and
 * not the batch. Writing them over the earlier ones tells a reader who kept 600
 * highlights that they kept 100: `commit_import` counts the 500 the first attempt
 * stored as duplicates of themselves, and reports only the books the last 100 touched.
 *
 * So:
 *   `added`      sums. Both attempts stored rows and the batch holds all of them.
 *   `duplicates` means "highlights in your file you already had BEFORE this import".
 *                The retry re-walked the WHOLE file, so its count already includes every
 *                pre-existing duplicate the first attempt found -- it is the first
 *                attempt's own stored rows that have to come out of it, and the earlier
 *                count must NOT be added back on top or those pre-existing ones are
 *                counted twice. (Written the other way first; the test below caught it.)
 *                Clamped at zero rather than trusted: the two numbers come from
 *                different calls and nothing guarantees their relationship if a row was
 *                removed in between.
 *   `works`      is a union by id -- a book the first attempt created is in the batch
 *                whether or not the retry touched it again.
 *   the ceiling  is the latest answer, not a latch: room can be freed by an Undo
 *                between attempts.
 *
 * Pure, and exported for its tests.
 */
export function mergeAttempts(prev: ImportResult | null, next: ImportResult): ImportResult {
  if (!prev) return next;
  const byWorkId = new Map<string, ImportedWork>();
  for (const w of prev.works) byWorkId.set(w.workId, w);
  for (const w of next.works) byWorkId.set(w.workId, w);
  return {
    importId: next.importId ?? prev.importId,
    added: prev.added + next.added,
    duplicates: Math.max(0, next.duplicates - prev.added),
    ceilingReached: next.ceilingReached,
    works: [...byWorkId.values()].sort((a, b) => a.title.localeCompare(b.title)),
  };
}

export async function foldChunks(
  items: readonly ImportItem[],
  call: CommitChunk,
  startImportId: string | null = null,
): Promise<ImportResult> {
  const total: ImportResult = {
    importId: startImportId,
    added: 0,
    duplicates: 0,
    ceilingReached: false,
    works: [],
  };

  // Deduplicated by id: a book that appears in four chunks is one book, and the reader
  // is told how many books they kept rather than how many chunks mentioned one.
  const byWorkId = new Map<string, ImportedWork>();

  for (const chunk of chunkItems(items, MAX_ITEMS_PER_CALL)) {
    let result: Partial<ImportResult>;
    try {
      result = await call(chunk, total.importId);
    } catch (e) {
      // Nothing landed yet, so there is no batch to hand back and no Undo to offer.
      if (total.importId === null) throw e;
      total.works = [...byWorkId.values()].sort((a, b) => a.title.localeCompare(b.title));
      throw new PartialImportError(e, total);
    }

    total.importId = result.importId ?? total.importId;
    total.added += result.added ?? 0;
    total.duplicates += result.duplicates ?? 0;
    total.ceilingReached = total.ceilingReached || Boolean(result.ceilingReached);
    for (const w of result.works ?? []) byWorkId.set(w.workId, w);

    /*
     * NO EARLY STOP, and the reason is that `ceilingReached` is two different facts
     * under one name.
     *
     * `commit_import` raises the flag at both of its ceilings and behaves oppositely at
     * each, which its own comments spell out. At the ITEM ceiling it `exit`s -- "past
     * the item ceiling nothing later in the chunk can be stored either"
     * (20260905110000:889). At the BOOK ceiling it `continue`s -- "declining one book
     * does not end the chunk: a later item may sit on a book this reader already owns,
     * which costs no book quota and which they have item room for" (:948).
     *
     * One boolean cannot tell those apart, so any stopping rule built on it throws away
     * highlights in the second case. An earlier revision of this loop broke here and
     * justified it with the item ceiling's sentence alone; for a reader at the 2,000-book
     * ceiling importing a library, that silently discarded every chunk after the first
     * new title -- including highlights on books they already owned, which cost no quota
     * and which they had room for.
     *
     * The cost of not stopping is bounded and in the right direction: past the item
     * ceiling the remaining chunks are round trips that store nothing, which is slow.
     * Losing a reader's highlights is not recoverable by waiting.
     *
     * The real fix is server-side -- report WHICH ceiling -- and it needs a migration,
     * so it belongs with the next schema change that touches imports rather than here.
     */
  }

  total.works = [...byWorkId.values()].sort((a, b) => a.title.localeCompare(b.title));
  return total;
}
