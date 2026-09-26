/**
 * Practising a study course: its questions as the screens read them, the order options are
 * shown in, and what a placement check found. Pure, so it runs in the node test environment.
 *
 * Grading is `study-grade.ts`, the browser's copy of the server's rule; recording is the
 * server's (`record_study_answers`). Nothing here decides what the reader knows -- the proof
 * rule does, from what the server recorded.
 */
import { seededShuffle } from './activities.js';
import { isRecord, int, nullableStr, rows, str } from './shape.js';
import { CHOICE_KINDS, type GradableQuestion, type Graded, type StudyKind } from './study-grade.js';

export type QuestionPurpose = 'placement' | 'practice' | 'review';
export type QuestionState = 'not_seen' | 'shown' | 'answered' | 'recall_demonstrated';

/** One row of `study_course_questions`: where a question sits and how the reader stands. */
export interface QuestionEntry {
  itemId: string;
  lessonId: string | null;
  purpose: QuestionPurpose;
  kind: StudyKind;
  state: QuestionState;
  authoredBy: 'model' | 'reader';
}

/** A question's own text, from `study_visible_items`. */
export interface StudyQuestion extends GradableQuestion {
  itemId: string;
  lessonId: string | null;
  purpose: QuestionPurpose;
  prompt: string;
  cloze: string | null;
  explanation: string;
  authoredBy: 'model' | 'reader';
}

const KINDS: readonly StudyKind[] = [
  'multiple_choice',
  'comparison',
  'application',
  'cloze',
  'short_recall',
  'ordering',
  'matching',
];
const PURPOSES: readonly QuestionPurpose[] = ['placement', 'practice', 'review'];
const STATES: readonly QuestionState[] = ['not_seen', 'shown', 'answered', 'recall_demonstrated'];

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

export function shapeQuestionEntries(data: unknown): QuestionEntry[] {
  return rows(data)
    .map((r) => {
      const itemId = str(r.item_id);
      const kind = r.kind as StudyKind;
      if (!itemId || !KINDS.includes(kind)) return null;
      return {
        itemId,
        lessonId: nullableStr(r.lesson_id),
        purpose: oneOf(r.purpose, PURPOSES, 'practice'),
        kind,
        state: oneOf(r.state, STATES, 'not_seen'),
        authoredBy: r.authored_by === 'reader' ? 'reader' : 'model',
      } satisfies QuestionEntry;
    })
    .filter((q): q is QuestionEntry => q !== null);
}

function texts(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/** A `study_visible_items` row, or null when it is not a question this screen can ask. */
export function shapeQuestion(row: unknown): StudyQuestion | null {
  if (!isRecord(row)) return null;
  const itemId = str(row.id);
  const kind = row.kind as StudyKind;
  if (!itemId || !KINDS.includes(kind) || !str(row.prompt) || !str(row.answer)) return null;
  const question: StudyQuestion = {
    itemId,
    lessonId: nullableStr(row.lesson_id),
    purpose: oneOf(row.purpose, PURPOSES, 'practice'),
    kind,
    prompt: str(row.prompt),
    answer: str(row.answer),
    acceptedAnswers: texts(row.accepted_answers),
    distractors: rows(row.distractors).map((d) => ({ text: str(d.text), why: str(d.why) })),
    cloze: nullableStr(row.cloze),
    sequence: texts(row.sequence),
    pairs: rows(row.pairs).map((p) => ({ left: str(p.left), right: str(p.right) })),
    explanation: str(row.explanation),
    authoredBy: row.authored_by === 'reader' ? 'reader' : 'model',
  };
  // A kind whose parts are missing cannot be asked fairly; the validator should never let
  // one through, and a screen should not render half a question if it does.
  if (CHOICE_KINDS.includes(kind) && question.distractors.length === 0) return null;
  if (kind === 'ordering' && question.sequence.length < 2) return null;
  if (kind === 'matching' && question.pairs.length < 2) return null;
  if (kind === 'cloze' && !question.cloze?.includes('____')) return null;
  return question;
}

/**
 * The options of a choice question in a stable order: seeded by the question's id, so a
 * re-render never moves the option under the reader's pointer, and each question has its
 * own order.
 */
export function choiceOptions(q: Pick<StudyQuestion, 'itemId' | 'answer' | 'distractors'>) {
  return seededShuffle([q.answer, ...q.distractors.map((d) => d.text)], q.itemId);
}

/**
 * The steps of an ordering question as first shown: shuffled, as positions in the question's
 * own sequence, and never already in order -- a question that opens solved asks nothing.
 */
export function initialOrder(q: Pick<StudyQuestion, 'itemId' | 'sequence'>): number[] {
  const positions = q.sequence.map((_, i) => i);
  const shuffled = seededShuffle(positions, `${q.itemId}:order`);
  if (shuffled.every((p, i) => p === i) && shuffled.length > 1) {
    return [...shuffled.slice(1), shuffled[0] as number];
  }
  return shuffled;
}

/** The right sides of a matching question, in the order the reader chooses from. */
export function matchingChoices(q: Pick<StudyQuestion, 'itemId' | 'pairs'>): number[] {
  return seededShuffle(
    q.pairs.map((_, i) => i),
    `${q.itemId}:match`,
  );
}

/** Move one step up or down in the reader's order; the rest keep their places. */
export function moveStep(order: readonly number[], from: number, by: -1 | 1): number[] {
  const to = from + by;
  if (from < 0 || from >= order.length || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  const a = next[from] as number;
  next[from] = next[to] as number;
  next[to] = a;
  return next;
}

/**
 * Why a wrong choice was wrong, in the question's own words, or null. Only a choice question
 * carries one, one per wrong option.
 */
export function whyChosenWrong(q: StudyQuestion, chosen: string, graded: Graded): string | null {
  if (graded.correct || !CHOICE_KINDS.includes(q.kind)) return null;
  const option = q.distractors.find((d) => d.text === chosen);
  return option?.why || null;
}

/** The right answer, said so a reader who got it wrong can see it. */
export function rightAnswer(q: StudyQuestion): string {
  if (q.kind === 'ordering') return q.sequence.map((s, i) => `${i + 1}. ${s}`).join('\n');
  if (q.kind === 'matching') return q.pairs.map((p) => `${p.left} — ${p.right}`).join('\n');
  return q.answer;
}

/** A cloze's text split around its blank, so the blank can be an input. */
export function clozeParts(cloze: string): { before: string; after: string } {
  const at = cloze.indexOf('____');
  if (at < 0) return { before: cloze, after: '' };
  return { before: cloze.slice(0, at), after: cloze.slice(at + 4) };
}

// ------------------------------------------------------------------ placement

export interface PlacementAnswer {
  itemId: string;
  lessonId: string | null;
  /** The first answer's own event, so a retry's grade is never taken for it. */
  clientEventId: string;
  correct: boolean;
  grading: 'deterministic' | 'self';
  hinted: boolean;
  /** The server graded it. One that could only be queued has the browser's grade alone. */
  confirmed: boolean;
}

/**
 * The lessons a placement check suggests the reader already knows: every placement question
 * of the lesson answered right, graded by the rule rather than by the reader, and without a
 * hint. A lesson with no placement question is never suggested -- nothing was checked -- and
 * the reader decides whether to skip what is suggested.
 */
export function knownLessons(
  answers: readonly PlacementAnswer[],
  lessonOrder: readonly string[],
): string[] {
  const byLesson = new Map<string, PlacementAnswer[]>();
  for (const a of answers) {
    if (!a.lessonId) continue;
    const list = byLesson.get(a.lessonId) ?? [];
    list.push(a);
    byLesson.set(a.lessonId, list);
  }
  return lessonOrder.filter((id) => {
    const list = byLesson.get(id);
    return (
      list !== undefined &&
      list.length > 0 &&
      list.every((a) => a.confirmed && a.correct && a.grading === 'deterministic' && !a.hinted)
    );
  });
}

// ------------------------------------------------------------------ recording

export interface AnswerEvent {
  clientEventId: string;
  itemId: string;
  response: string | readonly number[];
  selfGrade?: 'correct' | 'incorrect';
  hinted?: boolean;
}

export interface AnswerResult {
  clientEventId: string;
  itemId: string;
  correct: boolean;
  grading: 'deterministic' | 'self';
  hinted: boolean;
  provesRecall: boolean;
}

export interface AnswersRecorded {
  recorded: number;
  duplicates: number;
  refused: { index: number; clientEventId: string | null; reason: string }[];
  results: AnswerResult[];
}

export function shapeAnswersRecorded(data: unknown): AnswersRecorded {
  const r = isRecord(data) ? data : {};
  return {
    recorded: int(r.recorded),
    duplicates: int(r.duplicates),
    refused: rows(r.refused).map((x) => ({
      index: int(x.index),
      clientEventId: nullableStr(x.clientEventId),
      reason: str(x.reason),
    })),
    results: rows(r.results).map((x) => ({
      clientEventId: str(x.clientEventId),
      itemId: str(x.itemId),
      correct: x.correct === true,
      grading: x.grading === 'self' ? 'self' : 'deterministic',
      hinted: x.hinted === true,
      provesRecall: x.provesRecall === true,
    })),
  };
}
