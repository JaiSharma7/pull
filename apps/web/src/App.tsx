import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Auth } from './routes/Auth.js';
import { Colophon } from './components/Colophon.js';
import { Daily } from './routes/Daily.js';
import { History } from './routes/History.js';
import { Legal, legalDocFor } from './routes/Legal.js';
import { OnboardingGate, Preferences } from './routes/Preferences.js';
import { PullRedirect, Source } from './routes/Source.js';
import { Feed, type FeedStats } from './routes/Feed.js';
import { Library } from './routes/Library.js';
import { Review } from './routes/Review.js';
import { Search } from './routes/Search.js';
import { Specimen } from './routes/Specimen.js';
import {
  applyFocus,
  enterFullscreen,
  exitFullscreen,
  readStoredFocus,
  storeFocus,
} from './lib/focus-mode.js';
import { isPath, queryParam, routeParam } from './lib/routes.js';
import { supabase } from './lib/supabase.js';

type Tab = 'feed' | 'daily' | 'review' | 'library' | 'history' | 'preferences';

const SECTIONS: { id: Tab; label: string }[] = [
  { id: 'feed', label: 'For You' },
  // Second, next to the ranked feed and ahead of the personal sections: it is the one
  // finite, curated thing in the app, and law 3 promises it free forever.
  { id: 'daily', label: 'Daily Pull' },
  { id: 'review', label: 'Review' },
  { id: 'library', label: 'Library' },
  { id: 'history', label: 'History' },
  { id: 'preferences', label: 'Preferences' },
];

/**
 * Places with an address, as opposed to modes the shell is in.
 *
 * Reading stays tab state — a Pull is not a page — but `/search?q=liberty` has to
 * be a thing you can send someone, bookmark, and reload. Kept beside `SECTIONS`
 * rather than folded into it because the two behave differently: choosing a
 * section changes what the shell is showing, choosing a destination changes the
 * URL and every tab steps aside for it.
 */
const DESTINATIONS: { path: string; label: string }[] = [{ path: '/search', label: 'Search' }];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  /*
   * Read once during the first render, not in an effect.
   *
   * An effect would paint the normal scale first and then jump to the focus scale on
   * the next frame — a visible reflow of every line of text on every load, for a
   * reader who has already said which one they want.
   */
  const [focus, setFocus] = useState(readStoredFocus);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('feed');
  const [stats, setStats] = useState<FeedStats | null>(null);
  /*
   * Bumped when a reader saves their preferences, so the feed refetches under the
   * new weights. The feed is kept mounted (see below), so nothing else would make
   * it reconsider — and a preferences screen the feed ignores is precisely the
   * "control that changes nothing" this product cannot afford.
   */
  const [prefsSaved, setPrefsSaved] = useState(0);
  /*
   * The only routed thing in the app.
   *
   * Reading is tab state rather than URLs, deliberately — a Pull is not a page.
   * The legal documents are the exception: a policy has to have an address you
   * can send someone, bookmark, and open without an account. So they get real
   * paths, and this is the smallest thing that gives them one. `vercel.json`
   * rewrites every path to the bundle and the service worker falls back to it,
   * so /privacy resolves on a cold load and offline as well as from a link.
   */
  const [path, setPath] = useState(() => window.location.pathname);

  // The attribute is the single source of truth for the CSS; this keeps it in step.
  useEffect(() => {
    applyFocus(focus, document.documentElement);
  }, [focus]);

  /*
   * Escape leaves fullscreen without asking the app, so the app has to listen.
   *
   * The browser exits fullscreen on Escape unconditionally and there is no way to
   * prevent it. Without this the reader would press Escape, get their tabs back, and
   * still be looking at a page that had hidden its own navigation and thought it was
   * in focus mode — a state nothing in the UI would explain.
   */
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && focus) {
        setFocus(false);
        storeFocus(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [focus]);

  /*
   * Scroll friction belongs to the feed, and only while the feed is what is on screen.
   *
   * Scoped here rather than in `Feed` because the feed stays mounted behind the other
   * tabs — hidden, not unmounted, so the session tallies survive a tab switch. A
   * `data-reading` set on mount would therefore keep snapping the Library and the
   * Colophon, which is friction with nothing behind it.
   *
   * The route check is derived from `path` rather than read from `routeOpen`, which is
   * computed further down after two early returns — a hook below those runs
   * conditionally, which React forbids and the linter catches.
   */
  useEffect(() => {
    const onRoute = routeParam(path, '/source') !== null || routeParam(path, '/pull') !== null;
    const reading = tab === 'feed' && !onRoute;
    const root = document.documentElement;
    if (reading) root.setAttribute('data-reading', 'feed');
    else root.removeAttribute('data-reading');
    return () => root.removeAttribute('data-reading');
  }, [tab, path]);

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

  // Back and forward have to work, or the reader who opened the terms is stuck
  // in them.
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /*
   * Choosing a section leaves any open route.
   *
   * The rail and masthead only set tab state, so from a source page "Library" used
   * to render Source and Library stacked in one column, and "For You" did nothing at
   * all — the feed stays hidden while a route is open. A section is a destination,
   * so selecting one has to return to the app's own path.
   */
  function goToTab(next: Tab) {
    setTab(next);
    if (window.location.pathname !== '/') navigate('/');
  }

  function navigate(to: string) {
    history.pushState(null, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  }

  /*
   * Navigate without leaving a back-stack entry.
   *
   * `/pull/:id` only ever resolves to a source, so pushing it would make Back return
   * to a URL that immediately redirects again — a reader pressing Back twice to leave
   * would go nowhere.
   */
  const replaceWith = useCallback((to: string) => {
    history.replaceState(null, '', to);
    setPath(to);
  }, []);

  // Design specimen: no auth, no network. Development only.
  if (import.meta.env.DEV && window.location.search.includes('specimen')) {
    return <Specimen />;
  }

  /*
   * Ahead of both the loading state and the auth gate, on purpose. Terms you
   * can only reach after accepting them are not terms, and a policy behind a
   * session is not a policy anyone can check before handing over an address.
   */
  const legal = legalDocFor(path);
  if (legal) return <Legal doc={legal} onNavigate={navigate} />;

  const sourceId = routeParam(path, '/source');
  // `?s=<summaryId>`, set by the /pull/:id redirect so the anchor resolves.
  const summaryParam = queryParam(path, 's');
  const pullId = routeParam(path, '/pull');
  /*
   * A route is open, so no tab may render underneath it.
   *
   * `tab` and `path` are two independent pieces of state, and only the feed ever
   * guarded against both being active at once. That was survivable while Review,
   * Library and Preferences had no links into a route — nothing could put them in
   * that position. Daily and History both link to `/pull/:id`, which made the latent
   * bug real: opening a Pull from either rendered `PullRedirect`, and then `Source`,
   * *stacked underneath the whole list they were opened from*.
   *
   * It is the same failure `goToTab` above was written to fix, arriving from the
   * other direction — that one was a section chosen while a route was open, this is
   * a route opened while a section is showing. One guard, applied to every tab, so
   * the next screen added cannot reintroduce it.
   */
  const searchOpen = isPath(path, '/search');
  const searchQuery = queryParam(path, 'q') ?? '';
  const routeOpen = sourceId !== null || pullId !== null || searchOpen;

  if (!ready)
    return (
      <p className="meta" style={{ padding: 'var(--space-6)' }}>
        Loading…
      </p>
    );
  if (!session) return <Auth onNavigate={navigate} />;

  return (
    <OnboardingGate userId={session.user.id}>
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
                aria-current={tab === s.id && !routeOpen ? 'page' : undefined}
                style={tab === s.id && !routeOpen ? { color: 'var(--accent)' } : undefined}
                onClick={() => goToTab(s.id)}
              >
                {s.label}
              </button>
            ))}
            {/*
              A destination is current when its URL is open, and a section is
              current only when no route is. Without the `!routeOpen` above, a
              reader on /search had two elements marked aria-current="page" —
              "For You" and "Search" — which a screen reader reports as two
              current locations in one navigation.
            */}
            {DESTINATIONS.map((d) => (
              <button
                key={d.path}
                type="button"
                className="btn btn--plain"
                aria-current={isPath(path, d.path) ? 'page' : undefined}
                style={isPath(path, d.path) ? { color: 'var(--accent)' } : undefined}
                onClick={() => navigate(d.path)}
              >
                {d.label}
              </button>
            ))}
          </nav>

          {/*
            In the masthead rather than in Preferences, because it is a reading control
            and the moment a reader wants it is while they are reading. Burying a
            display setting two screens away means it is found once and never again.

            The masthead itself stays visible in focus mode: a full-screen reading mode
            with no visible way out is the pattern this product exists not to be.
          */}
          <button
            type="button"
            className="btn btn--plain"
            style={{ marginLeft: 'auto' }}
            aria-pressed={focus}
            title="Larger type, no rails. The line length stays the same."
            onClick={() => {
              const next = !focus;
              setFocus(next);
              storeFocus(next);
              // Inside the click, because `requestFullscreen` is rejected outside a
              // user gesture. Awaiting it would also delay the CSS half behind a
              // permission decision the CSS half does not depend on.
              void (next ? enterFullscreen(document) : exitFullscreen(document));
            }}
          >
            {focus ? 'Exit focus' : 'Focus'}
          </button>

          <button
            type="button"
            className="btn btn--plain"
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
                  aria-current={tab === s.id && !routeOpen ? 'page' : undefined}
                  onClick={() => goToTab(s.id)}
                >
                  {s.label}
                </button>
              ))}
              {DESTINATIONS.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  className="btn btn--plain shell__nav-item"
                  aria-current={isPath(path, d.path) ? 'page' : undefined}
                  onClick={() => navigate(d.path)}
                >
                  {d.label}
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
              <div hidden={tab !== 'feed' || routeOpen}>
                <Feed
                  userId={session.user.id}
                  onStats={setStats}
                  refreshKey={prefsSaved}
                  onOpenSource={(id) => navigate(`/source/${id}`)}
                />
              </div>
              {sourceId !== null && (
                <Source
                  key={`${sourceId}:${summaryParam ?? ''}`}
                  workId={sourceId}
                  summaryId={summaryParam ?? undefined}
                  onNavigate={navigate}
                />
              )}
              {pullId !== null && (
                <PullRedirect pullId={pullId} onReplace={replaceWith} onNavigate={navigate} />
              )}
              {searchOpen && (
                <Search
                  query={searchQuery}
                  onNavigate={navigate}
                  onSearch={(q) => navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search')}
                />
              )}
              {tab === 'daily' && !routeOpen && (
                <Daily onNavigate={navigate} onGoToFeed={() => goToTab('feed')} />
              )}
              {tab === 'review' && !routeOpen && <Review />}
              {tab === 'library' && !routeOpen && <Library userId={session.user.id} />}
              {tab === 'history' && !routeOpen && (
                <History onNavigate={navigate} onGoToFeed={() => goToTab('feed')} />
              )}
              {tab === 'preferences' && !routeOpen && (
                <Preferences
                  userId={session.user.id}
                  onDone={() => {
                    setPrefsSaved((n) => n + 1);
                    setTab('feed');
                  }}
                />
              )}
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
                <span className="shell__stat-value">{stats?.skippedKnown ?? '—'}</span>
              </div>
              <div className="shell__stat">
                <span>Time saved</span>
                <span className="shell__stat-value shell__stat-value--accent">
                  {stats && stats.minutesSaved !== null ? `${stats.minutesSaved} min` : '—'}
                </span>
              </div>
            </div>
          </aside>
        </div>

        <Colophon onNavigate={navigate} />
      </div>
    </OnboardingGate>
  );
}
