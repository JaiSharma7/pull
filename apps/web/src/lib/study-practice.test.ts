import { describe, expect, it } from 'vitest';
import { gradeStudyResponse, needsSelfGrade, studyFold } from './study-grade.js';
import {
  choiceOptions,
  dueQuestions,
  lessonPractice,
  questionsOf,
  reviewQueue,
  clozeParts,
  confirmFirst,
  firstAnswer,
  initialOrder,
  matchingChoices,
  moveStep,
  placementOffered,
  rightAnswer,
  shapeAnswersRecorded,
  shapeQuestion,
  shapeQuestionEntries,
  whyChosenWrong,
  type QuestionEntry,
  type StudyQuestion,
} from './study-practice.js';

const row = {
  id: 'q1',
  lesson_id: 'l2',
  purpose: 'practice',
  kind: 'multiple_choice',
  prompt: 'Which group remembered more after a week?',
  answer: 'The recall test group',
  accepted_answers: [],
  distractors: [
    { text: 'The restudy group', why: 'Only at five minutes.' },
    { text: 'Neither group', why: 'The note reports a difference.' },
  ],
  cloze: null,
  sequence: [],
  pairs: [],
  explanation: 'The delayed tests favoured prior retrieval.',
  authored_by: 'model',
};
const mc = shapeQuestion(row) as StudyQuestion;

describe('shaping questions', () => {
  it('reads a visible question, and refuses one missing the parts its kind needs', () => {
    expect(mc).toMatchObject({ itemId: 'q1', kind: 'multiple_choice', lessonId: 'l2' });
    expect(shapeQuestion({ ...row, distractors: [] })).toBeNull();
    expect(shapeQuestion({ ...row, kind: 'ordering', sequence: ['one'] })).toBeNull();
    expect(shapeQuestion({ ...row, kind: 'cloze', cloze: 'No blank here.' })).toBeNull();
    expect(shapeQuestion({ ...row, kind: 'essay' })).toBeNull();
    expect(shapeQuestion('junk')).toBeNull();
  });

  it('reads the question list, dropping what it cannot ask', () => {
    const entries = shapeQuestionEntries([
      { item_id: 'q1', lesson_id: null, purpose: 'review', kind: 'cloze', state: 'answered' },
      {
        item_id: 'q3',
        lesson_id: 'l1',
        purpose: 'practice',
        kind: 'cloze',
        state: 'answered',
        due_at: '2026-09-25T11:00:00.123456+00:00',
        due: true,
      },
      // Due by the server's clock, not the device's: a time without the flag is not due.
      {
        item_id: 'q4',
        lesson_id: 'l1',
        purpose: 'practice',
        kind: 'cloze',
        state: 'answered',
        due_at: '2026-09-25T11:00:00+00:00',
        due: false,
      },
      { item_id: 'q2', kind: 'essay' },
      { kind: 'cloze' },
    ]);
    expect(entries).toEqual([
      {
        itemId: 'q1',
        lessonId: null,
        purpose: 'review',
        kind: 'cloze',
        state: 'answered',
        authoredBy: 'model',
        dueAt: null,
        due: false,
      },
      {
        itemId: 'q3',
        lessonId: 'l1',
        purpose: 'practice',
        kind: 'cloze',
        state: 'answered',
        authoredBy: 'model',
        dueAt: '2026-09-25T11:00:00.123456+00:00',
        due: true,
      },
      {
        itemId: 'q4',
        lessonId: 'l1',
        purpose: 'practice',
        kind: 'cloze',
        state: 'answered',
        authoredBy: 'model',
        dueAt: '2026-09-25T11:00:00+00:00',
        due: false,
      },
    ]);
  });
});

describe('what the reader is shown', () => {
  it('orders options the same way every time, with the answer among them', () => {
    const once = choiceOptions(mc);
    expect(choiceOptions(mc)).toEqual(once);
    expect(once).toHaveLength(3);
    expect(once).toContain('The recall test group');
  });

  it('never opens an ordering question already solved', () => {
    for (const itemId of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const order = initialOrder({ itemId, sequence: ['one', 'two', 'three'] });
      expect([...order].sort()).toEqual([0, 1, 2]);
      expect(order).not.toEqual([0, 1, 2]);
    }
  });

  it('moves a step without losing any, and not past either end', () => {
    expect(moveStep([2, 0, 1], 1, -1)).toEqual([0, 2, 1]);
    expect(moveStep([2, 0, 1], 0, -1)).toEqual([2, 0, 1]);
    expect(moveStep([2, 0, 1], 2, 1)).toEqual([2, 0, 1]);
  });

  it('offers every right side of a matching question', () => {
    const choices = matchingChoices({
      itemId: 'm',
      pairs: [
        { left: 'a', right: 'x' },
        { left: 'b', right: 'y' },
        { left: 'c', right: 'z' },
      ],
    });
    expect([...choices].sort()).toEqual([0, 1, 2]);
  });

  it('splits a cloze at its blank', () => {
    expect(clozeParts('After a week, the ____ group won.')).toEqual({
      before: 'After a week, the ',
      after: ' group won.',
    });
  });

  it('says why a wrong option was wrong, and the right answer in order', () => {
    const graded = gradeStudyResponse(mc, 'The restudy group');
    expect(graded).toMatchObject({ correct: false });
    expect(whyChosenWrong(mc, 'The restudy group', graded!)).toBe('Only at five minutes.');
    const ordering = { ...mc, kind: 'ordering' as const, sequence: ['read', 'test'] };
    expect(rightAnswer(ordering)).toBe('1. read\n2. test');
  });
});

describe('grading, as the server grades', () => {
  const recall: StudyQuestion = {
    ...mc,
    kind: 'short_recall',
    answer: 'restudying',
    acceptedAnswers: ['restudy'],
    distractors: [],
  };

  it('folds case, punctuation and width before comparing', () => {
    expect(studyFold('  Restudying!! ')).toBe('restudying');
    expect(gradeStudyResponse(recall, 'ＲＥＳＴＵＤＹ.')).toMatchObject({
      correct: true,
      grading: 'deterministic',
    });
  });

  it('asks the reader to judge an unmatched recall answer, and records it as self', () => {
    expect(needsSelfGrade(recall, 'reading it again')).toBe(true);
    expect(gradeStudyResponse(recall, 'reading it again')).toBeNull();
    expect(gradeStudyResponse(recall, 'reading it again', 'correct')).toEqual({
      correct: true,
      grading: 'self',
      response: 'reading it again',
    });
    expect(needsSelfGrade({ ...recall, kind: 'cloze' }, 'reading it again')).toBe(false);
  });

  it('refuses an option never offered, and positions that are not a permutation', () => {
    expect(gradeStudyResponse(mc, 'Paris')).toBeNull();
    const ordering = { ...mc, kind: 'ordering' as const, sequence: ['a', 'b', 'c'] };
    expect(gradeStudyResponse(ordering, [0, 1, 2])).toMatchObject({
      correct: true,
      response: '0,1,2',
    });
    expect(gradeStudyResponse(ordering, [0, 0, 1])).toBeNull();
    expect(gradeStudyResponse(ordering, [0, 1])).toBeNull();
  });
});

describe('placement', () => {
  it('keeps a first answer unconfirmed until its own event is graded', () => {
    const first = firstAnswer(
      { itemId: 'p1', lessonId: 'l1' },
      { correct: true, grading: 'deterministic', hinted: false },
      'e1',
    );
    expect(first).toMatchObject({ clientEventId: 'e1', correct: true, confirmed: false });
    const graded = (clientEventId: string, over: object = {}) => ({
      clientEventId,
      itemId: 'p1',
      correct: false,
      grading: 'deterministic' as const,
      hinted: true,
      provesRecall: false,
      ...over,
    });
    // A retry's grade is another answer's.
    expect(confirmFirst(first, graded('e2'))).toBe(first);
    // Its own: the server's grade wins, and hinted if either said so.
    expect(confirmFirst(first, graded('e1'))).toMatchObject({
      correct: false,
      hinted: true,
      confirmed: true,
    });
    const hintedHere = { ...first, hinted: true };
    expect(confirmFirst(hintedHere, graded('e1', { correct: true, hinted: false }))).toMatchObject({
      correct: true,
      hinted: true,
      confirmed: true,
    });
  });

  it('offers the check until one of its questions is answered', () => {
    const q = (purpose: 'placement' | 'practice', state: string) =>
      ({ purpose, state }) as Parameters<typeof placementOffered>[0][number];
    expect(placementOffered([])).toBe(false);
    expect(placementOffered([q('practice', 'not_seen')])).toBe(false);
    expect(placementOffered([q('placement', 'not_seen'), q('practice', 'answered')])).toBe(true);
    // Left at its first question, or by a reload: offered again.
    expect(placementOffered([q('placement', 'shown'), q('placement', 'not_seen')])).toBe(true);
    expect(placementOffered([q('placement', 'shown'), q('placement', 'answered')])).toBe(false);
    expect(placementOffered([q('placement', 'recall_demonstrated')])).toBe(false);
  });
});

describe('what the recorder answers', () => {
  it('reads results and refusals', () => {
    expect(
      shapeAnswersRecorded({
        recorded: 1,
        duplicates: 0,
        refused: [{ index: 1, reason: 'not_found' }],
        results: [
          {
            clientEventId: 'e1',
            itemId: 'q1',
            correct: true,
            grading: 'deterministic',
            hinted: false,
            provesRecall: true,
          },
        ],
      }),
    ).toEqual({
      recorded: 1,
      duplicates: 0,
      refused: [{ index: 1, clientEventId: null, reason: 'not_found' }],
      results: [
        {
          clientEventId: 'e1',
          itemId: 'q1',
          correct: true,
          grading: 'deterministic',
          hinted: false,
          provesRecall: true,
        },
      ],
    });
  });
});

describe('delayed review', () => {
  const entry = (
    itemId: string,
    dueAt: string | null,
    over: Partial<QuestionEntry> = {},
  ): QuestionEntry => ({
    itemId,
    lessonId: null,
    purpose: 'practice',
    kind: 'cloze',
    state: 'answered',
    authoredBy: 'model',
    dueAt,
    due: dueAt !== null,
    ...over,
  });

  it('asks what the server says is due, soonest first', () => {
    const due = dueQuestions([
      entry('later', '2026-09-26T00:00:00Z', { due: false }),
      entry('never', null),
      entry('second', '2026-09-25T11:00:00Z'),
      entry('first', '2026-09-20T00:00:00Z'),
    ]);
    expect(due.map((q) => q.itemId)).toEqual(['first', 'second']);
  });

  it('reviews what is due, and the review questions only when nothing is', () => {
    const review = [
      entry('r2', null, { purpose: 'review', state: 'recall_demonstrated' }),
      entry('r1', null, { purpose: 'review' }),
    ];
    expect(reviewQueue([...review, entry('d1', '2026-09-20T00:00:00Z')])).toEqual(['d1']);
    // Not yet demonstrated first.
    expect(reviewQueue(review)).toEqual(['r1', 'r2']);
    expect(questionsOf(review, 'review').map((q) => q.itemId)).toEqual(['r1', 'r2']);
  });

  it('practises a lesson just read with what is due on it, then what is not yet shown', () => {
    const entries = [
      entry('elsewhere', '2026-09-20T00:00:00Z', { lessonId: 'l2' }),
      entry('shown', null, { lessonId: 'l1', state: 'recall_demonstrated' }),
      // Demonstrated once, and due again: a lapse practice can clear.
      entry('lapsed', '2026-09-24T00:00:00Z', { lessonId: 'l1', state: 'recall_demonstrated' }),
      entry('fresh', null, { lessonId: 'l1', state: 'not_seen', due: false }),
      entry('check', null, { lessonId: 'l1', purpose: 'placement', state: 'not_seen' }),
    ];
    expect(lessonPractice(entries, 'l1')).toEqual(['lapsed', 'fresh']);
    // A practice question due and not yet shown remembered is asked once, among the due.
    const twice = [...entries, entry('both', '2026-09-23T00:00:00Z', { lessonId: 'l1' })];
    expect(lessonPractice(twice, 'l1')).toEqual(['both', 'lapsed', 'fresh']);
  });
});
