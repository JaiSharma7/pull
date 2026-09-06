import { describe, expect, it } from 'vitest';
import { elapsedSince, MAX_LATENCY_MS } from './submission.js';

/*
 * The bound is a database fact, so it is tested as one. `recall_events_latency_bounds`
 * accepts `null` or `0 <= latency_ms <= 3600000`; anything else is `23514`, which is a
 * permanent refusal, which means the grade carrying it is dropped rather than retried.
 * A grade is worth more than a timing, so out-of-range becomes no timing.
 */
describe('elapsedSince', () => {
  it('mirrors the column bound exactly', () => {
    expect(MAX_LATENCY_MS).toBe(3_600_000);
  });

  it('reports an ordinary answer time', () => {
    expect(elapsedSince(1_000, 4_500)).toBe(3_500);
  });

  it('reports nothing when the answer was never revealed', () => {
    expect(elapsedSince(null, 4_500)).toBeUndefined();
  });

  it('accepts the boundary itself, which the check does too', () => {
    expect(elapsedSince(0, MAX_LATENCY_MS)).toBe(MAX_LATENCY_MS);
    expect(elapsedSince(0, 0)).toBe(0);
  });

  it('omits a reader who walked away, rather than inventing an hour', () => {
    // The case that lost the grade: revealed, then answered 90 minutes later.
    expect(elapsedSince(0, MAX_LATENCY_MS + 1)).toBeUndefined();
    expect(elapsedSince(0, 90 * 60_000)).toBeUndefined();
  });

  it('omits a clock that went backwards rather than sending a negative', () => {
    expect(elapsedSince(5_000, 4_000)).toBeUndefined();
  });
});
