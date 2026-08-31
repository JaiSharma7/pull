import { describe, expect, it } from 'vitest';
import { isEmailRateLimited } from './auth-errors.js';

describe('isEmailRateLimited', () => {
  it('recognises the error code, which is the stable contract', () => {
    expect(isEmailRateLimited({ code: 'over_email_send_rate_limit', message: 'anything' })).toBe(
      true,
    );
  });

  it('falls back to the message for builds that send no code', () => {
    // The exact string GoTrue returned on 2026-08-31, and the per-address variant.
    expect(isEmailRateLimited({ message: 'email rate limit exceeded' })).toBe(true);
    expect(
      isEmailRateLimited({
        message: 'For security purposes, you can only request this after 51 seconds.',
      }),
    ).toBe(false);
  });

  it('is case-insensitive, because the wording is not ours to rely on', () => {
    expect(isEmailRateLimited({ message: 'Email Rate Limit Exceeded' })).toBe(true);
  });

  it('leaves ordinary failures alone, so "try again" still means try again', () => {
    /*
     * The guard against over-matching. Every one of these IS fixed by retrying or by
     * correcting the input, and hijacking them into "the mailbox is closed" would
     * mislead a reader whose real problem is a typo or an expired code.
     */
    for (const message of [
      'Token has expired or is invalid',
      'Invalid login credentials',
      'Unable to validate email address: invalid format',
      'Email link is invalid or has expired',
      'Signups not allowed for otp',
    ]) {
      expect(isEmailRateLimited({ message }), message).toBe(false);
    }
  });
});
