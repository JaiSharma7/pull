import type { SignInWithOAuthCredentials } from '@supabase/supabase-js';

export type OAuthProvider = 'google' | 'azure';

/** Only an app-local destination may ride through the provider callback. */
export function oauthRequest(
  provider: OAuthProvider,
  origin: string,
  next: string | null,
): SignInWithOAuthCredentials {
  const redirect = new URL('/', origin);
  if (
    next?.startsWith('/') &&
    !next.startsWith('//') &&
    !next.includes('\\') &&
    !Array.from(next).some((char) => char.charCodeAt(0) < 32)
  ) {
    redirect.searchParams.set('next', next);
  }
  return {
    provider,
    options: {
      redirectTo: redirect.href,
      ...(provider === 'azure' ? { scopes: 'email' } : {}),
      queryParams: { prompt: 'select_account' },
    },
  };
}

export function oauthRedirectError(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (!params.has('error') && !params.has('error_code')) return null;
  if (params.get('error') === 'access_denied')
    return 'Sign-in was cancelled. Choose Google or Microsoft to try again.';
  return 'Sign-in could not be completed. Please try Google or Microsoft again.';
}
