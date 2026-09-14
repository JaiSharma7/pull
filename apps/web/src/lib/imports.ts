/**
 * What an import looks like once it is in the Library — the pure half.
 *
 * `lib/ingestion.ts` parses a file, `lib/import-fold.ts` folds the chunks and
 * `lib/import-api.ts` sends them. None of those answers the question this screen
 * asks: what did I keep, from which book, and which batch can I take back. That
 * is grouping and copy, both pure, and both worth asserting without a database
 * for the reason `lib/library.ts` gives about its own grouping — the failures are
 * ordinary logic and ordinary logic should be testable without rendering
 * anything.
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

/** A book, and the highlights kept from it. */
export interface ImportedWorkGroup {
  workId: string;
  title: string;
  kind: string | null;
  items: ImportedItem[];
}

/**
 * Group imported highlights by the book they came from, newest book first.
 *
 * Keyed on the real `work_id` rather than on the title, for the reason
 * `groupByWork` gives about orphans and for one more that is specific to imports:
 * an imported work is created PER READER with a slug carrying a hash of (reader,
 * title, author), so two books genuinely called "Selected Essays" are two
 * different works and must not collapse into one row. Titles cannot be the key
 * here even in principle.
 *
 * Within a book the highlights keep the order they were kept in, which for a
 * Kindle or Readwise file is reading order — the order the reader will recognise.
 */
export function groupImported(items: readonly ImportedItem[]): ImportedWorkGroup[] {
  const byWork = new Map<string, ImportedWorkGroup>();
  for (const item of items) {
    const existing = byWork.get(item.workId);
    if (existing) existing.items.push(item);
    else {
      byWork.set(item.workId, {
        workId: item.workId,
        title: item.workTitle,
        kind: item.workKind,
        items: [item],
      });
    }
  }
  // Newest first, by the most recent highlight in each book: a reader who has just
  // imported something expects to find it at the top.
  return [...byWork.values()].sort(
    (a, b) => newest(b.items) - newest(a.items) || compare(a.workId, b.workId),
  );
}

function newest(items: readonly ImportedItem[]): number {
  return items.reduce((max, i) => Math.max(max, Date.parse(i.createdAt) || 0), 0);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What a batch says about itself.
 *
 * Counts first, because they are what the reader is checking: a file they
 * expected 400 highlights from that kept 12 is the thing worth noticing, and a
 * row that led with a date would bury it. Duplicates are named rather than hidden
 * — they are the reason the second number disagrees with the first, and a reader
 * who does not know that reads the difference as data loss.
 */
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
export function importedSummary(groups: readonly ImportedWorkGroup[]): string {
  const items = groups.reduce((n, g) => n + g.items.length, 0);
  if (items === 0) {
    return 'Nothing imported yet. A Kindle or Readwise export becomes ideas you can review.';
  }
  const books = groups.length;
  return `${items} ${items === 1 ? 'highlight' : 'highlights'} from ${books} ${books === 1 ? 'book' : 'books'}, kept privately.`;
}
