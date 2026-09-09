import { describe, expect, it } from 'vitest';
import { oauthRequest, oauthRedirectError } from './oauth.js';

describe('OAuth sign-in', () => {
  it('asks Microsoft for the email scope and returns to the original idea', () => {
    const request = oauthRequest('azure', 'https://whatapull.com', '/pull/123#p-123');
    expect(request.provider).toBe('azure');
    expect(request.options?.scopes).toBe('email');
    const redirect = new URL(request.options!.redirectTo!);
    expect(redirect.origin).toBe('https://whatapull.com');
    expect(redirect.searchParams.get('next')).toBe('/pull/123#p-123');
  });
  it('keeps external and malformed destinations out of the callback', () => {
    for (const next of ['https://evil.test', '//evil.test', '/\\evil.test', '/\nevil.test']) {
      expect(oauthRequest('google', 'https://whatapull.com', next).options?.redirectTo).toBe(
        'https://whatapull.com/',
      );
    }
  });
  it('offers account selection and supports a return to account settings', () => {
    const request = oauthRequest('google', 'https://whatapull.com', '/settings?section=account');
    expect(request.options?.queryParams?.prompt).toBe('select_account');
    expect(new URL(request.options!.redirectTo!).searchParams.get('next')).toBe(
      '/settings?section=account',
    );
  });
  it('explains cancelled redirects without offering an email code', () => {
    expect(oauthRedirectError('#error=access_denied')).toMatch(/cancelled/i);
    expect(oauthRedirectError('#access_token=anything')).toBeNull();
    expect(oauthRedirectError('#error_code=otp_expired')).toMatch(/Google or Microsoft/);
  });
});
