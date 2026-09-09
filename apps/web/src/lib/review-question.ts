import type { Question } from './activities.js';
import type { DueReview, ReviewQuestion } from './types.js';

/**
 * Normalise a ReviewQuestion from the database/RPC into the Question shape
 * expected by pure grading functions in activities.ts.
 */
export function toActivityQuestion(q: ReviewQuestion): Question {
  return {
    id: q.id,
    kind: q.kind,
    prompt: q.prompt,
    answer: q.answer,
    distractors: q.distractors ?? [],
    source: q.source,
    cloze: q.cloze,
    explanation: q.explanation,
    rationale: q.rationale ?? [],
  };
}

/**
 * Get the active question for a due review card.
 * `get_due_reviews` orders user questions first, then canonical questions.
 */
export function resolveActiveQuestion(card: DueReview): ReviewQuestion | null {
  return card.questions && card.questions.length > 0 ? card.questions[0]! : null;
}

/**
 * Determine the effective kind to render on screen.
 *
 * An MCQ with fewer than 2 valid options (e.g. missing distractors) degrades to free recall.
 * A Cloze with a blank answer degrades to free recall.
 * Unsupported or self-graded kinds (short_answer, ordering, scenario) degrade to free recall.
 */
export function resolveEffectiveKind(
  activityQ: Question | null,
  mcqChoices: readonly string[],
): 'recall' | 'mcq' | 'cloze' {
  if (!activityQ) return 'recall';
  if (activityQ.kind === 'mcq' && mcqChoices.length >= 2) {
    return 'mcq';
  }
  if (activityQ.kind === 'cloze' && (activityQ.answer ?? '').trim()) {
    return 'cloze';
  }
  return 'recall';
}

/**
 * The finite sequence indicator conforming to Law 7 ("1 of N" line).
 */
export function formatReviewProgress(current: number, total: number): string {
  return `Review · ${current} of ${total} fading`;
}

/**
 * What a multiple-choice option says about itself once the reader has answered.
 *
 * Law 5 of `docs/design.md`: colour is never the only signal. Both screens marked the
 * correct option with an oxblood border and nothing else, so a reader who cannot see
 * the accent -- high contrast, a monochrome display, deuteranopia -- was shown four
 * identical buttons and a verdict that named none of them. The word is the signal; the
 * colour is allowed to agree with it.
 *
 * `null` before an answer, and for every option that was neither right nor chosen.
 */
export function mcqOptionMarker(
  option: string,
  answer: string | null | undefined,
  picked: string | null,
): 'Correct answer' | 'Your answer' | null {
  if (picked === null) return null;
  const isTarget = (answer ?? '').trim() === option.trim();
  if (isTarget) return 'Correct answer';
  if (picked === option) return 'Your answer';
  return null;
}
