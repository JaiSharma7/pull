import { describe, expect, it } from 'vitest';
import { gradeForLevel } from './calibration.js';

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
