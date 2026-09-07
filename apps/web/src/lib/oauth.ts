/**
 * The two ways in that need no mailbox.
 *
 * An email code needs an SMTP provider that will actually deliver it. Supabase's
 * built-in sender is rate-limited per hour and counts requests rather than
 * deliveries — which locked the owner of this product out of it for two hours on
 * 2026-08-31 — and the way past that is a paid transactional sender. An OAuth
 * provider is neither: the credential is one the reader already holds, delivery is
 * somebody else's problem, and the bot signing up with a throwaway address has to
 * get past Google or Microsoft first.
 *
 * It also answers a question the email route could not. `handle_new_user` gets a
 * display name from the provider's metadata, so `ChooseUsername` can offer a
 * username rather than an empty field.
 *
 * NO LOGOS, which is a design decision rather than an oversight. Law 1 allows one
 * accent colour, and Google's mark alone is four — a screen with both providers'
 * brands on it would carry more colours than the rest of the product put together.
 * The names are set in the same type as everything else.
 */

/** What GoTrue calls each provider. `azure` is Microsoft; it has never been renamed. */
export type OAuthProvider = 'google' | 'azure';

export interface OAuthRoute {
  provider: OAuthProvider;
  /** On the button. "Continue with", not "Sign in with": it is also the sign-up. */
  label: string;
  /** What to look for in the Supabase dashboard, for the operator warning. */
  dashboardName: string;
  /**
   * Extra scopes, where the default set is not enough.
   *
   * Microsoft needs `email` asked for explicitly: an Entra app registration returns
   * an id token with no email claim by default, and GoTrue then has no address to
   * key the account by. Google sends both without being asked.
   */
  scopes?: string;
}

export const OAUTH_ROUTES: readonly OAuthRoute[] = [
  { provider: 'google', label: 'Continue with Google', dashboardName: 'Google' },
  {
    provider: 'azure',
    label: 'Continue with Microsoft',
    dashboardName: 'Azure (Microsoft)',
    scopes: 'email',
  },
];

/**
 * Where a completed sign-in comes back to, whichever route it took.
 *
 * One address for the email link and for both providers, for two reasons: one
 * redirect shape to allow-list rather than one per route, and the destination
 * survives as a query parameter where a fragment would not — GoTrue appends its own
 * `#access_token=…` on the way back, which would overwrite anything already there.
 * `App` spends the `next` once a session exists.
 *
 * Pure so the shape can be tested without a browser; the caller passes its origin.
 */
export function signInRedirectTo(origin: string, next: string | null): string {
  const clean = origin.replace(/\/+$/, '');
  return next ? `${clean}/?next=${encodeURIComponent(next)}` : clean;
}
