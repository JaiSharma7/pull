import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Auth } from './routes/Auth.js';
import { Feed, type FeedStats } from './routes/Feed.js';
import { Review } from './routes/Review.js';
import { Specimen } from './routes/Specimen.js';
import { supabase } from './lib/supabase.js';

type Tab = 'feed' | 'review';

const SECTIONS: { id: Tab; label: string }[] = [
  { id: 'feed', label: 'For You' },
  { id: 'review', label: 'Review' },
];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('feed');
  const [stats, setStats] = useState<FeedStats | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
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
            {tab === 'feed' ? <Feed userId={session.user.id} onStats={setStats} /> : <Review />}
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
