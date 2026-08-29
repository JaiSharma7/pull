import { describe, expect, it, vi } from 'vitest';
import { nextSubmissionStamp } from './submission.js';

describe('submission stamps', () => {
  it('never repeats, even when the clock does not move', () => {
    // The whole point: two stances submitted inside one millisecond would
    // otherwise share a timestamp, and equal timestamps carry no information
    // about which the reader decided first.
    const frozen = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const stamps = Array.from({ length: 5 }, () => nextSubmissionStamp());
      expect(new Set(stamps).size).toBe(5);
      expect([...stamps]).toEqual([...stamps].sort((a, b) => a - b));
    } finally {
      frozen.mockRestore();
    }
  });

  it('follows the clock forward once it moves past the running stamp', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    try {
      const first = nextSubmissionStamp();
      clock.mockReturnValue(9_000);
      const later = nextSubmissionStamp();

      expect(later).toBeGreaterThan(first);
      // It tracks the clock rather than drifting: a real jump forward is taken
      // as-is, not incremented from wherever the counter had reached.
      expect(later).toBe(9_000);
    } finally {
      clock.mockRestore();
    }
  });
});
