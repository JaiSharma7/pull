import { useEffect, useState } from 'react';
import { Mark } from '@wap/ui';
import '../styles/auth.css';
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
    <main className="welcome">
      <header className="welcome__masthead">
        <a className="welcome__brand" href="/explore">
          <Mark />
          <span>What a Pull</span>
        </a>
        <span className="meta welcome__edition">A little curiosity. A lasting idea.</span>
      </header>
      <div className="welcome__layout">
        <section className="welcome__story" aria-labelledby="welcome-heading">
          <div className="welcome__hero">
            <p className="meta welcome__eyebrow">For the endlessly curious</p>
            <h1 id="welcome-heading">
              Follow your curiosity.
              <br />
              <em>Keep what matters.</em>
            </h1>
            <p className="welcome__lede">
              Great ideas from books, films, papers and talks. A little reading today. A richer way
              of seeing tomorrow.
            </p>
          </div>
          <article className="welcome__preview" aria-label="An example Pull">
            <div className="welcome__preview-top">
              <span className="meta">Inside a Pull</span>
              <span className="meta">Philosophy · 01</span>
            </div>
            <h2>The obstacle is part of the work.</h2>
            <p>
              An interruption can become material for the task itself. Instead of waiting for the
              path to clear, ask what the difficulty makes possible.
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
          <ol className="welcome__features">
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
        </section>
        <section className="welcome__entry" aria-labelledby="entry-heading">
          <p className="meta welcome__eyebrow">Your reading room awaits</p>
          <h2 id="entry-heading">Something worth keeping.</h2>
          <p className="welcome__intro">
            Sign in to keep ideas, follow your interests, and pick up where you left off.
          </p>
          {redirectError && <p role="alert">{redirectError}</p>}
          <OAuthButtons next={next} />
          <p className="welcome__note">One account. Your ideas, wherever you read.</p>
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
            By continuing, you agree to our <a href="/terms">Terms</a> and{' '}
            <a href="/privacy">Privacy Policy</a>.
          </p>
        </section>
      </div>
      <footer className="welcome__footer">
        <span className="meta">Less scrolling. More understanding.</span>
        <span>Enough for today. Something for tomorrow.</span>
      </footer>
    </main>
  );
}
