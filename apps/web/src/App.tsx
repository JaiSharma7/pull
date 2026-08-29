import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Auth } from './routes/Auth.js';
import { Feed } from './routes/Feed.js';
import { Review } from './routes/Review.js';
import { Specimen } from './routes/Specimen.js';
import { supabase } from './lib/supabase.js';

type Tab = 'feed' | 'review';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('feed');

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
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header
        style={{
          borderBottom: '1px solid var(--rule)',
          padding: 'var(--space-4) var(--space-5)',
          display: 'flex',
          gap: 'var(--space-4)',
          alignItems: 'baseline',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--step-1)',
            letterSpacing: '-0.02em',
          }}
        >
          What a Pull
        </span>

        <nav aria-label="Sections" style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {(['feed', 'review'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className="btn btn--plain"
              aria-current={tab === t ? 'page' : undefined}
              style={tab === t ? { color: 'var(--accent)' } : undefined}
              onClick={() => setTab(t)}
            >
              {t === 'feed' ? 'For You' : 'Review'}
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

      <main id="main" style={{ padding: 'var(--space-6) var(--space-5)', maxWidth: '48rem' }}>
        {tab === 'feed' ? <Feed userId={session.user.id} /> : <Review />}
      </main>
    </>
  );
}
