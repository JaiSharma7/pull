/**
 * The browser's copy of the server's grading rule for a study question
 * (`study_grade_response`, 20260925200000), so feedback does not wait on the network and
 * practice works offline.
 *
 * It decides what the reader is TOLD, never what is RECORDED: the recorder grades the
 * response again on the server and keeps its own answer. The two are held to each other by
 * `scripts/test-study-grade-parity.mjs`, and `studyFold` to `study_fold` by
 * `scripts/test-study-fold-parity.mjs`, over every code point Postgres knows. Pure, so the
 * parity test can import it under node without the app.
 */

/**
 * Fold an answer the way the database does: NFKC, lower case, the same punctuation removed.
 * A copy of `answerKey` in `supabase/functions/_shared/study.ts`, which the web cannot import
 * (that tree is Deno's). The parity test holds all three together.
 */
export function studyFold(text: string): string {
  const base = text.normalize('NFKC').toLowerCase();
  const key = collapseSpaces(
    base
      .replace(/[‘’'`]/g, ' ')
      .replace(/(?<!\d)\.|\.(?!\d)/g, '')
      .replace(/[“”",;:!?()[\]{}。、「」『』【】〈〉《》・]/g, ''),
  );
  // An answer that IS punctuation keeps it rather than folding to nothing.
  return key === '' ? collapseSpaces(base) : key;
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export type StudyKind =
  | 'multiple_choice'
  | 'comparison'
  | 'application'
  | 'cloze'
  | 'short_recall'
  | 'ordering'
  | 'matching';

/** The parts of a question grading reads, as `study_visible_items` returns them. */
export interface GradableQuestion {
  kind: StudyKind;
  answer: string;
  acceptedAnswers: readonly string[];
  distractors: readonly { text: string; why: string }[];
  sequence: readonly string[];
  pairs: readonly { left: string; right: string }[];
}

/**
 * What the reader gave: the option chosen, the text typed, or positions -- for ordering, the
 * steps' positions in the question's own sequence in the order the reader put them; for
 * matching, for each left side in order, the position of the right side chosen for it.
 */
export type StudyResponse = string | readonly number[];

export type SelfGrade = 'correct' | 'incorrect';

export interface Graded {
  correct: boolean;
  grading: 'deterministic' | 'self';
  /** What the server stores: the text, or the positions comma-separated. */
  response: string | null;
}

export const CHOICE_KINDS: readonly StudyKind[] = ['multiple_choice', 'comparison', 'application'];
export const TYPED_KINDS: readonly StudyKind[] = ['cloze', 'short_recall'];

/**
 * Grade a response as the server will, or null when the server would refuse it as malformed.
 * A short recall answer that does not match needs the reader's own judgement (`self`), and
 * without one it cannot be graded yet -- `needsSelfGrade` says so first.
 */
export function gradeStudyResponse(
  q: GradableQuestion,
  response: StudyResponse,
  self: SelfGrade | null = null,
): Graded | null {
  if (CHOICE_KINDS.includes(q.kind)) {
    if (typeof response !== 'string' || Array.from(response).length > 1000) return null;
    const key = studyFold(response);
    if (key === studyFold(q.answer)) {
      return { correct: true, grading: 'deterministic', response };
    }
    if (q.distractors.some((d) => studyFold(d.text) === key)) {
      return { correct: false, grading: 'deterministic', response };
    }
    return null;
  }

  if (q.kind === 'ordering' || q.kind === 'matching') {
    const n = q.kind === 'ordering' ? q.sequence.length : q.pairs.length;
    if (typeof response === 'string' || n === 0 || response.length !== n) return null;
    if (response.some((p) => !Number.isInteger(p) || p < 0 || p >= n)) return null;
    if (new Set(response).size !== n) return null;
    return {
      correct: response.every((p, i) => p === i),
      grading: 'deterministic',
      response: response.join(','),
    };
  }

  if (TYPED_KINDS.includes(q.kind)) {
    if (typeof response !== 'string' || Array.from(response).length > 1000) return null;
    const key = studyFold(response);
    if (
      key !== '' &&
      (key === studyFold(q.answer) || q.acceptedAnswers.some((a) => studyFold(a) === key))
    ) {
      return { correct: true, grading: 'deterministic', response };
    }
    if (q.kind === 'cloze') return { correct: false, grading: 'deterministic', response };
    if (self === null) return null;
    return {
      correct: self === 'correct',
      grading: 'self',
      response: response === '' ? null : response,
    };
  }

  return null;
}

/** Whether this response needs the reader to judge it against the model answer. */
export function needsSelfGrade(q: GradableQuestion, response: string): boolean {
  return (
    q.kind === 'short_recall' &&
    gradeStudyResponse(q, response) === null &&
    Array.from(response).length <= 1000
  );
}
