import { useEffect, useState } from 'react';
import { OAuthButtons } from '../components/OAuthButtons.js';
import { isAnonymousSignInDisabled, isCaptchaRequired } from '../lib/auth-errors.js';
import { oauthRedirectError } from '../lib/oauth.js';
import { rememberDestination } from '../lib/pending-destination.js';
import { supabase } from '../lib/supabase.js';

export function Auth({
  onNavigate,
  next = null,
}: {
  onNavigate: (to: string) => void;
  next?: string | null;
}) {
  const [redirectError] = useState(() => oauthRedirectError(window.location.hash));
  const [guestError, setGuestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (redirectError)
      history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [redirectError]);
  async function openGuest() {
    setBusy(true);
    setGuestError(null);
    try {
      rememberDestination(next);
      const { error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
    } catch (error) {
      setGuestError(
        isAnonymousSignInDisabled(error instanceof Error ? error : { message: String(error) })
          ? 'Guest reading is unavailable. Continue with Google or Microsoft, or browse the library.'
          : isCaptchaRequired(error instanceof Error ? error : { message: String(error) })
            ? 'Guest reading is unavailable on this deployment. Continue with Google or Microsoft.'
            : error instanceof Error
              ? error.message
              : 'Could not start a guest session. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth stack measure">
      <p className="meta">What a Pull</p>
      <h1>Something worth keeping.</h1>
      <p className="lede">
        Sign in to keep ideas, follow your interests, and pick up where you left off.
      </p>
      {redirectError && <p role="alert">{redirectError}</p>}
      <OAuthButtons next={next} />
      <p className="meta">
        Sign in with Google or Microsoft. Email and password sign-in is unavailable.
      </p>
      <hr className="rule" />
      <button type="button" className="btn" disabled={busy} onClick={() => void openGuest()}>
        {busy ? 'Opening guest reading…' : 'Read as a guest'}
      </button>
      {guestError && (
        <p className="meta" role="alert">
          {guestError}
        </p>
      )}
      <p className="meta">
        Guest reading stays in this browser session. It does not carry over when you sign in.
      </p>
      <button type="button" className="btn btn--plain" onClick={() => onNavigate('/explore')}>
        Browse the library
      </button>
      <p className="meta">
        By continuing, you agree to our <a href="/terms">Terms</a> and{' '}
        <a href="/privacy">Privacy Policy</a>.
      </p>
    </main>
  );
}
