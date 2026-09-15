import { useEffect, useState } from 'react';
import { Mark } from '@wap/ui';
import '../styles/auth.css';
import { OAuthButtons } from '../components/OAuthButtons.js';
import { isAnonymousSignInDisabled, isCaptchaRequired } from '../lib/auth-errors.js';
import { oauthRedirectError } from '../lib/oauth.js';
import { rememberDestination } from '../lib/pending-destination.js';
import { routerClick } from '../lib/routes.js';
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
  /*
   * `header` and `footer` sit OUTSIDE `main`, which is what makes them landmarks at all:
   * `banner` and `contentinfo` are mapped only when the element is not inside `article`,
   * `aside`, `main`, `nav` or `section`. Nested, a screen reader meets one unnamed `main`
   * and no way to move between the parts of a page that is four regions of content.
   * `Legal.tsx` -- this app's other shell-less route -- has the same shape, skip link
   * included, and every in-app link here goes through `routerClick` for the reason that
   * helper gives.
   */
  return (
    <div className="welcome">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="welcome__masthead">
        <a className="welcome__brand" href="/explore" onClick={routerClick(onNavigate, '/explore')}>
          <Mark className="shell__mark" />
          <span className="shell__wordmark">What a Pull</span>
        </a>
        <span className="meta welcome__edition">A little curiosity. A lasting idea.</span>
      </header>
      <main id="main" className="welcome__layout" aria-labelledby="welcome-heading">
        <div className="welcome__hero">
          <p className="meta welcome__eyebrow">For the endlessly curious</p>
          <h1 id="welcome-heading">
            Follow your curiosity.
            <br />
            <em>Keep what matters.</em>
          </h1>
          <p className="welcome__lede">
            Great ideas from books, films, papers and talks. A little reading today. A richer way of
            seeing tomorrow.
          </p>
        </div>
        <section className="welcome__entry" aria-labelledby="entry-heading">
          <p className="meta welcome__eyebrow">Your reading room awaits</p>
          <h2 id="entry-heading">Something worth keeping.</h2>
          <p className="welcome__intro">
            Sign in to keep ideas, follow your interests, and pick up where you left off.
          </p>
          {redirectError && <p role="alert">{redirectError}</p>}
          <OAuthButtons next={next} />
          {/*
            The second sentence is the load-bearing one: there are two providers and no
            third option, and a reader with neither account needs to be told that rather
            than left hunting for a "more options" control that does not exist.
          */}
          <p className="welcome__note">
            One account. Your ideas, wherever you read. Email and password sign-in is unavailable.
          </p>
          <div className="welcome__divider">
            <span>Or take a look first</span>
          </div>
          <button type="button" className="btn" disabled={busy} onClick={() => void openGuest()}>
            {busy ? 'Opening guest reading…' : 'Read as a guest'}
          </button>
          {guestError && (
            <p className="meta" role="alert">
              {guestError}
            </p>
          )}
          <p className="welcome__note">
            Guest reading stays in this browser session. It does not carry over when you sign in.
          </p>
          <button
            type="button"
            className="btn btn--plain welcome__browse"
            onClick={() => onNavigate('/explore')}
          >
            Browse the library
          </button>
          <p className="welcome__terms">
            By continuing, you agree to our{' '}
            <a href="/terms" onClick={routerClick(onNavigate, '/terms')}>
              Terms
            </a>{' '}
            and{' '}
            <a href="/privacy" onClick={routerClick(onNavigate, '/privacy')}>
              Privacy Policy
            </a>
            .
          </p>
        </section>
        <article className="welcome__preview" aria-label="An example Pull">
          <div className="welcome__preview-top">
            <span className="meta">Inside a Pull</span>
            <span className="meta">Philosophy · 01</span>
          </div>
          <h2>The obstacle is part of the work.</h2>
          <p>
            An interruption can become material for the task itself. Instead of waiting for the path
            to clear, ask what the difficulty makes possible.
          </p>
          <footer>
            <span className="meta">
              An idea from Meditations
              <br />
              Marcus Aurelius · Book 5
            </span>
            <span className="welcome__source">Ideas with a source.</span>
          </footer>
        </article>
        {/*
          `role="list"` although an `<ol>` has it implicitly, which is what the lint rule
          below is about. WebKit drops the list role from a list styled `list-style:
          none`, and this one is -- the design numbers the cards itself ("01 / Discover")
          rather than letting the browser do it. Without the explicit role VoiceOver
          announces three loose headings instead of "list, 3 items", and those ordinals
          read as ordinary text. Redundant per the spec; load-bearing in a browser.
        */}
        {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
        <ol className="welcome__features" role="list">
          <li>
            <span className="meta">01 / Discover</span>
            <h3>Find your next idea.</h3>
            <p>Follow your interests across books, films, podcasts and more.</p>
          </li>
          <li>
            <span className="meta">02 / Understand</span>
            <h3>Go beyond the headline.</h3>
            <p>Explore the argument, its context and the original source.</p>
          </li>
          <li>
            <span className="meta">03 / Keep</span>
            <h3>Make it yours.</h3>
            <p>Save the ideas that stay with you. Return whenever curiosity calls.</p>
          </li>
        </ol>
      </main>
      <footer className="welcome__footer">
        <span className="meta">Less scrolling. More understanding.</span>
        <span>Enough for today. Something for tomorrow.</span>
      </footer>
    </div>
  );
}
