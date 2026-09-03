import { describe, expect, it } from 'vitest';
import { gradeForLevel, unappliedGrades } from './calibration.js';

/*
 * What used to be here asserted that a hard-coded array had six entries and that each
 * carried a positive `hoursSavedEstimated`. Both were true by construction — the array
 * was the thing under test and the thing asserted — and the second was a test that the
 * invented numbers stayed invented. The census no longer has either.
 */
describe('KnowledgeCensus calibration', () => {
  it('maps a declared level onto a recall grade', () => {
    expect(gradeForLevel('mastered')).toBe('easy');
    expect(gradeForLevel('familiar')).toBe('good');
  });

  it('does not record an unanswered item', () => {
    // The failure this guards is silent: `unknown` is the default for every item on the
    // screen, so a mapping that returned a grade here would write a knowledge state for
    // every idea the reader was shown and never touched.
    expect(gradeForLevel('unknown')).toBeNull();
  });
});

describe('unappliedGrades', () => {
  it('sends every marked idea when nothing has been applied', () => {
    const levels = { a: 'mastered' as const, b: 'familiar' as const, c: 'unknown' as const };
    expect(unappliedGrades(levels, new Set())).toEqual([
      ['a', 'easy'],
      ['b', 'good'],
    ]);
  });

  /*
   * The rule that matters, and the one whose failure is silent. `grade_recall` multiplies
   * stability rather than setting it, so a retry that re-sent an applied grade would take
   * a `good` from 1.0 to 2.7 to 7.29 and push the idea out of review for weeks — on the
   * screen that exists to establish an accurate starting stability. A duplicate write is
   * not a no-op here; it is a fabricated measurement.
   */
  it('never re-sends a grade that already applied', () => {
    const levels = { a: 'mastered' as const, b: 'familiar' as const };
    expect(unappliedGrades(levels, new Set(['a']))).toEqual([['b', 'good']]);
    expect(unappliedGrades(levels, new Set(['a', 'b']))).toEqual([]);
  });

  it('still excludes unanswered items when some have applied', () => {
    const levels = { a: 'familiar' as const, b: 'unknown' as const };
    expect(unappliedGrades(levels, new Set(['a']))).toEqual([]);
  });
});
