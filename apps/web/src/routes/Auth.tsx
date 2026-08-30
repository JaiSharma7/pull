import { useRef, useState } from 'react';
import { CodeInput } from '../components/CodeInput.js';
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
/**
 * Read the failure GoTrue redirects back with, and clear it from the address bar.
 *
 * A rejected magic link does not come back as an exception anywhere this app can
 * catch. GoTrue redirects to `/#error=access_denied&error_code=otp_expired&...`;
 * auth-js parses that into an `AuthImplicitGrantRedirectError` which is only ever
 * surfaced through `auth.initialize()`, and nothing calls it. `getSession()` then
 * resolves `{ session: null, error: null }` — indistinguishable from never having
 * signed in. It also only clears the hash on the *success* path.
 *
 * So without this, the reader clicks the link, lands on a URL full of error
 * parameters, and is shown an empty sign-in form with no explanation. They conclude
 * the product is broken, and they are not wrong to.
 *
 * This is not a rare path. Links expire in an hour, and Outlook Safe Links, Defender
 * and Gmail's proxy routinely *consume* a link before the human clicks it — so a
 * reader's first ever click can return `otp_expired` on a link thirty seconds old.
 */
function readRedirectError(): string | null {
  // The hash, not the query string: implicit flow puts everything after the `#`.
  const params = new URLSearchParams(window.location.hash.slice(1));
  const code = params.get('error_code');
  const description = params.get('error_description');
  if (!code && !description && !params.get('error')) return null;

  // Cleared so a reload does not resurrect an error the reader has already read,
  // and so the parameters do not sit in the address bar looking like a crash.
  history.replaceState(null, '', window.location.pathname + window.location.search);

  if (code === 'otp_expired') {
    return 'That sign-in link has expired or was already used. Enter your email and we will send a fresh one.';
  }
  // `error_description` arrives URL-encoded with `+` for spaces.
  return (
    description?.replace(/\+/g, ' ') ?? 'That sign-in link did not work. Send yourself a new one.'
  );
}

export function Auth() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  // Read once, during the first render, because it consumes the hash as it reads.
  const [error, setError] = useState<string | null>(readRedirectError);
  const [busy, setBusy] = useState(false);
  /** So a complete code can submit the form without the reader reaching for the button. */
  const formRef = useRef<HTMLFormElement>(null);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // try/finally, not try/catch-then-reset: supabase-js converts its own AuthErrors
    // into `{ error }` but rethrows anything else — a DNS failure, an offline device,
    // a wedged Web Lock. Resetting `busy` after a bare await therefore left the button
    // reading "Sending…" forever, disabled, with no message and no way forward but a
    // reload that also discards the address they just typed.
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        // Only used if the email carries a link rather than a code. Harmless otherwise.
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) setError(error.message);
      else setSent(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not reach the server. Check your connection.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // `type: 'email'` covers both a new and a returning reader; Supabase resolves which
    // it is. On success the client stores the session and App.tsx's auth listener swaps
    // this screen out, so there is nothing to do with the result here.
    try {
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: code.trim(),
        type: 'email',
      });
      if (error) setError(error.message);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not reach the server. Check your connection.',
      );
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setSent(false);
    setCode('');
    setError(null);
  }

  /**
   * Ask for another code without losing the address.
   *
   * The only previous exit from this screen was "use a different email", which discards
   * a correct address — the wrong affordance for the actual problem, which is almost
   * always a slow email rather than a wrong one. It also gives somewhere to go when
   * Supabase's built-in SMTP rate limit fires, whose message ("you can only request this
   * after 51 seconds") is otherwise a dead end.
   */
  async function resend() {
    setBusy(true);
    setError(null);
    setCode('');
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      setError(error ? error.message : 'Sent. Check your email again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  /*
   * The title page.
   *
   * Centred on both axes and capped at --measure, so the screen has one axis and
   * nothing on it competes. It was previously a 544px column pinned to left: 0 with
   * 900px of dead space beside it — which reads as a broken layout rather than a spare
   * one, on the first thing anyone sees.
   *
   * Step two is this same screen advanced, not a different one: the masthead, the title
   * and the rule hold their positions so the page does not appear to jump when the code
   * form replaces the email form. See docs/design-first-run.md.
   */
  return (
    <main className="titlepage">
      <div className="titlepage__inner stack">
        <p className="meta titlepage__mark">What a Pull</p>
        <h1 className="titlepage__title">Pull something worth keeping.</h1>
        <p className="titlepage__lede">
          Ideas from books, films, papers and talks — anchored to real sources, argued with, and
          actually remembered.
        </p>

        <hr className="rule" />

        {sent ? (
          <form onSubmit={verifyCode} className="stack" ref={formRef}>
            <p role="status" className="titlepage__sent">
              We sent a code to <strong>{email}</strong>
            </p>
            <div className="field">
              <span className="field__label" id="code-label">
                Sign-in code
              </span>
              <CodeInput
                value={code}
                onChange={setCode}
                disabled={busy}
                // A complete code submits. At six digits there is exactly one thing the
                // reader wants, and making them reach for a button is friction with no
                // purpose behind it.
                onComplete={() => formRef.current?.requestSubmit()}
              />
            </div>
            {error && (
              <p role="alert" className="titlepage__error">
                {error}
              </p>
            )}
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <p className="titlepage__alts">
              <button type="button" className="btn btn--plain" onClick={resend} disabled={busy}>
                Send it again
              </button>
              <span aria-hidden="true"> · </span>
              <button type="button" className="btn btn--plain" onClick={startOver} disabled={busy}>
                Use another email
              </button>
            </p>
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
              <p role="alert" className="titlepage__error">
                {error}
              </p>
            )}
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Sending…' : 'Send a sign-in code'}
            </button>
          </form>
        )}

        {/* Last, because it is the strongest sentence on the screen and it answers the
            objection a reader has at exactly this moment. It was buried mid-paragraph. */}
        <p className="titlepage__promise">No subscription, and nothing worth having behind one.</p>
      </div>
    </main>
  );
}
