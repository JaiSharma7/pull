/**
 * Turning a reader's declared prior knowledge into something the memory model accepts.
 *
 * Lives here rather than beside the component for the reason every other tested helper
 * in `lib/` does: it is pure, and a test that imports the component imports the Supabase
 * client with it.
 */
export type KnowledgeLevel = 'unknown' | 'familiar' | 'mastered';

/**
 * How a declared level becomes a recall grade for `grade_recall`.
 *
 * `null` means "do not write". `unknown` is the default state of every item on the
 * census screen, so a mapping that returned a grade for it would seed a knowledge state
 * for every idea the reader was shown and never answered — the opposite of calibration.
 *
 * Familiar and Mastered differ only in the grade handed over; the initial stability that
 * follows from it is FSRS's to compute in `grade_recall`, not this screen's to assert.
 */
export function gradeForLevel(level: KnowledgeLevel): 'good' | 'easy' | null {
  if (level === 'mastered') return 'easy';
  if (level === 'familiar') return 'good';
  return null;
}
