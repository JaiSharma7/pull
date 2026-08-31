import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Auth } from './routes/Auth.js';
import { Feed, type FeedStats } from './routes/Feed.js';
import { Library } from './routes/Library.js';
import { Review } from './routes/Review.js';
import { Specimen } from './routes/Specimen.js';
import { supabase } from './lib/supabase.js';

type Tab = 'feed' | 'review' | 'library';

const SECTIONS: { id: Tab; label: string }[] = [
  { id: 'feed', label: 'For You' },
  { id: 'review', label: 'Review' },
  { id: 'library', label: 'Library' },
];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('feed');
  const [stats, setStats] = useState<FeedStats | null>(null);

  useEffect(() => {
    /*
     * `ready` must become true on every path, including the failing ones.
     *
     * supabase-js converts its own AuthErrors into `{ data, error }` but rethrows
     * anything else — a DNS failure, an offline device, a wedged Web Lock inside
     * `_acquireLock`. Without a catch, that rejection left `ready` false forever and
     * the reader sat looking at "Loading…" in 12px grey text: no error, no sign-in
     * form, and no way out but a reload that does the same thing again.
     *
     * Falling through to the sign-in screen is always the better failure. A reader
     * who is actually signed in gets their session back from `onAuthStateChange`
     * moments later; a reader who is not can at least start.
     */
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch((e: unknown) => {
        // Log only. `null` is already the initial state, so assigning it here could
        // never do anything *except* revoke a session `onAuthStateChange` had
        // already delivered — auth-js emits INITIAL_SESSION on its own independent
        // path, and a slow rejection from a lock timeout arriving afterwards would
        // drop a signed-in reader back to the sign-in screen mid-session.
        console.error('Could not restore the session', e);
      })
      .finally(() => setReady(true));

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Design specimen: no auth, no network. Development only.
  if (import.meta.env.DEV && window.location.search.includes('specimen')) {
    return <Specimen />;
  }

  if (!ready)
    return (
      <p className="meta" style={{ padding: 'var(--space-6)' }}>
        Loading…
      </p>
    );
  if (!session) return <Auth />;

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="shell__masthead">
        <span className="shell__wordmark">What a Pull</span>

        {/*
          The sections live in the masthead below 60rem and in the left rail
          above it. Rendering both and hiding one would put two controls with
          the same name in the accessibility tree, so the rail is the only
          copy on wide screens and this one steps aside for it.
        */}
        <nav aria-label="Sections" className="shell__masthead-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="btn btn--plain"
              aria-current={tab === s.id ? 'page' : undefined}
              style={tab === s.id ? { color: 'var(--accent)' } : undefined}
              onClick={() => setTab(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <button
          type="button"
          className="btn btn--plain"
          style={{ marginLeft: 'auto' }}
          onClick={() => void supabase.auth.signOut()}
        >
          Sign out
        </button>
      </header>

      <div className="shell__body">
        <aside className="shell__rail" aria-label="Sections">
          <p className="meta shell__group">Reading</p>
          <nav className="shell__nav">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="btn btn--plain shell__nav-item"
                aria-current={tab === s.id ? 'page' : undefined}
                onClick={() => setTab(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>
        </aside>

        <main id="main" className="shell__main">
          <div className="shell__column">
            {/*
              The feed is hidden rather than unmounted, and that is a correctness
              choice rather than a performance one.

              `readCount`, `recalled` and `savedThisSession` live in `Feed`. Unmounting
              on a tab switch reset all three to zero and the reporting effect then
              pushed those zeros straight into the rail — so reading five ideas, saving
              two, glancing at the Library and coming back showed 0 / 0 / 0. A product
              whose whole claim is an honest account of one sitting had a counter that
              forgot the sitting whenever you looked away from it. `Feed` argues at
              length about never inflating that number; silently zeroing it is the same
              failure pointed the other way.

              It also refetched page 0 on every return, reshuffling the reader's place.

              `hidden` is enough on both counts: a `display: none` subtree has no
              layout, so IntersectionObserver reports nothing intersecting and no card
              can be counted as read while the reader is elsewhere. It is also removed
              from the accessibility tree, so the hidden feed is not reachable by a
              screen reader or by tabbing.
            */}
            <div hidden={tab !== 'feed'}>
              <Feed userId={session.user.id} onStats={setStats} />
            </div>
            {tab === 'review' && <Review />}
            {tab === 'library' && <Library userId={session.user.id} />}
          </div>
        </main>

        <aside className="shell__aside" aria-label="This session">
          <div className="shell__group">
            <p className="meta">This session</p>
            <div className="shell__stat">
              <span>Ideas met</span>
              <span className="shell__stat-value">{stats?.read ?? 0}</span>
            </div>
            <div className="shell__stat">
              <span>Saved</span>
              <span className="shell__stat-value">{stats?.saved ?? 0}</span>
            </div>
            <div className="shell__stat">
              <span>Recalled</span>
              <span className="shell__stat-value">{stats?.recalled ?? 0}</span>
            </div>
          </div>

          {/*
            Time saved rather than time spent, in the one accent colour — it is
            the number the product is optimising for, and putting it here keeps
            it in view during a session instead of only at the end of one.
          */}
          <div className="shell__group">
            <p className="meta">The Delta</p>
            <div className="shell__stat">
              <span>Already knew</span>
              <span className="shell__stat-value">{stats?.skippedKnown ?? 0}</span>
            </div>
            <div className="shell__stat">
              <span>Time saved</span>
              <span className="shell__stat-value shell__stat-value--accent">
                {stats ? `${stats.minutesSaved} min` : '—'}
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
