import { describe, expect, it } from 'vitest';
import { isAnonymousSignInDisabled, isCaptchaRequired, isEmailRateLimited } from './auth-errors.js';

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

describe('isAnonymousSignInDisabled', () => {
  it('recognises the error code, which is the stable contract', () => {
    expect(
      isAnonymousSignInDisabled({ code: 'anonymous_provider_disabled', message: 'anything' }),
    ).toBe(true);
  });

  it('falls back to the wording GoTrue actually sends', () => {
    // Both shapes seen in the wild; the switch has been renamed once already.
    expect(isAnonymousSignInDisabled({ message: 'Anonymous sign-ins are disabled' })).toBe(true);
    expect(isAnonymousSignInDisabled({ message: 'anonymous provider is disabled' })).toBe(true);
  });

  it('leaves every other failure alone', () => {
    /*
     * The guard against over-matching. Telling a reader to go and turn on a project
     * setting when their code has simply expired sends them somewhere they cannot fix
     * anything -- and on a hosted project, somewhere they may not even have access to.
     */
    for (const message of [
      'Token has expired or is invalid',
      'Signups not allowed for otp',
      'email rate limit exceeded',
      'Database error creating anonymous user',
    ]) {
      expect(isAnonymousSignInDisabled({ message }), message).toBe(false);
    }
  });
});

describe('isCaptchaRequired', () => {
  it('recognises the code GoTrue returns', () => {
    // Read out of this project's own auth logs on 2026-09-01, not out of the docs.
    // The message deliberately does NOT contain "captcha", so this exercises the code
    // branch rather than the regex fallback. With GoTrue's real message the two overlap,
    // and deleting the `error.code` check left every test green.
    expect(isCaptchaRequired({ code: 'captcha_failed', message: 'request disallowed' })).toBe(true);
  });

  it('falls back to the message when no code is sent', () => {
    expect(
      isCaptchaRequired({ message: 'captcha protection: request disallowed (not-using-dummy)' }),
    ).toBe(true);
    expect(isCaptchaRequired({ message: 'captcha verification process failed' })).toBe(true);
  });

  it('leaves every other failure alone', () => {
    for (const message of [
      'Token has expired or is invalid',
      'Anonymous sign-ins are disabled',
      'email rate limit exceeded',
      'Database error creating anonymous user',
    ]) {
      expect(isCaptchaRequired({ message }), message).toBe(false);
    }
  });

  it('does not collide with the other two classifiers', () => {
    // All three run against the same error in Auth.tsx, so an error that matched two of
    // them would make the branch order load-bearing and the message a coin flip.
    const captcha = {
      code: 'captcha_failed',
      message: 'captcha protection: request disallowed (no captcha_token found)',
    };
    expect(isEmailRateLimited(captcha)).toBe(false);
    expect(isAnonymousSignInDisabled(captcha)).toBe(false);
  });
});
