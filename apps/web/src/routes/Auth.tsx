import { useEffect, useRef, useState } from 'react';
import { CodeInput } from '../components/CodeInput.js';
import { isDisposableEmail } from '../lib/email-domain.js';
import { parseSignInLink } from '../lib/sign-in-link.js';
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

/**
 * The code and address a one-click email link carries.
 *
 * The email's primary action is `{{ .SiteURL }}/?code={{ .Token }}&email={{ .Email }}`,
 * which exists because mail clients run no JavaScript: there is no way to put a copy
 * button in an email, so the next best thing is a link that means the reader never has
 * to copy anything.
 *
 * **Both parts are required**, and that is why the address rides along. `verifyOtp`
 * takes `{ email, token }` — a code alone cannot complete a sign-in, and the tab the
 * link opens is very often not the tab that started it (a phone opening mail in one
 * browser and the link in another). Without the address, a link opened anywhere else
 * would prefill a code into an empty form and stall on the one field the reader would
 * then have to remember.
 *
 * Read once and cleared from the address bar immediately: a sign-in code in browser
 * history is a credential in browser history, and it is single-use besides, so leaving
 * it there could only ever mislead a reader into retrying something spent.
 */
function readPrefill(): { code: string; email: string } | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code')?.trim();
  const email = params.get('email')?.trim();
  if (!code) return null;

  history.replaceState(null, '', window.location.pathname);
  return { code, email: email ?? '' };
}

export function Auth({ onNavigate }: { onNavigate: (to: string) => void }) {
  // Read during the first render, because reading consumes the query string.
  const [prefill] = useState(readPrefill);
  const [email, setEmail] = useState(prefill?.email ?? '');
  const [code, setCode] = useState(prefill?.code ?? '');
  /* A link that carried a code lands straight on the code step rather than the form. */
  const [sent, setSent] = useState(prefill !== null);
  // Read once, during the first render, because it consumes the hash as it reads.
  const [error, setError] = useState<string | null>(readRedirectError);
  const [busy, setBusy] = useState(false);
  /** Whatever the reader pasted, before it has been worked out. See `usePastedLink`. */
  const [pasted, setPasted] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  /** So a complete code can submit the form without the reader reaching for the button. */
  const formRef = useRef<HTMLFormElement>(null);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();

    /*
     * Refused before the request, not after.
     *
     * Supabase's built-in SMTP is rate-limited **per hour and counts every request**,
     * not every delivery — so the send budget is shared between real readers and
     * anyone pointing a script at this form. A few dozen throwaway addresses exhaust
     * the hour and the next genuine reader is told to wait, with no way to shorten it.
     * Stopping here costs nothing and spends none of it.
     *
     * The browser is not where this is enforced — a script hitting the Auth endpoint
     * never runs this line. The `BEFORE INSERT` trigger on `auth.users` is the block
     * that cannot be routed around; this is the half that protects the budget and
     * answers the person immediately.
     */
    if (isDisposableEmail(email)) {
      setError(
        'That looks like a disposable address. Use one you can actually receive mail at — ' +
          'we ask for an email and nothing else, and this is the only thing we use it for.',
      );
      return;
    }

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

  /*
   * A link that carried both halves signs in with no further click.
   *
   * Submitted through the form rather than by calling the verify path directly, so it
   * takes exactly the same route — and the same error handling — as a code typed by
   * hand. A second way into `verifyOtp` would be a second place for its failures to be
   * handled differently.
   */
  useEffect(() => {
    if (prefill?.code && prefill.email) formRef.current?.requestSubmit();
  }, [prefill]);

  /*
   * The escape hatch for a sign-in that worked and still left the reader outside.
   *
   * **Site URL is hosted configuration this repository cannot push**, and when it is
   * wrong GoTrue verifies the link, mints a real session, and 303s it to an address that
   * does not serve this app. The auth log records `action: login`; the reader gets a
   * page that will not load. Nothing throws, so nothing here can catch it — the only
   * evidence is in the address bar of the page they are staring at.
   *
   * So the address bar is the input. `parseSignInLink` works out which of the several
   * things a reader might be holding they actually pasted, and each kind is spent the
   * way that kind has to be spent.
   */
  async function usePastedLink(e: React.FormEvent) {
    e.preventDefault();
    const link = parseSignInLink(pasted);

    if (link.kind === 'unrecognised') {
      setError(
        'That does not look like a sign-in link. Paste the whole address, from https:// on.',
      );
      return;
    }
    if (link.kind === 'error') {
      setError(link.message);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Each branch reports its own `error`; supabase-js only throws for transport.
      const { error } =
        link.kind === 'session'
          ? await supabase.auth.setSession({
              access_token: link.accessToken,
              refresh_token: link.refreshToken,
            })
          : // Exchanges the refresh half for a whole new session. The one route in that
            // needs no email at all, which is what makes it the answer when the mail
            // itself — a spent SMTP rate limit, a swallowed message — is the problem.
            link.kind === 'refresh'
            ? await supabase.auth.refreshSession({ refresh_token: link.refreshToken })
            : link.kind === 'token-hash'
              ? await supabase.auth.verifyOtp({
                  token_hash: link.tokenHash,
                  // Narrowed at the boundary: the type rides in from a URL, and an
                  // unrecognised one is a value TypeScript would accept and GoTrue reject.
                  type: link.type === 'signup' ? 'signup' : 'magiclink',
                })
              : await supabase.auth.verifyOtp({
                  email: link.email ?? email,
                  token: link.code,
                  type: 'email',
                });
      if (error) setError(error.message);
      // On success App.tsx's auth listener swaps this screen out; nothing to do here.
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
  function go(to: string) {
    return (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      onNavigate(to);
    };
  }

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
              <span aria-hidden="true"> · </span>
              <button
                type="button"
                className="btn btn--plain"
                aria-expanded={showPaste}
                onClick={() => setShowPaste((v) => !v)}
                disabled={busy}
              >
                No code in the email?
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

        {/*
          A sibling of the code form, never a child of it: nested forms are invalid
          HTML and the inner one silently loses its own submit handler.
        */}
        {sent && showPaste && (
          <form onSubmit={usePastedLink} className="stack">
            <hr className="rule" />
            <label className="field">
              <span className="field__label">Paste the sign-in link</span>
              <textarea
                className="field__input"
                rows={3}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                aria-describedby="paste-help"
                placeholder="https://…"
              />
            </label>
            <p className="meta" id="paste-help">
              Two things work here. Copy the link out of the email without opening it — or, if you
              already clicked it and landed on a page that would not load, copy that page&rsquo;s
              whole address out of the address bar. The sign-in is inside it either way.
            </p>
            <button type="submit" className="btn btn--primary" disabled={busy || !pasted.trim()}>
              {busy ? 'Checking…' : 'Sign in with that'}
            </button>
          </form>
        )}

        {/*
          On this screen rather than a footer somewhere, because this is the
          screen where an email address changes hands. Both documents are
          readable without an account — they render ahead of this gate — so the
          notice links to something a reader can actually check before agreeing
          to it rather than after.
        */}
        <p className="titlepage__legal">
          Signing in accepts our{' '}
          <a href="/terms" onClick={go('/terms')}>
            Terms
          </a>{' '}
          and{' '}
          <a href="/privacy" onClick={go('/privacy')}>
            Privacy Policy
          </a>
          . We ask for an email address and nothing else.
        </p>

        {/* Last, because it is the strongest sentence on the screen and it answers the
            objection a reader has at exactly this moment. It was buried mid-paragraph. */}
        <p className="titlepage__promise">No subscription, and nothing worth having behind one.</p>
      </div>
    </main>
  );
}
