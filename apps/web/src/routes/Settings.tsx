import { lazy, Suspense } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Appearance } from './Appearance.js';
import { Preferences } from './Preferences.js';
import { isGuest } from '../lib/guest.js';
const Account = lazy(() => import('./Account.js').then((m) => ({ default: m.Account })));

export function Settings({
  session,
  section,
  onNavigate,
}: {
  session: Session | null;
  section: string | null;
  onNavigate: (path: string) => void;
}) {
  const current = section === 'account' || section === 'reading' ? section : 'appearance';
  const hasAccount = session !== null && !isGuest(session);
  return (
    <section className="stack settings">
      <h1>Settings</h1>
      <nav className="settings-sections" aria-label="Settings sections">
        {(['appearance', 'reading', 'account'] as const).map((item) => (
          <a
            key={item}
            className="btn btn--plain"
            href={`/settings?section=${item}`}
            aria-current={current === item ? 'page' : undefined}
            onClick={(event) => {
              if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
                event.preventDefault();
                onNavigate(`/settings?section=${item}`);
              }
            }}
          >
            {item === 'appearance'
              ? 'Appearance'
              : item === 'reading'
                ? 'Reading preferences'
                : 'Account & security'}
          </a>
        ))}
      </nav>
      <hr className="rule" />
      {current === 'appearance' && <Appearance />}
      {current === 'reading' && session && (
        <Preferences
          key={session.user.id}
          userId={session.user.id}
          onDone={() => onNavigate('/settings')}
        />
      )}
      {current === 'account' && hasAccount && (
        <Suspense fallback={<p role="status">Loading account settings…</p>}>
          <Account
            key={session.user.id}
            userId={session.user.id}
            email={session.user.email ?? null}
          />
        </Suspense>
      )}
      {((current === 'account' && !hasAccount) || (current === 'reading' && !session)) && (
        <div className="stack measure">
          <h2>{current === 'account' ? 'Account & security' : 'Reading preferences'}</h2>
          <p>Sign in with Google or Microsoft to manage these settings.</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() =>
              onNavigate(
                session
                  ? '/account'
                  : `/?next=${encodeURIComponent(`/settings?section=${current}`)}`,
              )
            }
          >
            Sign in
          </button>
        </div>
      )}
    </section>
  );
}
