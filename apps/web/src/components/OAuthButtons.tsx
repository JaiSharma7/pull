import { useState } from 'react';
import { oauthRequest, type OAuthProvider } from '../lib/oauth.js';
import { rememberDestination } from '../lib/pending-destination.js';
import { supabase } from '../lib/supabase.js';

export function OAuthButtons({ next = null }: { next?: string | null }) {
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function signIn(provider: OAuthProvider) {
    if (busy) return;
    setBusy(provider);
    setError(null);
    try {
      const request = oauthRequest(provider, window.location.origin, next);
      rememberDestination(new URL(request.options!.redirectTo!).searchParams.get('next'));
      const { error } = await supabase.auth.signInWithOAuth(request);
      if (error) throw error;
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not start sign-in. Please try again.',
      );
      setBusy(null);
    }
  }
  return (
    <div className="stack">
      {error && (
        <p className="meta" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy !== null}
        onClick={() => void signIn('google')}
      >
        {busy === 'google' ? 'Opening Google…' : 'Continue with Google'}
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy !== null}
        onClick={() => void signIn('azure')}
      >
        {busy === 'azure' ? 'Opening Microsoft…' : 'Continue with Microsoft'}
      </button>
    </div>
  );
}
