import type { RecallGrade } from './grades.js';

/**
 * A question that can be wrong, graded on the device.
 *
 * Every question in this product used to be free recall: the reader was shown a
 * prompt, remembered what they could, and graded themselves. That is honest but it
 * cannot be *wrong* — there is nothing to compare an answer against, so a confident
 * misremembering scores the same as a confident memory. Multiple choice, cloze and
 * ordering questions can be wrong, and that is the entire point of them: the
 * "confidently wrong" repair loop needs an answer the reader gave and an answer the
 * question holds.
 *
 * Everything here is pure and runs in the browser. Grading a multiple-choice
 * answer is a string comparison; grading a typed cloze is an edit distance. Neither
 * needs a model, and neither may ever call one — law 2 puts no model in the read
 * path, and a question answered a thousand times a day is the read path. The
 * questions themselves are written once at generation time (or by hand for the
 * seeded corpus) and served as rows.
 *
 * Nothing in this module touches the database. The question shape is declared here
 * because it is the shape the graders need; the migration that stores it mirrors
 * this, not the other way round.
 */

/**
 * The kinds a question can be. Mirrors the `kind` check on `quiz_questions`.
 *
 * Only three are graded here. `recall`, `short_answer` and `scenario` stay
 * self-graded: there is no deterministic way to mark a paragraph the reader
 * composed, and marking it with a model would be a model call per answer.
 */
export const QUESTION_KINDS = [
  'recall',
  'mcq',
  'cloze',
  'short_answer',
  'ordering',
  'scenario',
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** Why a particular wrong answer is wrong — shown after the reader picks it. */
export interface DistractorRationale {
  distractor: string;
  why: string;
}

export interface Question {
  id: string;
  kind: QuestionKind;
  prompt: string;
  /**
   * The right answer. For `mcq` it is one option among `distractors`; for `cloze`
   * it is what fills the blank; for `ordering` it is the steps in their correct
   * order, one per line (see `orderingSteps`).
   */
  answer: string;
  /** Wrong options, for `mcq`. Empty for every other kind. */
  distractors: string[];
  /** The sentence with a blank in it, for `cloze`. */
  cloze?: string | null;
  /** Why the answer is the answer — shown after grading, whatever was picked. */
  explanation?: string | null;
  rationale: DistractorRationale[];
}

/**
 * How sure the reader said they were before answering. Mirrors the
 * `confidence` check on `recall_events`.
 *
 * Declared here rather than in `grades.ts` so this module lands without touching
 * a file the review-path PRs are also editing; it can move once both are in.
 */
export const CONFIDENCES = ['sure', 'unsure'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface GradeResult {
  grade: RecallGrade;
  correct: boolean;
  /**
   * Wrong, and sure of it. The one signal the free-recall questions could never
   * produce, and the one the memory model most needs: a hesitant miss is a lapse,
   * a confident miss is a false belief, and the second needs a different repair.
   */
  confidentlyWrong: boolean;
}

/* --------------------------------------------------------------------------
 * Determinism
 * -------------------------------------------------------------------------- */

/**
 * A 32-bit hash of a string, so a seed can be anything the caller has to hand —
 * a question id, a session seed, a date. FNV-1a: tiny, well-distributed enough
 * for shuffling four options, and not for anything else.
 */
function hashSeed(seed: string | number): number {
  const text = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A small deterministic generator (mulberry32) seeded from `hashSeed`. Not
 * `packages/ranking`'s `seededUnit`, which is bit-compatible with the SQL planner
 * and needs `node:crypto` for it; this only has to agree with itself.
 */
function generator(seed: string | number): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates, seeded, and pure: the input is not touched.
 *
 * The order of a question's options must not change between a render and a
 * re-render, or the reader's click lands on a different option than the one they
 * read. Seeding on the question id (see `mcqOptions`) also means the same reader
 * sees the same order across sessions, so the answer never becomes "the one that
 * moved".
 */
export function seededShuffle<T>(items: readonly T[], seed: string | number): T[] {
  const out = [...items];
  const next = generator(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/**
 * The options to show for a multiple-choice question, in a stable order.
 *
 * The answer is always among them. A distractor identical to the answer is
 * dropped rather than shown twice, and so is a duplicate distractor — an authored
 * question should never contain either, but a question that does must not present
 * two right answers or two identical wrong ones.
 */
export function mcqOptions(q: Pick<Question, 'answer' | 'distractors'>, seed: string | number) {
  const answer = q.answer.trim();
  const seen = new Set<string>([answer]);
  const options = [answer];
  for (const raw of q.distractors) {
    const d = raw.trim();
    if (!d || seen.has(d)) continue;
    seen.add(d);
    options.push(d);
  }
  return seededShuffle(options, seed);
}

/* --------------------------------------------------------------------------
 * Grading
 * -------------------------------------------------------------------------- */

/**
 * How quickly a right answer has to come to count as effortless, per kind.
 *
 * FSRS's `easy` means the memory was there before the question finished being
 * read, and it multiplies the next interval hard — so it is the grade a wrong
 * heuristic does the most damage with. The thresholds are generous for reading
 * time: four options take a few seconds to scan, a cloze has to be typed, and an
 * ordering has to be dragged into place. Under these, a right answer is `good`,
 * which is the safe default for the model.
 */
export const FAST_ANSWER_MS: Record<'mcq' | 'cloze' | 'ordering', number> = {
  mcq: 8_000,
  cloze: 12_000,
  ordering: 15_000,
};

/**
 * Correctness, confidence and latency, mapped onto the four grades the memory
 * model understands.
 *
 *   wrong                       → forgot   (sure or not — the answer was not there)
 *   right, sure, and fast       → easy
 *   right, otherwise            → good
 *
 * `hard` is never produced here. A grader cannot see effort, and guessing at it
 * from latency alone would call a slow connection a struggling memory. It stays
 * available to the reader — see `selfReportedHard`.
 *
 * Latency that was not measured (`null`), or is not a finite non-negative number,
 * is simply "not fast": a missing clock must never promote a grade.
 */
function gradeFrom(
  correct: boolean,
  confidence: Confidence,
  latencyMs: number | null | undefined,
  fastMs: number,
): GradeResult {
  if (!correct) return { grade: 'forgot', correct: false, confidentlyWrong: confidence === 'sure' };
  const fast =
    typeof latencyMs === 'number' &&
    Number.isFinite(latencyMs) &&
    latencyMs >= 0 &&
    latencyMs <= fastMs;
  return {
    grade: confidence === 'sure' && fast ? 'easy' : 'good',
    correct: true,
    confidentlyWrong: false,
  };
}

/**
 * The reader says a right answer cost them something.
 *
 * The one grade the graders never assign, offered back to the reader as a
 * downgrade. It applies only to a right answer: a wrong one is `forgot` whatever
 * the reader felt about it, and letting "hard" soften a miss would put a false
 * belief back on a normal schedule.
 */
export function selfReportedHard(result: GradeResult): GradeResult {
  if (!result.correct) return result;
  return { ...result, grade: 'hard' };
}

/**
 * Grade a multiple-choice pick.
 *
 * The comparison is exact after trimming, not normalised: the options were handed
 * out by `mcqOptions` verbatim, so what comes back is one of those strings, and a
 * looser match could only ever make a distractor that differs from the answer by
 * punctuation count as right.
 */
export function gradeMcq(
  picked: string,
  q: Pick<Question, 'answer'>,
  confidence: Confidence,
  latencyMs: number | null | undefined,
): GradeResult {
  const correct = picked.trim() === q.answer.trim();
  return gradeFrom(correct, confidence, latencyMs, FAST_ANSWER_MS.mcq);
}

/**
 * Text as a marker would read it: case, punctuation, diacritics and spacing
 * dropped, a leading article dropped.
 *
 * A cloze is typed, and typing is where the small differences live. "Mitochondria"
 * and "the mitochondria." are the same answer, and a grader that says otherwise
 * teaches the reader to game the box rather than remember the idea.
 */
export function normaliseAnswer(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:a|an|the) /, '');
}

/**
 * Edit distance with adjacent transpositions counted once (optimal string
 * alignment), on strings short enough that the plain table is fine.
 *
 * Plain Levenshtein charges two for "mitochondira", which is the single most
 * common thing fingers do to a word, and on a twelve-letter answer two edits is
 * the difference between accepted and not.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      let best = Math.min(
        substitution,
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (twoBack[j - 2] as number) + 1);
      }
      current[j] = best;
    }
    twoBack = previous;
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * How alike two answers are, in [0, 1], after normalisation. 1 is identical;
 * an empty answer on either side is 0 rather than a division by nothing.
 */
export function answerSimilarity(typed: string, answer: string): number {
  const a = normaliseAnswer(typed);
  const b = normaliseAnswer(answer);
  if (!a || !b) return 0;
  const longest = Math.max(a.length, b.length);
  return 1 - editDistance(a, b) / longest;
}

/**
 * Below this a typed answer is a different answer. 0.85 lets one wrong letter
 * through on a seven-letter word and two on a thirteen-letter one — a typo, not
 * a synonym. A near miss is still reported as `similarity` so a screen can say
 * "close" rather than only "no".
 */
export const CLOZE_ACCEPT = 0.85;

/**
 * Grade a typed cloze answer.
 *
 * `confidence` and `latencyMs` are optional so `gradeCloze(typed, answer)` reads
 * as the yes-or-no it mostly is; left out, the result can be `good` or `forgot`
 * and never `easy`, because an unmeasured answer cannot be shown to have been
 * effortless.
 */
export function gradeCloze(
  typed: string,
  answer: string,
  confidence: Confidence = 'unsure',
  latencyMs: number | null | undefined = null,
): GradeResult & { similarity: number } {
  const similarity = answerSimilarity(typed, answer);
  const correct = similarity >= CLOZE_ACCEPT;
  return { ...gradeFrom(correct, confidence, latencyMs, FAST_ANSWER_MS.cloze), similarity };
}

/**
 * The steps of an ordering question, in their right order.
 *
 * Stored as the question's `answer`, one step per line, because that is the one
 * column every kind has and an ordering has no separate answer to put there.
 * Blank lines are ignored so a trailing newline in an authored answer is not a
 * phantom step.
 */
export function orderingSteps(q: Pick<Question, 'answer'>): string[] {
  return q.answer
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Grade a sequence the reader arranged.
 *
 * All or nothing for the grade: an ordering with one pair swapped is not
 * remembered, it is nearly remembered, and the model has no grade for "nearly".
 * `misplaced` counts the positions that differ so the screen can show how near.
 * A sequence with a step missing or added is wrong at every position past the
 * fault, and reported as such.
 */
export function gradeOrdering(
  order: readonly string[],
  q: Pick<Question, 'answer'>,
  confidence: Confidence = 'unsure',
  latencyMs: number | null | undefined = null,
): GradeResult & { misplaced: number } {
  const steps = orderingSteps(q);
  const given = order.map((s) => s.trim());
  let misplaced = 0;
  const length = Math.max(steps.length, given.length);
  for (let i = 0; i < length; i += 1) {
    if (steps[i] !== given[i]) misplaced += 1;
  }
  const correct = steps.length > 0 && misplaced === 0;
  return { ...gradeFrom(correct, confidence, latencyMs, FAST_ANSWER_MS.ordering), misplaced };
}

/* --------------------------------------------------------------------------
 * Feedback
 * -------------------------------------------------------------------------- */

/**
 * Why the option the reader picked is wrong, in the question's own words.
 *
 * Each distractor can carry a rationale, and that is what makes a wrong answer
 * worth more than a right one: the reader learns which specific confusion they
 * hold. Without one for this distractor, the general explanation stands in.
 * Picking the answer is not wrong, so there is nothing to say and this is null.
 */
export function whyWrong(
  q: Pick<Question, 'answer' | 'explanation' | 'rationale'>,
  picked: string,
): string | null {
  const chosen = picked.trim();
  if (chosen === q.answer.trim()) return null;
  const match = q.rationale.find((r) => r.distractor.trim() === chosen);
  if (match?.why.trim()) return match.why.trim();
  const fallback = normaliseAnswer(chosen);
  const loose = fallback
    ? q.rationale.find((r) => normaliseAnswer(r.distractor) === fallback)
    : undefined;
  if (loose?.why.trim()) return loose.why.trim();
  return q.explanation?.trim() || null;
}
