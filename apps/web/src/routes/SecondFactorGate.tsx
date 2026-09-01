import { useState } from 'react';
import { RedeemRecoveryCode } from './Account.js';
import { supabase } from '../lib/supabase.js';

/**
 * The screen that makes a second factor mean something.
 *
 * Supabase enrols, challenges and verifies TOTP factors, and it does **not** stop
 * anybody doing anything: after an email code the session is `aal1`, and it stays there
 * unless the app asks for a challenge. Nothing in Postgres blocks an `aal1` token by
 * default either. So a reader who turned on an authenticator, saved their recovery
 * codes and felt safer had exactly the protection they had before — none — and the app
 * would never have told them.
 *
 * That is the failure this file exists to prevent, and it is the same failure the
 * recovery codes are careful not to commit: a security control that cannot be
 * exercised is worse than an absent one, because it is believed.
 *
 * So: if the reader has a verified factor and this session has not satisfied it, the
 * shell does not render. Not a banner, not a nag — the app is not available at `aal1`
 * to an account that asked for a second factor.
 *
 * AND THE WAY BACK IS ON THE SAME SCREEN. A locked-out reader cannot reach
 * `/account` to use a recovery code, because `/account` is behind this gate. Putting
 * `RedeemRecoveryCode` here is what makes the codes a real recovery path rather than a
 * value printed for nothing.
 */
export function SecondFactorGate({ onPassed }: { onPassed: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;
      const factor = (factors?.totp ?? []).find((f) => f.status === 'verified');
      if (!factor) {
        // Nothing to satisfy: the factor was removed elsewhere while this screen was
        // open. Let the caller re-check rather than leaving the reader stuck.
        onPassed();
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: factor.id,
        code: code.replace(/\D/g, ''),
      });
      if (verifyError) throw verifyError;
      onPassed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (recovering) {
    return (
      <main className="stack measure" style={{ padding: 'var(--space-6)' }}>
        <RedeemRecoveryCode onDone={onPassed} />
        <button type="button" className="btn btn--plain" onClick={() => setRecovering(false)}>
          Back to the code
        </button>
      </main>
    );
  }

  return (
    <main className="stack measure" style={{ padding: 'var(--space-6)' }}>
      <p className="meta">Second factor</p>
      <h1 className="display">Enter the code from your authenticator.</h1>
      <p className="lede">
        You are signed in. This account asks for a second factor before it opens.
      </p>

      <label className="stack" htmlFor="gate-code">
        <span className="meta">Six-digit code</span>
        <input
          id="gate-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>

      {error && (
        <p className="meta" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className="btn btn--primary"
        disabled={busy || code.replace(/\D/g, '').length !== 6}
        onClick={() => void submit()}
      >
        {busy ? 'Checking…' : 'Continue'}
      </button>

      <hr className="rule" />

      <p className="meta">
        Lost the authenticator? A recovery code removes it, and you can sign in with an email code
        as before.
      </p>
      <button type="button" className="btn" onClick={() => setRecovering(true)}>
        Use a recovery code
      </button>
      <button type="button" className="btn btn--plain" onClick={() => void supabase.auth.signOut()}>
        Sign out
      </button>
    </main>
  );
}
