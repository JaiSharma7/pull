import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StudyQuestionCard } from './StudyQuestionCard.js';
import type { StudyQuestion } from '../lib/study-practice.js';

const base: StudyQuestion = {
  itemId: 'q1',
  lessonId: 'l1',
  purpose: 'practice',
  kind: 'multiple_choice',
  prompt: 'Which group remembered more after a week?',
  answer: 'The recall test group',
  acceptedAnswers: [],
  distractors: [
    { text: 'The restudy group', why: 'Only at five minutes.' },
    { text: 'Neither group', why: 'The note reports a difference.' },
  ],
  cloze: null,
  sequence: [],
  pairs: [],
  explanation: 'The delayed tests favoured prior retrieval.',
  authoredBy: 'model',
};

const render = (question: StudyQuestion, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(StudyQuestionCard, {
      question,
      label: 'Question 1 of 2',
      onAnswer: () => undefined,
      onNext: () => undefined,
      ...extra,
    }),
  );

describe('StudyQuestionCard', () => {
  it('asks a choice question with every option as a radio, and a heading to focus', () => {
    const html = render(base);
    expect(html).toContain('Practice · Question 1 of 2');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*>Which group/);
    expect(html).toContain('>Check<');
  });

  it('puts a cloze blank where it belongs, labelled', () => {
    const html = render({
      ...base,
      kind: 'cloze',
      cloze: 'After a week, the ____ group won.',
      distractors: [],
    });
    // Named with the sentence it sits in, not only as "the missing word".
    expect(html).toMatch(
      /After a week, the <input[^>]*aria-label="The missing word or words: After a week, the … group won\."/,
    );
  });

  it('lets each step move with buttons that name the step', () => {
    const html = render({
      ...base,
      kind: 'ordering',
      distractors: [],
      sequence: ['Read the prose', 'Take a test', 'Sit the final test'],
    });
    expect(html).toContain('aria-label="Move “Read the prose” up"');
    expect(html.match(/<li/g)).toHaveLength(3);
  });

  it('gives each left side of a matching question its own labelled choice', () => {
    const html = render({
      ...base,
      kind: 'matching',
      distractors: [],
      pairs: [
        { left: 'Five minutes', right: 'Restudy' },
        { left: 'One week', right: 'Recall test' },
      ],
    });
    expect(html.match(/<select/g)).toHaveLength(2);
    expect(html).toContain('>Five minutes</label>');
  });

  it('says so when the question is the reader’s own version', () => {
    expect(render({ ...base, authoredBy: 'reader' })).toContain('practice, not proof');
  });

  it('offers the passage behind the question when there is one', () => {
    expect(render(base, { renderHint: () => 'passage' })).toContain('Show the passage it rests on');
    expect(render(base)).not.toContain('Show the passage');
  });
});
