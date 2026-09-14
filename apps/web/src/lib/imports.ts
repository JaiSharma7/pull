/**
 * What an import looks like once it is in the Library — the pure half.
 *
 * `lib/ingestion.ts` parses a file, `lib/import-fold.ts` folds the chunks and
 * `lib/import-api.ts` sends them. None of those answers the question this screen
 * asks: what did I keep, how much of it, and which batch can I take back. That is
 * copy and arithmetic, both pure, and both worth asserting without a database for
 * the reason `lib/library.ts` gives about its own grouping — the failures are
 * ordinary logic and ordinary logic should be testable without rendering anything.
 *
 * `groupImported` used to live here, and it went with the screen that needed it: the
 * Library grouped a walk over EVERY imported highlight to draw a list of book titles,
 * which `fetchImportedWorks` answers in one request and `countImportedItems` counts in
 * another. A grouping function with no caller is the kind of thing this repository has
 * removed before.
 */

/*
 * The four ways a batch can arrive are `lib/import-fold.ts`'s to name -- it is the
 * module that sends them -- so the union is imported rather than restated. A second
 * declaration of the same four strings is a second thing to keep in step with
 * `imports_source_kind_known`, and the one that drifts is always the copy.
 */
import type { ImportSourceKind } from './import-fold.js';

export type { ImportSourceKind };

export const SOURCE_KIND_LABEL: Record<ImportSourceKind, string> = {
  kindle: 'Kindle',
  readwise: 'Readwise',
  csv: 'CSV',
  paste: 'Pasted',
};

/** One row of `imports`: a file, and what it did. */
export interface ImportBatch {
  id: string;
  sourceKind: ImportSourceKind;
  itemCount: number;
  duplicateCount: number;
  workCount: number;
  createdAt: string;
  /** Set once the batch has been taken back. Its pulls are gone; the row stays. */
  undoneAt: string | null;
}

/** One highlight this reader kept, and the book it came from. */
export interface ImportedItem {
  id: string;
  importId: string;
  pullId: string;
  headline: string;
  body: string;
  /** Where in the book, as the file said it — a location, a page, a timestamp. */
  locator: string | null;
  workId: string;
  workTitle: string;
  workKind: string | null;
  createdAt: string;
}

/** One line for a batch: where it came from, how much it kept, how much it skipped. */
export function importBatchLabel(batch: ImportBatch): string {
  const kind = SOURCE_KIND_LABEL[batch.sourceKind];
  const kept = `${batch.itemCount} ${batch.itemCount === 1 ? 'highlight' : 'highlights'}`;
  const books = `${batch.workCount} ${batch.workCount === 1 ? 'book' : 'books'}`;
  const dupes = batch.duplicateCount > 0 ? ` · ${batch.duplicateCount} already kept` : '';
  return `${kind} · ${kept} from ${books}${dupes}`;
}

/** Whether a batch can still be taken back. An undone one cannot be undone twice. */
export function isUndoable(batch: ImportBatch): boolean {
  return batch.undoneAt === null && batch.itemCount > 0;
}

/**
 * The line under the section heading, which says what the reader has rather than
 * only that the section exists.
 */
export function importedSummary(highlights: number, books: number): string {
  if (highlights === 0) {
    return 'Nothing imported yet. A Kindle or Readwise export becomes ideas you can review.';
  }
  return `${highlights.toLocaleString()} ${highlights === 1 ? 'highlight' : 'highlights'} from ${books} ${books === 1 ? 'book' : 'books'}, kept privately.`;
}
