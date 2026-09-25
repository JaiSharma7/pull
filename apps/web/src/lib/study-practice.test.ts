import { describe, expect, it } from 'vitest';
import { gradeStudyResponse, needsSelfGrade, studyFold } from './study-grade.js';
import {
  choiceOptions,
  clozeParts,
  initialOrder,
  knownLessons,
  matchingChoices,
  moveStep,
  rightAnswer,
  shapeAnswersRecorded,
  shapeQuestion,
  shapeQuestionEntries,
  whyChosenWrong,
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
  it('suggests only lessons whose every placement question was checked right, unaided', () => {
    const answers = [
      {
        itemId: 'p1',
        lessonId: 'l1',
        correct: true,
        grading: 'deterministic' as const,
        hinted: false,
      },
      {
        itemId: 'p2',
        lessonId: 'l1',
        correct: true,
        grading: 'deterministic' as const,
        hinted: false,
      },
      { itemId: 'p3', lessonId: 'l2', correct: true, grading: 'self' as const, hinted: false },
      {
        itemId: 'p4',
        lessonId: 'l3',
        correct: true,
        grading: 'deterministic' as const,
        hinted: true,
      },
      {
        itemId: 'p5',
        lessonId: 'l4',
        correct: false,
        grading: 'deterministic' as const,
        hinted: false,
      },
      {
        itemId: 'p6',
        lessonId: null,
        correct: true,
        grading: 'deterministic' as const,
        hinted: false,
      },
    ];
    expect(knownLessons(answers, ['l4', 'l3', 'l2', 'l1', 'l5'])).toEqual(['l1']);
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
