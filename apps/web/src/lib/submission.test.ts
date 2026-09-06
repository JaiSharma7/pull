import { describe, expect, it, vi } from 'vitest';
import { mutationId, nextSubmissionStamp } from './submission.js';

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

/**
 * The id that must not be the thing that loses a submission.
 *
 * `crypto.randomUUID` is undefined in a non-secure context. Called bare it throws where
 * it is called, and `Feed.tsx` calls it AFTER the slot is marked handled — so the
 * reader's stance and explanation would go with no banner, no queue entry and no retry.
 */
describe('mutationId', () => {
  const withCrypto = <T>(value: unknown, run: () => T): T => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value, configurable: true });
    try {
      return run();
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
      else delete (globalThis as unknown as Record<string, unknown>).crypto;
    }
  };

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('uses randomUUID when there is one', () => {
    expect(mutationId()).toMatch(UUID);
  });

  it('falls back to getRandomValues rather than throwing', () => {
    const ids = withCrypto(
      { getRandomValues: (a: Uint8Array) => a.map((_, i) => (i * 37 + 11) % 256) },
      () => [mutationId(), mutationId()],
    );
    for (const id of ids) expect(id).toMatch(UUID);
    // Version and variant nibbles, so it is a v4 uuid rather than something shaped like
    // one — the column is `uuid` in `20260905100000` and would refuse anything else.
    expect(ids[0]![14]).toBe('4');
    expect('89ab').toContain(ids[0]![19]);
  });

  it('still answers with no crypto at all', () => {
    // The last resort. Weaker, and unique enough for what the id is FOR: a
    // `(user_id, client_mutation_id)` index recognising one reader's retry.
    const ids = withCrypto(undefined, () => [mutationId(), mutationId(), mutationId()]);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(3);
  });

  it('never throws, which is the whole point', () => {
    for (const value of [undefined, {}, { randomUUID: null }]) {
      expect(() => withCrypto(value, () => mutationId())).not.toThrow();
    }
  });
});
