import { lazy, Suspense } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Appearance } from './Appearance.js';
import { Preferences } from './Preferences.js';
import { isGuest } from '../lib/guest.js';
const Account = lazy(() => import('./Account.js').then((m) => ({ default: m.Account })));
/*
 * Lazy for the same two reasons as Account, and the second one is the load-bearing
 * half. Most readers open this panel zero times, so code-splitting it keeps the
 * Supabase write path out of the initial bundle — and an eager import pulls
 * `lib/supabase.ts` into every module that imports Settings, which is what broke
 * `Settings.test.ts`: the client throws at import time without VITE_SUPABASE_URL, so
 * a test that never renders feedback still could not load the file.
 */
const Feedback = lazy(() => import('./Feedback.js').then((m) => ({ default: m.Feedback })));

export function Settings({
  session,
  section,
  onNavigate,
  onPreferencesSaved,
  fromPath,
}: {
  session: Session | null;
  section: string | null;
  onNavigate: (path: string) => void;
  onPreferencesSaved: () => void;
  /**
   * The last screen the reader was on before Settings, for the feedback form to
   * record. Settings itself is never the answer — everyone sending feedback is on
   * Settings by definition, so `window.location.pathname` would store the same
   * constant on every row and tell nobody anything.
   */
  fromPath?: string | null;
}) {
  const current =
    section === 'account' || section === 'reading' || section === 'feedback'
      ? section
      : 'appearance';
  const hasAccount = session !== null && !isGuest(session);
  return (
    <section className="stack settings">
      <h1>Settings</h1>
      <nav className="settings-sections" aria-label="Settings sections">
        {(['appearance', 'reading', 'account', 'feedback'] as const).map((item) => (
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
                : item === 'account'
                  ? 'Account & security'
                  : 'Send feedback'}
          </a>
        ))}
      </nav>
      <hr className="rule" />
      {current === 'appearance' && <Appearance />}
      {current === 'reading' && session && (
        <Preferences
          key={session.user.id}
          userId={session.user.id}
          onDone={() => {
            onPreferencesSaved();
            onNavigate('/settings');
          }}
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
      {current === 'feedback' && session && (
        <Suspense fallback={<p role="status">Loading…</p>}>
          <Feedback key={session.user.id} userId={session.user.id} fromPath={fromPath} />
        </Suspense>
      )}
      {/*
        A guest may send feedback, which is why this gate is `!session` and not
        `!hasAccount` like Account's above. A guest is the reader most likely to hit
        something broken — they are new — and the least able to write in about it,
        having given no address. Refusing them would lose exactly the feedback worth
        most.
      */}
      {((current === 'account' && !hasAccount) ||
        (current === 'reading' && !session) ||
        (current === 'feedback' && !session)) && (
        <div className="stack measure">
          <h2>
            {current === 'account'
              ? 'Account & security'
              : current === 'reading'
                ? 'Reading preferences'
                : 'Send feedback'}
          </h2>
          <p>
            {current === 'feedback'
              ? 'Sign in to send feedback — a guest session is enough, and takes one tap.'
              : 'Sign in with Google or Microsoft to manage these settings.'}
          </p>
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
