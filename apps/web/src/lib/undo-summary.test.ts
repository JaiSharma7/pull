import { describe, expect, it } from 'vitest';
import type { UndoResult } from './import-fold.js';
import { collateral } from './undo-summary.js';

const undone = (over: Partial<UndoResult['alsoRemoved']> = {}): UndoResult => ({
  importId: 'i',
  removed: 12,
  alreadyUndone: false,
  alsoRemoved: {
    questions: 0,
    grades: 0,
    notes: 0,
    highlights: 0,
    explanations: 0,
    convictions: 0,
    ...over,
  },
});

describe('collateral', () => {
  it('says nothing when the Undo took nothing but the highlights', () => {
    expect(collateral(undone())).toBeNull();
  });

  it('survives a second Undo, which carries no counts at all', () => {
    // THE CRASH THIS MODULE WAS CARVED OUT FOR. `undo_import`'s idempotent branch
    // returns `{importId, removed, alreadyUndone}` and no `alsoRemoved`; reading
    // `.questions` off it threw during render, and the error boundary wraps the whole
    // tree, so the reader lost the app rather than the panel.
    const second: UndoResult = { importId: 'i', removed: 0, alreadyUndone: true };
    expect(collateral(second)).toBeNull();
  });

  it('uses the singular for one', () => {
    expect(collateral(undone({ questions: 1 }))).toBe('1 question');
  });

  it('uses the plural for more', () => {
    expect(collateral(undone({ grades: 4 }))).toBe('4 recorded reviews');
  });

  it('joins two with "and"', () => {
    expect(collateral(undone({ questions: 2, notes: 1 }))).toBe('2 questions and 1 note');
  });

  it('joins three or more with commas and a final "and"', () => {
    expect(collateral(undone({ questions: 3, grades: 11, notes: 2 }))).toBe(
      '3 questions, 11 recorded reviews and 2 notes',
    );
  });

  it('leaves out the kinds that were not touched', () => {
    // The counts come back for all six whatever happened, so a reader would otherwise
    // be told about "0 notes" alongside the thing they actually lost.
    expect(collateral(undone({ convictions: 1 }))).toBe('1 recorded stance');
  });
});
