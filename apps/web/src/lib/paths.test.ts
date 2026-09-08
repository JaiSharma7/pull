import { describe, expect, it } from 'vitest';
import {
  nextUndone,
  progressLabel,
  shapePathDetail,
  shapePaths,
  stepCopy,
  type PathStep,
} from './paths.js';

function makeStep(ordinal: number, done: boolean, kind: PathStep['kind'] = 'read'): PathStep {
  return {
    ordinal,
    kind,
    prompt: `Prompt for step ${ordinal}`,
    comparePullId: null,
    done,
    testedOut: false,
    doneAt: done ? '2026-09-08T00:00:00Z' : null,
    pull: {
      id: `pull-${ordinal}`,
      headline: `Headline ${ordinal}`,
      body: null,
      whyItMatters: null,
      example: null,
      explanation: null,
      work: {
        id: 'work-1',
        title: 'Work 1',
        slug: 'work-1',
      },
    },
    comparePull: null,
  };
}

describe('paths pure helpers', () => {
  describe('nextUndone', () => {
    it('returns the first step when none are done', () => {
      const steps = [makeStep(1, false), makeStep(2, false), makeStep(3, false)];
      expect(nextUndone(steps)?.ordinal).toBe(1);
    });

    it('returns the first undone step when earlier steps are done', () => {
      const steps = [makeStep(1, true), makeStep(2, true), makeStep(3, false), makeStep(4, false)];
      expect(nextUndone(steps)?.ordinal).toBe(3);
    });

    it('returns null when every step is done', () => {
      const steps = [makeStep(1, true), makeStep(2, true), makeStep(3, true)];
      expect(nextUndone(steps)).toBeNull();
    });

    it('returns null for an empty step array', () => {
      expect(nextUndone([])).toBeNull();
    });
  });

  describe('progressLabel', () => {
    it('returns step count when 0 steps completed', () => {
      expect(progressLabel(0, 5)).toBe('5 steps');
      expect(progressLabel(0, 1)).toBe('1 step');
    });

    it('returns progress count when partially done', () => {
      expect(progressLabel(2, 5)).toBe('2 of 5 done');
      expect(progressLabel(4, 5)).toBe('4 of 5 done');
    });

    it('returns Completed when all steps completed or completedAt is present', () => {
      expect(progressLabel(5, 5)).toBe('Completed');
      expect(progressLabel(2, 5, '2026-09-08T00:00:00Z')).toBe('Completed');
    });
  });

  describe('stepCopy', () => {
    it('provides distinct action verbs and descriptions for each kind', () => {
      expect(stepCopy('read').action).toBe('Read');
      expect(stepCopy('predict').action).toBe('Predict');
      expect(stepCopy('compare').action).toBe('Compare');
      expect(stepCopy('say_it_back').action).toBe('Say it back');
      expect(stepCopy('apply').action).toBe('Apply');
    });
  });

  describe('shapePaths', () => {
    it('handles non-array or empty raw inputs', () => {
      expect(shapePaths(null)).toEqual([]);
      expect(shapePaths({})).toEqual([]);
      expect(shapePaths('not an array')).toEqual([]);
    });

    it('filters out invalid rows and parses valid path items', () => {
      const raw = [
        {
          id: 'path-1',
          slug: 'what-is-actually-up-to-me',
          title: 'What is actually up to you?',
          question: 'What is actually up to you?',
          description: 'A five-step progression.',
          topicSlug: 'stoicism',
          stepCount: 5,
          startedAt: null,
          pausedAt: null,
          completedAt: null,
          completedSteps: 0,
        },
        { invalid: true },
      ];
      const shaped = shapePaths(raw);
      expect(shaped).toHaveLength(1);
      expect(shaped[0]?.slug).toBe('what-is-actually-up-to-me');
      expect(shaped[0]?.stepCount).toBe(5);
    });
  });

  describe('shapePathDetail', () => {
    it('returns null for non-record or missing essential fields', () => {
      expect(shapePathDetail(null)).toBeNull();
      expect(shapePathDetail({})).toBeNull();
      expect(shapePathDetail({ slug: 'missing-id' })).toBeNull();
    });

    it('correctly parses steps and comparePull', () => {
      const raw = {
        id: 'p1',
        slug: 'path-one',
        title: 'Path One',
        question: 'Question One?',
        description: 'Description One',
        topicSlug: 'stoicism',
        startedAt: '2026-09-08T00:00:00Z',
        pausedAt: null,
        completedAt: null,
        steps: [
          {
            ordinal: 1,
            kind: 'read',
            prompt: 'Step 1 prompt',
            comparePullId: null,
            done: true,
            testedOut: false,
            doneAt: '2026-09-08T00:01:00Z',
            pull: {
              id: 'pull-1',
              headline: 'Pull 1 headline',
              work: { id: 'w1', title: 'Work 1', slug: 'work-1' },
            },
            comparePull: null,
          },
          {
            ordinal: 2,
            kind: 'compare',
            prompt: 'Step 2 prompt',
            comparePullId: 'pull-1',
            done: false,
            testedOut: false,
            doneAt: null,
            pull: {
              id: 'pull-2',
              headline: 'Pull 2 headline',
              work: { id: 'w1', title: 'Work 1', slug: 'work-1' },
            },
            comparePull: {
              id: 'pull-1',
              headline: 'Pull 1 headline',
              work: { id: 'w1', title: 'Work 1', slug: 'work-1' },
            },
          },
        ],
      };

      const shaped = shapePathDetail(raw);
      expect(shaped).not.toBeNull();
      expect(shaped?.steps).toHaveLength(2);
      expect(shaped?.steps[0]?.kind).toBe('read');
      expect(shaped?.steps[0]?.done).toBe(true);
      expect(shaped?.steps[1]?.comparePull?.id).toBe('pull-1');
    });
  });
});
