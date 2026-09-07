import { describe, expect, it } from 'vitest';
import { OAUTH_ROUTES, signInRedirectTo } from './oauth.js';

describe('signInRedirectTo', () => {
  it('comes back to the front page when there is nowhere else to be', () => {
    expect(signInRedirectTo('https://whatapull.com', null)).toBe('https://whatapull.com');
  });

  it('carries the destination as a parameter, encoded', () => {
    // Not as the address itself: one redirect shape to allow-list, and GoTrue's own
    // `#access_token=…` would overwrite a fragment naming the idea.
    expect(signInRedirectTo('https://whatapull.com', '/pull/p1#p-p1')).toBe(
      'https://whatapull.com/?next=%2Fpull%2Fp1%23p-p1',
    );
  });

  it('does not double the slash when the origin carries one', () => {
    expect(signInRedirectTo('https://whatapull.com/', null)).toBe('https://whatapull.com');
    expect(signInRedirectTo('https://whatapull.com//', '/explore')).toBe(
      'https://whatapull.com/?next=%2Fexplore',
    );
  });
});

describe('OAUTH_ROUTES', () => {
  it('asks Microsoft for an address and Google for nothing extra', () => {
    // An Entra app registration returns no email claim unless it is asked for, and
    // GoTrue has nothing to key the account by without one.
    const byProvider = Object.fromEntries(OAUTH_ROUTES.map((r) => [r.provider, r]));
    expect(byProvider.azure?.scopes).toBe('email');
    expect(byProvider.google?.scopes).toBeUndefined();
  });

  it('names both providers the same way, because they are the same offer', () => {
    expect(OAUTH_ROUTES.map((r) => r.label)).toEqual([
      'Continue with Google',
      'Continue with Microsoft',
    ]);
  });
});
