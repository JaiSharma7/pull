import { useEffect, useRef, useState } from 'react';
import { CodeInput } from '../components/CodeInput.js';
import {
  isAnonymousSignInDisabled,
  isCaptchaRequired,
  isEmailRateLimited,
  isProviderDisabled,
} from '../lib/auth-errors.js';
import { isDisposableEmail } from '../lib/email-domain.js';
import { OAUTH_ROUTES, type OAuthRoute, signInRedirectTo } from '../lib/oauth.js';
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
  /*
   * Both halves, because two different failures land in two different places.
   *
   * A rejected magic link comes back on the fragment: implicit flow puts everything
   * after the `#`. A provider that refuses — a reader who pressed Cancel on Google's
   * consent screen, an app registration whose redirect URI does not match — comes back
   * on the query string, because that half is the OAuth 2 error response and has
   * nothing to do with which flow the client is on. Reading only the fragment left a
   * cancelled provider sign-in as a silent no-op: the reader lands back on the sign-in
   * screen with `?error=access_denied` in the address bar and no explanation on it.
   */
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  const inHash = hash.get('error') !== null || hash.get('error_code') !== null;
  const params = inHash ? hash : query;
  const code = params.get('error_code');
  const description = params.get('error_description');
  const kind = params.get('error');
  if (!code && !description && !kind) return null;

  /*
   * Cleared so a reload does not resurrect an error the reader has already read, and
   * so the parameters do not sit in the address bar looking like a crash. The query
   * string keeps everything that is not part of the failure — `?next=` rides on it,
   * and a reader who was sent here to keep an idea must still land on that idea.
   */
  for (const key of ['error', 'error_code', 'error_description', 'error_uri']) {
    query.delete(key);
  }
  const rest = query.toString();
  history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));

  if (code === 'otp_expired') {
    return 'That sign-in link has expired or was already used. Enter your email and we will send a fresh one.';
  }
  /*
   * A cancelled provider sign-in is not a failure and must not be reported as one.
   * `access_denied` is what comes back when somebody presses Cancel on a consent
   * screen, which is a decision rather than a fault — and GoTrue's own
   * `error_description` for it ("The user has denied your application access") is
   * written to the developer rather than to the person who made the decision.
   */
  if (kind === 'access_denied' && !inHash) {
    return 'That sign-in was cancelled. Nothing was shared, and you can pick a different way in.';
  }
  // `error_description` arrives URL-encoded with `+` for spaces.
  if (description) return description.replace(/\+/g, ' ');
  return inHash
    ? 'That sign-in link did not work. Send yourself a new one.'
    : 'That sign-in did not complete. Try again, or pick a different way in.';
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
  /*
   * Digits only, and the reason is a collision rather than tidiness.
   *
   * `?code=` is also what an OAuth redirect comes back with under the PKCE flow, where
   * it is an opaque authorisation code that supabase-js exchanges for a session. This
   * runs during the first render and CLEARS THE QUERY STRING as it reads, so a loose
   * match here would take that code away from `detectSessionInUrl`, prefill it into the
   * six-digit boxes, and leave a reader who signed in successfully looking at a form
   * asking for a code that was never emailed to them.
   *
   * The client is on the implicit flow today (`createBrowserClient` sets no `flowType`,
   * and auth-js defaults to implicit), so the tokens come back in the fragment and the
   * collision does not happen. That is a default in a dependency, not a decision this
   * repository has written down anywhere — which makes it exactly the kind of thing a
   * future upgrade changes underneath us. `{{ .Token }}` is six digits; nothing that is
   * not digits was ever this app's own link.
   */
  if (!code || !/^\d{4,10}$/.test(code)) return null;

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

/*
 * Said once, because CAPTCHA closes both routes and the two handlers below would
 * otherwise print two different accounts of the same single cause.
 *
 * Two audiences, two channels, the same split `isAnonymousSignInDisabled` already makes:
 * the operator's half names the switch and goes to the console where an operator looks,
 * and the reader is told the one thing that is true for them -- that this is not theirs
 * to fix and there is no other route to try. Every other failure on this screen leaves
 * the reader something to do; this is the one that does not, so it must not imply
 * otherwise.
 */
const CAPTCHA_OPERATOR_WARNING =
  'This Supabase project has CAPTCHA protection switched on, and this app sends no ' +
  'captcha token -- so every sign-in is rejected, the email route and the guest button ' +
  'alike. Turn it off under Settings -> Authentication -> Bot and Abuse Protection -> ' +
  'Enable CAPTCHA protection, or add a captcha widget and pass options.captchaToken on ' +
  'both signInWithOtp and signInAnonymously. Enabling anonymous sign-ins is what usually ' +
  'brings this on: the dashboard recommends CAPTCHA in the same breath.';

/**
 * Which way in is currently working.
 *
 * `verify` covers both routes into `verifyOtp` — a typed code and a link that carried
 * one — because they are the same act and want the same label. The two provider values
 * are the provider's own name, so a screen with five ways in needs no fifth boolean.
 */
type Pending = 'email' | 'verify' | 'guest' | 'paste' | OAuthRoute['provider'];

const CAPTCHA_READER_MESSAGE =
  'Sign-in is misconfigured for this deployment, so neither the email route nor the ' +
  'guest button can complete. That is on us rather than on you, and trying again will ' +
  'not help until it is fixed.';

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
  const [pending, setPending] = useState<Pending | null>(urlToken !== null ? 'verify' : null);
  /*
   * Every control on the screen is disabled while any one of them is working — one at
   * a time is right — but only the one that is working may say so. This started as a
   * boolean and a second boolean beside it naming the guest button, which held for two
   * routes and stopped at four: `busy && !openingGuest && !openingProvider` is a
   * label condition nobody can read, and it gets one term longer every time a way in
   * is added.
   */
  const busy = pending !== null;
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
  /*
   * A provider's refusal, kept out of `error` for the reason `guestError` is.
   *
   * `error` renders inside whichever form is on screen. A provider failure shown there
   * would sit under the email field — a control the reader never touched — and read as
   * "the email send failed", which is the exact misreading that gave the guest button
   * its own slot. This one has a second reason besides: the email form is closed by
   * default now, so `error` frequently has nowhere on screen to render at all.
   */
  const [providerError, setProviderError] = useState<string | null>(null);
  /**
   * Whether the email route is on screen.
   *
   * Closed by default, and that is the whole point of this round: the email code is a
   * fallback rather than the front door, because the sender behind it is rate-limited
   * per hour and counts requests rather than deliveries. Opened by a reader who wants
   * it, and opened for them when a provider turns out not to be configured — a shut
   * door and a hidden alternative is not a route, it is a dead end.
   */
  const [emailOpen, setEmailOpen] = useState(false);
  /** Whatever the reader pasted, before it has been worked out. See `usePastedLink`. */
  const [pasted, setPasted] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  /** So a complete code can submit the form without the reader reaching for the button. */
  const formRef = useRef<HTMLFormElement>(null);
  /** So opening the email panel puts the caret in it. See the effect below. */
  const emailRef = useRef<HTMLInputElement>(null);

  /*
   * Where a completed sign-in should land, which is not always the front page.
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
   * One address for all three routes rather than one per route, because the hosted
   * redirect allow-list is a list somebody maintains by hand: every shape added here
   * is another line that has to be added there before sign-in works, and a missing
   * one fails by landing the reader on the Site URL with a session and no explanation.
   *
   * For the email route it is only used if the email carries a link rather than a
   * code. For a provider it is where the reader comes back to, and it is not optional.
   */
  const redirectTo = signInRedirectTo(window.location.origin, next);

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

    setPending('email');
    setError(null);
    setGuestError(null);
    setProviderError(null);
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
        options: { emailRedirectTo: redirectTo },
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
        if (isCaptchaRequired(error)) {
          console.warn(CAPTCHA_OPERATOR_WARNING);
          setError(CAPTCHA_READER_MESSAGE);
        } else if (isEmailRateLimited(error)) {
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
      setPending(null);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setPending('verify');
    setError(null);
    setGuestError(null);
    setProviderError(null);
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
      setPending(null);
    }
  }

  /*
   * Opening the email panel puts the caret in it.
   *
   * Opening it IS the decision to use it: a disclosure that reveals a field and then
   * asks for a second click into it has spent the reader's press on nothing. Done here
   * rather than with `autoFocus` because that prop moves focus on first paint too, which
   * is the thing `jsx-a11y/no-autofocus` is right about — this fires only when a reader
   * has just pressed the control that reveals the field.
   */
  useEffect(() => {
    if (emailOpen) emailRef.current?.focus();
  }, [emailOpen]);

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
        if (!cancelled) setPending(null);
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

    setPending('paste');
    setError(null);
    setGuestError(null);
    setProviderError(null);
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
      setPending(null);
    }
  }

  /*
   * The way in that needs no mailbox, and the one this screen now leads with.
   *
   * An email code is only as good as the sender behind it: Supabase's built-in SMTP is
   * rate-limited per hour and counts requests rather than deliveries, so a handful of
   * sign-ups — or one script — spends the budget and the next real reader is told to
   * wait. A provider has none of that shape. The credential is one the reader already
   * holds, delivery is somebody else's problem, and a bot has to get past Google or
   * Microsoft before it reaches us.
   *
   * Nothing to await on the success path: `signInWithOAuth` navigates this tab to the
   * provider, so the next thing that happens is a page load somewhere else. `pending`
   * is therefore left standing rather than cleared — the buttons must not flash back
   * to life during a redirect that is already under way.
   */
  async function continueWith(route: OAuthRoute) {
    setPending(route.provider);
    setError(null);
    setGuestError(null);
    setProviderError(null);
    try {
      // Before the request, for the same reason as the email route: if it fails the
      // reader stays put, and the stored value is spent or replaced either way.
      rememberDestination(next);
      const { error } = await supabase.auth.signInWithOAuth({
        provider: route.provider,
        options: { redirectTo, scopes: route.scopes },
      });
      if (!error) return;

      setPending(null);
      if (isCaptchaRequired(error)) {
        console.warn(CAPTCHA_OPERATOR_WARNING);
        setProviderError(CAPTCHA_READER_MESSAGE);
      } else if (isProviderDisabled(error)) {
        /*
         * Two audiences again, the same split as the guest button. A client id and
         * secret are server-side configuration by definition (law 7), so this
         * repository cannot push them and `supabase/config.toml` reaches only the
         * local stack. Whoever runs the deployment needs the name of the screen; the
         * reader needs to know which door is still open.
         */
        console.warn(
          `${route.dashboardName} sign-in is not configured for this Supabase project. ` +
            'Add the client id and secret under Authentication → Sign In / Providers, ' +
            'and add this origin to the redirect allow-list; supabase/config.toml only ' +
            'configures the local stack. See docs/auth.md.',
        );
        // Opened rather than merely mentioned: the route this sends them to is the
        // one collapsed behind a disclosure, and telling somebody to use a control
        // that is not on screen is telling them to go and find it.
        setEmailOpen(true);
        setProviderError(
          `${route.dashboardName.replace(/ \(.*\)$/, '')} sign-in is not switched on for ` +
            'this deployment yet. Use an email code instead, or look around as a guest.',
        );
      } else setProviderError(error.message);
    } catch (e) {
      setPending(null);
      setProviderError(
        e instanceof Error ? e.message : 'Could not reach the server. Check your connection.',
      );
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
    setPending('guest');
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
    setProviderError(null);
    try {
      // Same try/finally reasoning as `requestCode`: supabase-js rethrows anything that
      // is not an AuthError, and a bare await would leave the button disabled for ever.
      const { error } = await supabase.auth.signInAnonymously();
      if (error) {
        if (isCaptchaRequired(error)) {
          // Ahead of the disabled check: with CAPTCHA on, the guest button fails for a
          // reason that has nothing to do with whether anonymous sign-ins are enabled,
          // and "use the email route above" would be advice to a door that is also shut.
          console.warn(CAPTCHA_OPERATOR_WARNING);
          setGuestError(CAPTCHA_READER_MESSAGE);
        } else if (isAnonymousSignInDisabled(error)) {
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
      setPending(null);
    }
  }

  function startOver() {
    setSent(false);
    setCode('');
    setError(null);
    setGuestError(null);
    setProviderError(null);
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
    setPending('email');
    setError(null);
    setGuestError(null);
    setProviderError(null);
    setCode('');
    try {
      // Before the request, not after: if it fails the reader stays put and the
      // stored value is spent or replaced by the next attempt either way.
      rememberDestination(next);
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo },
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
      setPending(null);
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
              {pending === 'verify' ? 'Checking…' : 'Sign in'}
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
          <>
            {/*
              The two ways in that need no mailbox, and the front door as of this round.
              Both plain, both the same width, in the order they are declared: this is
              two equivalent offers rather than a recommendation and an alternative.
            */}
            <div
              className="stack"
              style={{ '--stack-gap': 'var(--space-2)' } as React.CSSProperties}
            >
              {OAUTH_ROUTES.map((route) => (
                <button
                  key={route.provider}
                  type="button"
                  className="btn titlepage__provider"
                  onClick={() => void continueWith(route)}
                  disabled={busy}
                >
                  {pending === route.provider ? 'Opening…' : route.label}
                </button>
              ))}
              {providerError && (
                <p role="alert" className="titlepage__error">
                  {providerError}
                </p>
              )}
            </div>

            {emailOpen ? (
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
                    ref={emailRef}
                  />
                </label>
                {error && (
                  <p role="alert" className="titlepage__error">
                    {error}
                  </p>
                )}
                <button type="submit" className="btn btn--primary" disabled={busy}>
                  {pending === 'email' ? 'Sending…' : 'Send a sign-in code'}
                </button>
              </form>
            ) : (
              <p className="titlepage__alts">
                {/*
                  No `aria-expanded`, deliberately, and the paste hatch below does carry
                  one. That control persists and toggles; this one is replaced by the
                  field it reveals, so it would announce "collapsed" for its whole life
                  and never once say otherwise.
                */}
                <button
                  type="button"
                  className="btn btn--plain"
                  onClick={() => setEmailOpen(true)}
                  disabled={busy}
                >
                  Or sign in with an email code
                </button>
              </p>
            )}
          </>
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
            {pending === 'guest' ? 'Opening…' : 'Look around as a guest'}
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
            No email needed. A guest session works like a private window: it ends when you close
            this tab, it cannot be recovered on another device, it does not carry over when you sign
            in, and the account behind it is deleted a day after you last use it.
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
              {pending === 'paste' ? 'Checking…' : 'Sign in with that'}
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
          . We ask for an email address and nothing else. Google and Microsoft also hand us the
          profile they hold for you — your name, and usually a link to your picture; the name is
          offered back as a suggested username and nothing else is used. As a guest, nothing at all.
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
