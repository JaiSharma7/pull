import { useState } from 'react';
import { supabase } from '../lib/supabase.js';

export function Auth() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
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
        <p role="status" className="pull-card" style={{ padding: 'var(--space-5)' }}>
          Check <strong>{email}</strong> for a sign-in link.
        </p>
      ) : (
        <form onSubmit={submit} className="stack">
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
            {busy ? 'Sending…' : 'Send a sign-in link'}
          </button>
        </form>
      )}
    </main>
  );
}
