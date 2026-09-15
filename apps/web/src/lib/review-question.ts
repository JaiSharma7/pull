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
 * Which of a card's questions to ask this time.
 *
 * `get_due_reviews` returns up to three per idea -- the reader's own first, then the
 * newest canonical ones -- and until 20260909030000 pinned the recall question to
 * element 0, because the screen could only render that kind. Both screens took
 * `questions[0]`, and a card leaves the page once it is graded, so one question per
 * idea was ever asked and every seeded mcq and cloze was unreachable.
 *
 * THE READER'S OWN QUESTIONS, when they have written any, are the whole pool. That is
 * the one ranking of the two the product has ever had -- `get_due_reviews` has put a
 * reader's question ahead of a canonical one since 20260905110000, and the export deck
 * mirrors it -- and a reader who wrote a question about an idea is asking to be asked
 * it, not a seeded one two visits in three. Rotation runs among their own when there
 * are several (an import can leave three on one pull), and among the canonical ones
 * only when they have written none.
 *
 * Rotated by `turn` -- how many times the reader has met the idea -- so each question
 * in the pool gets its go in order, and the same reader on the same card sees the same
 * question until they answer it. Pure, so the feed can rotate on a different counter
 * (it has no `reps`) with the same rule.
 */
export function chooseQuestion(
  questions: readonly ReviewQuestion[] | null | undefined,
  turn: number,
): ReviewQuestion | null {
  if (!questions || questions.length === 0) return null;
  const own = questions.filter((q) => q.source === 'user');
  const pool = own.length > 0 ? own : questions;
  const n = Number.isFinite(turn) && turn > 0 ? Math.floor(turn) : 0;
  return pool[n % pool.length]!;
}

/**
 * The active question for a due review card: rotated by how many times the idea has
 * been reviewed, so a reader who has been asked the recall question is asked the
 * multiple choice next, then the cloze, then round again -- or their own question,
 * every time, once they have written one.
 */
export function resolveActiveQuestion(card: DueReview): ReviewQuestion | null {
  return chooseQuestion(card.questions, card.reps);
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

/**
 * The session total after a page of due cards arrives.
 *
 * Decided only when a page arrives, never per answer, which is what keeps "1 of 20"
 * honest (law 7): the total cannot move while the reader is inside a page. The first
 * page IS the total; a further page arrives only once everything before it has been
 * answered, so it adds itself. `Math.max(prev, page + answered)` was the previous rule,
 * and it let "1 of 20" become "2 of 21" as the same cards came back on every refetch.
 */
export function nextSessionTotal(prev: number | null, pageLength: number): number {
  return prev === null ? pageLength : prev + pageLength;
}
