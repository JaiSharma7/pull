import { useEffect, useRef, useState } from 'react';
import { CodeInput } from '../components/CodeInput.js';
import { isAnonymousSignInDisabled, isEmailRateLimited } from '../lib/auth-errors.js';
import { isDisposableEmail } from '../lib/email-domain.js';
import { parseSignInLink } from '../lib/sign-in-link.js';
import { rememberDestination } from '../lib/pending-destination.js';
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

/**
 * A `token_hash` link, verified here rather than by GoTrue.
 *
 * This is the shape that makes sign-in work for people who are not the owner. A
 * `{{ .ConfirmationURL }}` link goes to GoTrue's `/verify`, which mints the session
 * and then **redirects it to the project's Site URL** — hosted configuration this
 * repository cannot set, and wrong, so every successful sign-in landed on a dead page.
 *
 * `{{ .TokenHash }}` lets the email point straight at this app instead. No redirect
 * happens, so Site URL never enters into it, and the session is created in the tab the
 * reader already has open. It is also immune to the redirect allow-list, which is the
 * other hosted setting that silently breaks sign-in on a new deployment.
 *
 * Read from the query string only. The fragment belongs to supabase-js, whose
 * `detectSessionInUrl` consumes `#access_token` at module load — racing it here would
 * mean two things trying to spend one credential.
 *
 * Cleared from the address bar as it is read: a single-use token in browser history is
 * a credential in browser history, and re-visiting it could only ever fail.
 */
function readUrlToken(): { tokenHash: string; type: 'signup' | 'magiclink' } | null {
  const params = new URLSearchParams(window.location.search);
  const tokenHash = params.get('token_hash')?.trim();
  if (!tokenHash) return null;

  const raw = params.get('type');
  history.replaceState(null, '', window.location.pathname);
  // Narrowed at the boundary: the value arrives from a URL, and an unrecognised one is
  // something TypeScript would accept and GoTrue would reject.
  return { tokenHash, type: raw === 'signup' ? 'signup' : 'magiclink' };
}

export function Auth({
  onNavigate,
  next = null,
}: {
  onNavigate: (to: string) => void;
  /**
   * Where the reader was before they were asked for an address, if anywhere.
   *
   * A visitor who pressed "Sign in to keep these" on a shared idea came here to
   * keep *that* idea. `App` reads it from the query string and spends it once a
   * session exists; this screen's only job with it is to make sure the email
   * comes back to the same place.
   */
  next?: string | null;
}) {
  // Read during the first render, because reading consumes the query string.
  const [prefill] = useState(readPrefill);
  const [urlToken] = useState(readUrlToken);
  const [email, setEmail] = useState(prefill?.email ?? '');
  const [code, setCode] = useState(prefill?.code ?? '');
  /* A link that carried a code lands straight on the code step rather than the form. */
  const [sent, setSent] = useState(prefill !== null);
  // Read once, during the first render, because it consumes the hash as it reads.
  const [error, setError] = useState<string | null>(readRedirectError);
  /*
   * Busy from the first paint when a link is being verified, not a tick later.
   *
   * Seeding this rather than setting it inside the effect avoids a cascading render,
   * and is also what the reader should see: arriving on a `token_hash` link, the very
   * first frame is already working on it rather than showing an empty form that is
   * about to be replaced.
   */
  const [busy, setBusy] = useState(urlToken !== null);
  /*
   * Which action `busy` is currently for.
   *
   * `busy` disables every control on the screen, which is right — one of these at a
   * time — but it cannot say which one is working, and "Sending…" on the email button
   * while a guest session is being minted describes something that is not happening.
   */
  const [openingGuest, setOpeningGuest] = useState(false);
  /*
   * The guest failure, kept out of `error`.
   *
   * `error` renders inside whichever form is on screen — above the email field on step
   * one, above the code boxes on step two. A guest failure shown there appears roughly
   * a primary button's height above the control that caused it and directly under one
   * the reader never touched, which reads as "the email send failed". Announced the
   * same way; it is only sighted readers who are misled, which is why it survived the
   * first draft.
   */
  const [guestError, setGuestError] = useState<string | null>(null);
  /** Whatever the reader pasted, before it has been worked out. See `usePastedLink`. */
  const [pasted, setPasted] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  /** So a complete code can submit the form without the reader reaching for the button. */
  const formRef = useRef<HTMLFormElement>(null);

  /*
   * Where the email should land, which is not always the front page.
   *
   * `window.location.origin` on its own discarded the destination: a reader who
   * followed a shared link, pressed "Sign in to keep these" and completed the
   * round trip arrived at the title page, having agreed to sign in *to keep that
   * idea*. The destination goes back as `/?next=…` rather than as the address
   * itself for two reasons — one redirect shape to allow-list rather than one
   * per source, and the fragment survives: GoTrue appends its own
   * `#access_token=…`, which would overwrite the `#p-<pullId>` anchor naming the
   * idea. `App` spends it once the session exists.
   *
   * Only used if the email carries a link rather than a code, and if the hosted
   * redirect allow-list accepts it. Where it does not, GoTrue falls back to the
   * Site URL — which is where this used to land every reader anyway.
   */
  const emailRedirectTo = next
    ? `${window.location.origin}/?next=${encodeURIComponent(next)}`
    : window.location.origin;

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
    setGuestError(null);
    // try/finally, not try/catch-then-reset: supabase-js converts its own AuthErrors
    // into `{ error }` but rethrows anything else — a DNS failure, an offline device,
    // a wedged Web Lock. Resetting `busy` after a bare await therefore left the button
    // reading "Sending…" forever, disabled, with no message and no way forward but a
    // reload that also discards the address they just typed.
    try {
      // Before the request, not after: if it fails the reader stays put and the
      // stored value is spent or replaced by the next attempt either way.
      rememberDestination(next);
      const { error } = await supabase.auth.signInWithOtp({
        email,
        // Only used if the email carries a link rather than a code. Harmless otherwise.
        options: { emailRedirectTo },
      });
      if (error) {
        /*
         * The dead end this exists to remove.
         *
         * A rate-limited send left the reader on a screen whose only action was the
         * one that caused it, with the route that needs no email collapsed behind a
         * link they had no reason to open. Measured on 2026-08-31: the owner was
         * locked out of their own product for two hours, retrying, while a valid
         * session sat one unopened panel away — and each retry pushed the window out.
         *
         * So the panel opens itself, and the message names the way through rather
         * than only the problem. This is the one failure where "try again" is the
         * wrong advice, so it is the one failure that must not offer it.
         */
        if (isEmailRateLimited(error)) {
          setShowPaste(true);
          setError(
            'Too many sign-in emails have been requested, so the next one will not arrive ' +
              'for a while — asking again makes the wait longer. If you already have a link ' +
              'or a code from an earlier email, paste it below and it will still work.',
          );
        } else {
          setError(error.message);
        }
      } else setSent(true);
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
    setGuestError(null);
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
   * A clicked email link completes on arrival, with nothing to press.
   *
   * The reader has already proved they hold the mailbox; asking them to confirm that
   * again on this screen would be ceremony. On success `App`'s auth listener swaps the
   * screen out, so there is nothing to do with the result here beyond reporting a
   * failure — an expired or already-spent link has to say so rather than silently
   * leaving an empty form.
   */
  useEffect(() => {
    if (!urlToken) return;
    let cancelled = false;
    supabase.auth
      .verifyOtp({ token_hash: urlToken.tokenHash, type: urlToken.type })
      .then(({ error }) => {
        if (cancelled || !error) return;
        setError(error.message);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not reach the server.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [urlToken]);

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
    /*
     * `verifyOtp` takes `{ email, token }` — a code alone cannot complete a sign-in.
     * That was unreachable while this form lived behind the code step, because getting
     * there meant an address had already been entered. Now that it opens on the first
     * screen, a reader can paste a code into an empty form, and the resulting
     * "Token has expired or is invalid" would blame the code for a missing address.
     */
    if (link.kind === 'code' && !(link.email ?? email).trim()) {
      setError('Enter the email address you asked for that code with, then try again.');
      return;
    }

    setBusy(true);
    setError(null);
    setGuestError(null);
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

  /*
   * The way in that asks for nothing.
   *
   * Everything this product does for a reader is a row keyed to a user — the onboarding
   * picker, the feed, the Delta, the tally in the rail. There is no version of any of
   * it to show somebody who has not signed in, so the screen in front of a stranger was
   * asking them to hand over an address for something they had not been shown. A guest
   * session is a real `auth.users` row, so all of it simply works, and nothing else in
   * the app needs to know.
   *
   * What it is not is an account. The session lives in this browser's storage and
   * nothing can restore it — there is no address to send a code to — so the copy beside
   * this button says that rather than implying otherwise, and `App` marks the shell
   * "Guest" for as long as it lasts.
   *
   * Guests are bounded in the database rather than here: no generation (law 2 — an
   * anonymous session is free to recreate, so a per-requester quota bounds nothing), no
   * authored summaries, no reports. See 20260901190000. A bound that lived in this
   * component would be a bound on the button, not on the session.
   */
  async function continueAsGuest() {
    setBusy(true);
    setOpeningGuest(true);
    /*
     * Both slots, in both directions.
     *
     * Every action on this screen clears every message, because two of them on screen at
     * once contradict each other. The live case is not hypothetical: on a project where
     * anonymous sign-ins are off, a reader presses this, is told "use the email route
     * above", does exactly that, hits the SMTP rate limit — and would otherwise be
     * looking at one alert saying use the email route and another saying it is closed.
     */
    setGuestError(null);
    setError(null);
    try {
      // Same try/finally reasoning as `requestCode`: supabase-js rethrows anything that
      // is not an AuthError, and a bare await would leave the button disabled for ever.
      const { error } = await supabase.auth.signInAnonymously();
      if (error) {
        if (isAnonymousSignInDisabled(error)) {
          /*
           * Two audiences, two channels, and they want opposite things.
           *
           * Whoever runs the deployment needs the name of the switch —
           * `enable_anonymous_sign_ins` is hosted configuration this repository cannot
           * push, so "it does not work" is useless to them. A reader needs to know the
           * route is closed and that the other one is open; sending them to a Supabase
           * dashboard menu is sending them somewhere they have no account for.
           *
           * So the operator's half goes to the console, where an operator looks, and
           * the reader is told the thing they can act on.
           */
          console.warn(
            'Anonymous sign-ins are disabled for this Supabase project, so the guest ' +
              'button cannot work. Turn them on under Authentication → Sign In / ' +
              'Providers; supabase/config.toml only configures the local stack.',
          );
          setGuestError('Guest sessions are not available here — use the email route above.');
        } else setGuestError(error.message);
      }
      // On success App.tsx's auth listener swaps this screen out; nothing to do here.
    } catch (e) {
      setGuestError(
        e instanceof Error ? e.message : 'Could not reach the server. Check your connection.',
      );
    } finally {
      setBusy(false);
      setOpeningGuest(false);
    }
  }

  function startOver() {
    setSent(false);
    setCode('');
    setError(null);
    setGuestError(null);
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
    setGuestError(null);
    setCode('');
    try {
      // Before the request, not after: if it fails the reader stays put and the
      // stored value is spent or replaced by the next attempt either way.
      rememberDestination(next);
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo },
      });
      if (error && isEmailRateLimited(error)) {
        // Same reasoning as `requestCode`: this is the button that caused the problem.
        setShowPaste(true);
        setError(
          'Too many sign-in emails have been requested. Asking again makes the wait ' +
            'longer — paste an earlier link or code below instead.',
        );
      } else {
        setError(error ? error.message : 'Sent. Check your email again.');
      }
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
              {busy && !openingGuest ? 'Checking…' : 'Sign in'}
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
              {busy && !openingGuest ? 'Sending…' : 'Send a sign-in code'}
            </button>
          </form>
        )}

        {/*
         * Directly under the primary action, because it is the alternative to it.
         *
         * Not down beside the paste hatch: that is an escape from a sign-in that went
         * wrong, and this is a different offer entirely — the one for someone who has
         * not decided to sign in at all. Put below the fold of secondary controls it
         * would be found by the people who were going to sign in anyway.
         *
         * On both steps, for the same reason the paste hatch is: `sent` becomes true
         * only after a send succeeds, so anything conditioned on it disappears exactly
         * when the email route is the thing that failed.
         *
         * The sentence under it is not decoration. A guest session cannot be restored —
         * there is no address to send a code to — and a product that let someone spend
         * an evening stashing ideas without saying so would be lying by omission.
         */}
        {/*
          One group, not three siblings of the stack.

          `.stack` puts the same gap between every child, so a button, its failure and
          its terms as three siblings sit equidistant from each other and from the
          unrelated control below — the sentence then reads as a statement about the
          page rather than as the terms of the button above it.
        */}
        <div
          className="stack titlepage__alts"
          style={{ '--stack-gap': 'var(--space-2)' } as React.CSSProperties}
        >
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => void continueAsGuest()}
            disabled={busy}
          >
            {openingGuest ? 'Opening…' : 'Look around as a guest'}
          </button>
          {guestError && (
            <p role="alert" className="titlepage__error">
              {guestError}
            </p>
          )}
          {/*
            A `p`, not a `span`, and the reason is worth a line because it looked fine in
            the diff. `.stack > * + *` separates children with `margin-block-start`, and a
            vertical margin does nothing at all on a non-replaced inline element — so as a
            span this sentence had no gap above it and shared a line with the button,
            rendering as "LOOK AROUND AS A GUESTNo email needed. A guest session…" on the
            first screen a stranger sees. It only looked right in the one state where
            `guestError` is set, because that block splits the inline run.
          */}
          <p className="titlepage__promise">
            No email needed. A guest session is only reachable from this browser: it cannot be
            recovered on another device, it does not carry over when you sign in, and it is deleted
            after 30 days unused.
          </p>
        </div>

        {/*
         * Reachable from BOTH steps, which is the whole point and was the bug.
         *
         * This started life inside the code step, so it required `sent` — and `sent`
         * only becomes true after `signInWithOtp` *succeeds*. That put the escape hatch
         * behind the door it exists to open: when Supabase's SMTP rate limit fires, the
         * send fails, the code step never renders, and the one route in that needs no
         * email is unreachable. The failure that makes this necessary is precisely the
         * failure that hid it.
         *
         * So it lives outside the branch, and the wording changes rather than the
         * availability.
         */}
        <p className="titlepage__alts">
          <button
            type="button"
            className="btn btn--plain"
            aria-expanded={showPaste}
            onClick={() => setShowPaste((v) => !v)}
            disabled={busy}
          >
            {sent ? 'No code in the email?' : 'Already have a link or code?'}
          </button>
        </p>

        {/*
          A sibling of the forms above, never a child of one: nested forms are invalid
          HTML and the inner one silently loses its own submit handler.
        */}
        {showPaste && (
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
              Anything that carries a sign-in works here. The link from the email, unopened. The
              whole address of a page you landed on that would not load — the sign-in is still
              inside it. Or the six-digit code on its own.
            </p>
            <button type="submit" className="btn btn--primary" disabled={busy || !pasted.trim()}>
              {busy && !openingGuest ? 'Checking…' : 'Sign in with that'}
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
          Signing in — or looking around as a guest — accepts our{' '}
          <a href="/terms" onClick={go('/terms')}>
            Terms
          </a>{' '}
          and{' '}
          <a href="/privacy" onClick={go('/privacy')}>
            Privacy Policy
          </a>
          . We ask for an email address and nothing else; as a guest, nothing at all.
        </p>

        {/* Last, because it is the strongest sentence on the screen and it answers the
            objection a reader has at exactly this moment. It was buried mid-paragraph. */}
        <p className="titlepage__promise">No subscription, and nothing worth having behind one.</p>

        {/*
         * A way in that is not the front door.
         *
         * The library has always been readable without an account — `anon` holds
         * select on every published row — and this screen was the only thing
         * standing in front of it. Asking a stranger to hand over an address
         * before they have seen a single idea is the wrong order, and it is also
         * what every shared link used to run into.
         */}
        <p className="titlepage__promise">
          {/*
            Renamed, because it stopped being the only way in that asks for nothing.
            "Or look around first" and "Look around as a guest" are the same four words
            to a reader scanning a column, and they do different things: this one browses
            the published library signed out, with no user row created at all, and the
            other mints a guest session that carries a feed and an onboarding picker.
            The label now says which is which.
          */}
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => onNavigate('/explore')}
            disabled={busy}
          >
            Or just browse, signed out
          </button>
        </p>
      </div>
    </main>
  );
}
