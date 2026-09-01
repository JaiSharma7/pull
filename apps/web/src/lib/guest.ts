import type { Session } from '@supabase/supabase-js';

/**
 * Whether this session belongs to a guest.
 *
 * A guest is a real `auth.users` row created by `signInAnonymously`, which is why the
 * rest of the app needs no special case: `session.user.id` is a uuid like any other,
 * RLS behaves identically, and every screen keyed to a reader works. The three places
 * that must know the difference are the ones where an address is the point — the
 * account screen, the sign-out control, and the database (20260901190000).
 *
 * Written as `=== true` rather than as a truthiness check, and that is the whole reason
 * this is a function rather than an inline read. `is_anonymous` is optional on the
 * supabase-js `User`: it is absent from every token minted before anonymous sign-ins
 * were enabled, and absent means *not a guest*. A `!!` over an optional boolean gets
 * that right by accident; the day someone widens the type it stops being an accident
 * and starts being a bug that hides a reader's account page from them.
 */
export function isGuest(session: Session | null): boolean {
  return session?.user.is_anonymous === true;
}
