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

/**
 * The grades still to send: every marked idea, minus the ones already applied.
 *
 * Pure and separate because the subtraction is the whole safety property, and it is
 * invisible when it fails. `grade_recall` multiplies stability and increments `reps` with
 * no idempotency key, so re-sending an applied grade does not repeat a write — it
 * compounds one. A "Try again" that resent the whole set took a successful `good` from
 * stability 1.0 to 2.7 to 7.29 and pushed the idea out of review for weeks, on the
 * screen whose entire job is to establish an accurate starting stability.
 */
export function unappliedGrades(
  levels: Record<string, KnowledgeLevel>,
  /* A `Set` of ids or a `Map` of id → grade; only membership is asked of it. */
  applied: { has(pullId: string): boolean },
): [string, 'good' | 'easy'][] {
  const out: [string, 'good' | 'easy'][] = [];
  for (const [pullId, level] of Object.entries(levels)) {
    if (applied.has(pullId)) continue;
    const grade = gradeForLevel(level);
    if (grade) out.push([pullId, grade]);
  }
  return out;
}
