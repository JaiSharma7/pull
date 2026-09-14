import { describe, expect, it } from 'vitest';
import {
  groupImported,
  importBatchLabel,
  importedSummary,
  isUndoable,
  type ImportBatch,
  type ImportedItem,
} from './imports.js';

let seq = 0;
function item(workId: string, title: string, createdAt: string): ImportedItem {
  seq += 1;
  return {
    id: `i${seq}`,
    importId: 'b1',
    pullId: `p${seq}`,
    headline: `Headline ${seq}`,
    body: `Body ${seq}`,
    locator: `Location ${seq}`,
    workId,
    workTitle: title,
    workKind: 'book',
    createdAt,
  };
}

function batch(over: Partial<ImportBatch> = {}): ImportBatch {
  return {
    id: 'b1',
    sourceKind: 'kindle',
    itemCount: 412,
    duplicateCount: 0,
    workCount: 6,
    createdAt: '2026-09-01T00:00:00Z',
    undoneAt: null,
    ...over,
  };
}

describe('groupImported', () => {
  it('returns nothing for a reader who has imported nothing', () => {
    expect(groupImported([])).toEqual([]);
  });

  it('groups by the work id, not the title', () => {
    // Two books genuinely called the same thing are two works: `commit_import`
    // creates one per reader with a slug carrying a hash of (reader, title,
    // author), so titles cannot be the key here even in principle.
    const groups = groupImported([
      item('w1', 'Selected Essays', '2026-09-01T00:00:00Z'),
      item('w2', 'Selected Essays', '2026-09-01T00:00:00Z'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('puts the book with the most recent highlight first', () => {
    const groups = groupImported([
      item('old', 'An older book', '2026-01-01T00:00:00Z'),
      item('new', 'A newer book', '2026-09-01T00:00:00Z'),
      item('old', 'An older book', '2026-02-01T00:00:00Z'),
    ]);
    expect(groups.map((g) => g.workId)).toEqual(['new', 'old']);
  });

  it('keeps each book’s highlights in the order they were kept', () => {
    const groups = groupImported([
      item('w1', 'A book', '2026-01-01T00:00:00Z'),
      item('w1', 'A book', '2026-02-01T00:00:00Z'),
      item('w1', 'A book', '2026-03-01T00:00:00Z'),
    ]);
    expect(groups[0]!.items.map((i) => i.createdAt)).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-02-01T00:00:00Z',
      '2026-03-01T00:00:00Z',
    ]);
  });

  it('orders on the work id when two books have the same newest highlight', () => {
    const one = groupImported([
      item('a', 'A', '2026-01-01T00:00:00Z'),
      item('b', 'B', '2026-01-01T00:00:00Z'),
    ]);
    const other = groupImported([
      item('b', 'B', '2026-01-01T00:00:00Z'),
      item('a', 'A', '2026-01-01T00:00:00Z'),
    ]);
    expect(one.map((g) => g.workId)).toEqual(other.map((g) => g.workId));
  });
});

describe('importBatchLabel', () => {
  it('leads with the counts, which are what the reader is checking', () => {
    expect(importBatchLabel(batch())).toBe('Kindle · 412 highlights from 6 books');
  });

  it('names duplicates rather than hiding them', () => {
    // The reason the second number disagrees with the first. A reader who does not
    // know reads the difference as data loss.
    expect(importBatchLabel(batch({ duplicateCount: 18 }))).toContain('18 already kept');
  });

  it('singularises one of each', () => {
    expect(importBatchLabel(batch({ itemCount: 1, workCount: 1, sourceKind: 'paste' }))).toBe(
      'Pasted · 1 highlight from 1 book',
    );
  });
});

describe('isUndoable', () => {
  it('is true for a batch that kept something and has not been taken back', () => {
    expect(isUndoable(batch())).toBe(true);
  });

  it('is false once it has been undone, so nothing offers to undo it twice', () => {
    expect(isUndoable(batch({ undoneAt: '2026-09-02T00:00:00Z' }))).toBe(false);
  });

  it('is false for a batch that kept nothing', () => {
    expect(isUndoable(batch({ itemCount: 0 }))).toBe(false);
  });
});

describe('importedSummary', () => {
  it('says what would fill the section rather than only that it is empty', () => {
    expect(importedSummary([])).toContain('Kindle or Readwise');
  });

  it('counts highlights and books', () => {
    const groups = groupImported([
      item('w1', 'One', '2026-01-01T00:00:00Z'),
      item('w1', 'One', '2026-01-02T00:00:00Z'),
      item('w2', 'Two', '2026-01-03T00:00:00Z'),
    ]);
    expect(importedSummary(groups)).toBe('3 highlights from 2 books, kept privately.');
  });

  it('singularises one of each', () => {
    const groups = groupImported([item('w1', 'One', '2026-01-01T00:00:00Z')]);
    expect(importedSummary(groups)).toBe('1 highlight from 1 book, kept privately.');
  });
});
