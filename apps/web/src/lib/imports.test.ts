import { describe, expect, it } from 'vitest';
import { importBatchLabel, importedSummary, isUndoable, type ImportBatch } from './imports.js';

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
    expect(importedSummary(0, 0)).toContain('Kindle or Readwise');
  });

  it('counts highlights and books', () => {
    expect(importedSummary(3, 2)).toBe('3 highlights from 2 books, kept privately.');
  });

  it('singularises one of each', () => {
    expect(importedSummary(1, 1)).toBe('1 highlight from 1 book, kept privately.');
  });

  // The number this sentence carries is the whole of a reader's library, and law 3
  // promises no ceiling on it. Four thousand highlights reads as a count, not a code.
  it('groups the thousands', () => {
    expect(importedSummary(4321, 12)).toBe('4,321 highlights from 12 books, kept privately.');
  });
});
