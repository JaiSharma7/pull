import { describe, expect, it } from 'vitest';
import {
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
    it('returns the first question when questions are present', () => {
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
