import type { Session, User } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { isGuest } from './guest.js';

/**
 * Only the fields `isGuest` reads. Cast at the boundary rather than building a whole
 * `Session`, which would be forty fields of noise around the one that matters.
 */
function sessionWith(user: Partial<User>): Session {
  return { user: user as User } as Session;
}

describe('isGuest', () => {
  it('is true for an anonymous session', () => {
    expect(isGuest(sessionWith({ id: 'u1', is_anonymous: true }))).toBe(true);
  });

  it('is false for a reader who signed in with an address', () => {
    expect(isGuest(sessionWith({ id: 'u1', is_anonymous: false }))).toBe(false);
  });

  it('is false when the claim is absent', () => {
    /*
     * The case that matters. Every token minted before anonymous sign-ins were enabled
     * carries no `is_anonymous` at all, and those belong to people with real accounts —
     * so treating "absent" as anything but "not a guest" would hide the account screen
     * from every existing reader until their token expired.
     */
    expect(isGuest(sessionWith({ id: 'u1' }))).toBe(false);
  });

  it('is false for a visitor with no session', () => {
    expect(isGuest(null)).toBe(false);
  });
});
