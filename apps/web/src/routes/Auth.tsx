import { useState } from 'react';
import { supabase } from '../lib/supabase.js';

/**
 * Sign-in accepts a code *or* a link, deliberately.
 *
 * `signInWithOtp` sends one email that can carry both: `{{ .Token }}` renders a
 * six-digit code, `{{ .ConfirmationURL }}` a magic link. Which one arrives depends on
 * the project's email template, and supporting only one of them makes sign-in depend on
 * a setting no code in this repository can see.
 *
 * Accepting both is also better on a phone, where the link often opens in a different
 * browser than the one that started the sign-in — and the session then lands in the
 * wrong place. A typed code always completes in the tab the reader is already in, and
 * needs no redirect URL allow-listed to work on preview deployments.
 */
export function Auth() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      // Only used if the email carries a link rather than a code. Harmless otherwise.
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // `type: 'email'` covers both a new and a returning reader; Supabase resolves which
    // it is. On success the client stores the session and App.tsx's auth listener swaps
    // this screen out, so there is nothing to do with the result here.
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type: 'email',
    });
    setBusy(false);
    if (error) setError(error.message);
  }

  function startOver() {
    setSent(false);
    setCode('');
    setError(null);
  }

  return (
    <main className="stack measure" style={{ padding: 'var(--space-8) var(--space-5)' }}>
      <p className="meta">What a Pull</p>
      <h1>Pull something worth keeping.</h1>
      <p>
        Ideas from books, films, papers and talks — anchored to real sources, argued with, and
        actually remembered. No subscription, and nothing worth having behind one.
      </p>

      {sent ? (
        <form onSubmit={verifyCode} className="stack">
          <p role="status">
            We sent a sign-in email to <strong>{email}</strong>. Enter the code below, or open the
            link in the email if it has one instead.
          </p>
          <label className="field">
            <span className="field__label">Sign-in code</span>
            <input
              className="field__input"
              type="text"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              // Codes are six digits today, but the length is a server-side detail and a
              // hard maxLength would silently truncate a longer one into a wrong code.
              pattern="[0-9]*"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" style={{ color: 'var(--accent)' }}>
              {error}
            </p>
          )}
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button type="button" className="btn btn--plain" onClick={startOver} disabled={busy}>
            Use a different email
          </button>
        </form>
      ) : (
        <form onSubmit={requestCode} className="stack">
          <label className="field">
            <span className="field__label">Email</span>
            <input
              className="field__input"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" style={{ color: 'var(--accent)' }}>
              {error}
            </p>
          )}
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send a sign-in code'}
          </button>
        </form>
      )}
    </main>
  );
}
