import { describe, expect, it } from 'vitest';
import {
  chooseQuestion,
  formatReviewProgress,
  mcqOptionMarker,
  nextSessionTotal,
  resolveActiveQuestion,
  resolveEffectiveKind,
  toActivityQuestion,
} from './review-question.js';
import type { DueReview, ReviewQuestion } from './types.js';

describe('review-question', () => {
  describe('toActivityQuestion', () => {
    it('normalises null distractors and rationale into empty arrays', () => {
      const dbQ: ReviewQuestion = {
        id: '11111111-1111-4111-8111-111111111111',
        source: 'canonical',
        kind: 'recall',
        prompt: 'What is the chief good in Stoicism?',
        answer: 'Virtue',
        distractors: null,
        cloze: null,
        explanation: 'Virtue is the sole good.',
        rationale: null,
      };

      const q = toActivityQuestion(dbQ);
      expect(q.distractors).toEqual([]);
      expect(q.rationale).toEqual([]);
      expect(q.prompt).toBe('What is the chief good in Stoicism?');
      expect(q.answer).toBe('Virtue');
    });

    it('preserves existing distractors and rationale', () => {
      const dbQ: ReviewQuestion = {
        id: '22222222-2222-4222-8222-222222222222',
        source: 'canonical',
        kind: 'mcq',
        prompt: 'What is virtue?',
        answer: 'The sole good',
        distractors: ['An indifferent', 'A vice'],
        cloze: null,
        explanation: 'Only virtue is good in itself.',
        rationale: [
          { distractor: 'An indifferent', why: 'Indifferents are neither good nor bad.' },
        ],
      };

      const q = toActivityQuestion(dbQ);
      expect(q.distractors).toEqual(['An indifferent', 'A vice']);
      expect(q.rationale).toHaveLength(1);
    });
  });

  describe('resolveActiveQuestion', () => {
    it('returns the only question however many times the idea has been reviewed', () => {
      const q1: ReviewQuestion = {
        id: 'q1',
        source: 'user',
        kind: 'recall',
        prompt: 'My prompt',
        answer: null,
        distractors: null,
        cloze: null,
        explanation: null,
        rationale: null,
      };
      const card: DueReview = {
        pullId: 'p1',
        headline: 'Headline',
        body: 'Body',
        whyItMatters: null,
        workTitle: 'Work',
        workSlug: 'work',
        retrievability: 0.8,
        stability: 10,
        reps: 2,
        dueAt: '2026-09-08T00:00:00Z',
        question: 'Headline',
        questionId: null,
        questionSource: null,
        questions: [q1],
      };

      expect(resolveActiveQuestion(card)).toBe(q1);
    });

    it('rotates by how many times the idea has been reviewed', () => {
      const shape = {
        answer: 'A',
        distractors: null,
        cloze: null,
        explanation: null,
        rationale: null,
      };
      const recall: ReviewQuestion = {
        ...shape,
        id: 'r',
        source: 'canonical',
        kind: 'recall',
        prompt: 'Recall',
      };
      const mcq: ReviewQuestion = {
        ...shape,
        id: 'm',
        source: 'canonical',
        kind: 'mcq',
        prompt: 'Choose',
        distractors: ['B', 'C'],
      };
      const card: DueReview = {
        pullId: 'p1',
        headline: 'Headline',
        body: 'Body',
        whyItMatters: null,
        workTitle: 'Work',
        workSlug: 'work',
        retrievability: 0.8,
        stability: 10,
        reps: 0,
        dueAt: '2026-09-08T00:00:00Z',
        question: 'Recall',
        questionId: 'r',
        questionSource: 'canonical',
        questions: [recall, mcq],
      };

      expect(resolveActiveQuestion(card)?.id).toBe('r');
      expect(resolveActiveQuestion({ ...card, reps: 1 })?.id).toBe('m');
      expect(resolveActiveQuestion({ ...card, reps: 2 })?.id).toBe('r');
    });

    it('returns null when questions array is empty or undefined', () => {
      const card: DueReview = {
        pullId: 'p1',
        headline: 'Headline',
        body: 'Body',
        whyItMatters: null,
        workTitle: 'Work',
        workSlug: 'work',
        retrievability: 0.8,
        stability: 10,
        reps: 2,
        dueAt: '2026-09-08T00:00:00Z',
        question: 'Headline',
        questionId: null,
        questionSource: null,
      };

      expect(resolveActiveQuestion(card)).toBeNull();
    });
  });

  describe('resolveEffectiveKind', () => {
    it('selects mcq when kind is mcq and choices are >= 2', () => {
      const q = toActivityQuestion({
        id: 'q-mcq',
        source: 'canonical',
        kind: 'mcq',
        prompt: 'Pick one',
        answer: 'A',
        distractors: ['B', 'C'],
        cloze: null,
        explanation: null,
        rationale: null,
      });

      expect(resolveEffectiveKind(q, ['A', 'B', 'C'])).toBe('mcq');
    });

    it('degrades mcq to recall when choices are < 2', () => {
      const q = toActivityQuestion({
        id: 'q-mcq-few',
        source: 'canonical',
        kind: 'mcq',
        prompt: 'Pick one',
        answer: 'A',
        distractors: [],
        cloze: null,
        explanation: null,
        rationale: null,
      });

      expect(resolveEffectiveKind(q, ['A'])).toBe('recall');
    });

    it('selects cloze when kind is cloze and answer is present', () => {
      const q = toActivityQuestion({
        id: 'q-cloze',
        source: 'canonical',
        kind: 'cloze',
        prompt: 'Fill',
        answer: 'Target',
        distractors: null,
        cloze: 'The [blank] is here.',
        explanation: null,
        rationale: null,
      });

      expect(resolveEffectiveKind(q, [])).toBe('cloze');
    });

    it('degrades cloze to recall when answer is blank', () => {
      const q = toActivityQuestion({
        id: 'q-cloze-blank',
        source: 'canonical',
        kind: 'cloze',
        prompt: 'Fill',
        answer: '   ',
        distractors: null,
        cloze: 'The [blank] is here.',
        explanation: null,
        rationale: null,
      });

      expect(resolveEffectiveKind(q, [])).toBe('recall');
    });

    it('degrades other kinds to recall', () => {
      const q = toActivityQuestion({
        id: 'q-other',
        source: 'canonical',
        kind: 'short_answer',
        prompt: 'Reflect',
        answer: 'Answer',
        distractors: null,
        cloze: null,
        explanation: null,
        rationale: null,
      });

      expect(resolveEffectiveKind(q, [])).toBe('recall');
    });

    it('defaults to recall when question is null', () => {
      expect(resolveEffectiveKind(null, [])).toBe('recall');
    });
  });

  describe('formatReviewProgress', () => {
    it('formats 1 of N line according to Law 7', () => {
      expect(formatReviewProgress(1, 5)).toBe('Review · 1 of 5 fading');
      expect(formatReviewProgress(3, 10)).toBe('Review · 3 of 10 fading');
      expect(formatReviewProgress(1, 1)).toBe('Review · 1 of 1 fading');
    });
  });
});

describe('mcqOptionMarker', () => {
  it('says nothing before the reader has answered', () => {
    expect(mcqOptionMarker('Virtue', 'Virtue', null)).toBeNull();
  });

  it('names the correct option in words, not only in colour', () => {
    expect(mcqOptionMarker('Virtue', 'Virtue', 'Wealth')).toBe('Correct answer');
    expect(mcqOptionMarker('Virtue', ' Virtue ', 'Wealth')).toBe('Correct answer');
  });

  it("names the reader's wrong pick, and leaves the rest unmarked", () => {
    expect(mcqOptionMarker('Wealth', 'Virtue', 'Wealth')).toBe('Your answer');
    expect(mcqOptionMarker('Fame', 'Virtue', 'Wealth')).toBeNull();
  });

  it('marks a right pick as the correct answer rather than twice', () => {
    expect(mcqOptionMarker('Virtue', 'Virtue', 'Virtue')).toBe('Correct answer');
  });
});

describe('nextSessionTotal', () => {
  it('takes the first page as the total', () => {
    expect(nextSessionTotal(null, 20)).toBe(20);
  });

  it('adds a further page to a total whose cards have all been answered', () => {
    expect(nextSessionTotal(20, 5)).toBe(25);
  });

  it('never shrinks, and an empty further page changes nothing', () => {
    expect(nextSessionTotal(20, 0)).toBe(20);
  });
});

describe('chooseQuestion', () => {
  const q = (id: string, kind: ReviewQuestion['kind']): ReviewQuestion => ({
    id,
    source: 'canonical',
    kind,
    prompt: `Prompt ${id}`,
    answer: 'Answer',
    distractors: kind === 'mcq' ? ['A', 'B'] : null,
    cloze: kind === 'cloze' ? 'The ___.' : null,
    explanation: null,
    rationale: null,
  });
  const three = [q('r', 'recall'), q('m', 'mcq'), q('c', 'cloze')];

  it('gives every kind on the card its turn, in order, then round again', () => {
    // A card leaves the page once graded, so the only way the mcq and the cloze are
    // ever asked is a different pick on a different visit.
    expect(chooseQuestion(three, 0)?.id).toBe('r');
    expect(chooseQuestion(three, 1)?.id).toBe('m');
    expect(chooseQuestion(three, 2)?.id).toBe('c');
    expect(chooseQuestion(three, 3)?.id).toBe('r');
  });

  it('is the same pick for the same turn -- a card does not rename itself between loads', () => {
    // Two fetches build two arrays. The pick depends on the turn and the order, not on
    // which array object it was handed, and 7 on a card of three is the second.
    const again = [q('r', 'recall'), q('m', 'mcq'), q('c', 'cloze')];
    expect(chooseQuestion(three, 7)?.id).toBe('m');
    expect(chooseQuestion(again, 7)?.id).toBe('m');
  });

  it("asks the reader's own question every time once they have written one", () => {
    // `get_due_reviews` has ranked a reader's question above a canonical one since
    // 20260905110000; rotating past it would undo that two visits in three.
    const mine = { ...q('mine', 'recall'), source: 'user' as const };
    const card = [mine, q('m', 'mcq'), q('c', 'cloze')];
    for (const turn of [0, 1, 2, 3, 7]) {
      expect(chooseQuestion(card, turn)?.id).toBe('mine');
    }
  });

  it("rotates among the reader's own questions when there are several", () => {
    const first = { ...q('mine-1', 'recall'), source: 'user' as const };
    const second = { ...q('mine-2', 'cloze'), source: 'user' as const };
    const card = [first, second, q('m', 'mcq')];
    expect(chooseQuestion(card, 0)?.id).toBe('mine-1');
    expect(chooseQuestion(card, 1)?.id).toBe('mine-2');
    expect(chooseQuestion(card, 2)?.id).toBe('mine-1');
  });

  it('floors a fractional turn, and treats a missing or negative one as the first', () => {
    expect(chooseQuestion(three, Number.NaN)?.id).toBe('r');
    expect(chooseQuestion(three, -4)?.id).toBe('r');
    expect(chooseQuestion(three, 1.9)?.id).toBe('m');
  });

  it('returns null with nothing to choose from', () => {
    expect(chooseQuestion([], 3)).toBeNull();
    expect(chooseQuestion(undefined, 0)).toBeNull();
  });

  it('is what resolveActiveQuestion rotates a due card by', () => {
    const base = {
      pullId: 'p1',
      headline: 'Headline',
      body: 'Body',
      whyItMatters: null,
      workTitle: 'Work',
      workSlug: 'work',
      retrievability: 0.8,
      stability: 10,
      dueAt: '2026-09-08T00:00:00Z',
      question: 'Headline',
      questionId: null,
      questionSource: null,
      questions: three,
    };
    expect(resolveActiveQuestion({ ...base, reps: 0 })?.id).toBe('r');
    expect(resolveActiveQuestion({ ...base, reps: 1 })?.id).toBe('m');
    expect(resolveActiveQuestion({ ...base, reps: 5 })?.id).toBe('c');
  });
});
