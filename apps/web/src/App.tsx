import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Appearance } from './routes/Appearance.js';
import { Auth } from './routes/Auth.js';
import { Colophon } from './components/Colophon.js';
import { Daily } from './routes/Daily.js';
import { Explore } from './routes/Explore.js';
import { History } from './routes/History.js';

/*
 * The two screens that are worth splitting out, and only those.
 *
 * `Legal` inlines both `docs/privacy.md` and `docs/terms.md` through `?raw`, so every
 * visitor was downloading the full text of two policies in order to read a Pull.
 * `Account` is signed-in only and reached deliberately, so a visitor should not carry
 * it either.
 *
 * The sections — Feed, Library, Review, History, Preferences — are deliberately NOT
 * split. They are tab state inside a shell that keeps the feed mounted on purpose (see
 * the long comment at the render site), and lazily mounting things inside that
 * arrangement trades a real correctness argument for a smaller first byte. These two
 * are route-gated rather than tab-gated, which is what makes them safe to defer.
 */
const Legal = lazy(() => import('./routes/Legal.js').then((m) => ({ default: m.Legal })));
const Account = lazy(() => import('./routes/Account.js').then((m) => ({ default: m.Account })));

/*
 * Shown while a split chunk arrives. Matches the shell's own loading state rather than
 * introducing a spinner: on a fast connection it is never seen, and on a slow one it
 * should look like the rest of the app waiting rather than like something else.
 */
function RouteFallback() {
  return (
    <p className="meta" style={{ padding: 'var(--space-6)' }} role="status">
      Loading…
    </p>
  );
}
import { OnboardingGate, Preferences } from './routes/Preferences.js';
import { PullRedirect, Source } from './routes/Source.js';
import { Feed, type FeedStats } from './routes/Feed.js';
import { Library } from './routes/Library.js';
import { Review } from './routes/Review.js';
import { Search } from './routes/Search.js';
import { SecondFactorGate } from './routes/SecondFactorGate.js';
import { Topic } from './routes/Topic.js';
import { Specimen } from './routes/Specimen.js';
import {
  applyFocus,
  enterFullscreen,
  exitFullscreen,
  readStoredFocus,
  storeFocus,
} from './lib/focus-mode.js';
import { legalDocFor } from './lib/legal-routes.js';
import { decodeSegment, isPath, queryParam, routeParam } from './lib/routes.js';
import { takeDestination } from './lib/pending-destination.js';
import { isKnownPath, titleFor } from './lib/title.js';
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
/**
 * The address, including its query string.
 *
 * `window.location.pathname` drops `?q=…`, and everything downstream reads this
 * one string — so with the pathname alone `/search?q=liberty` was routable only
 * while the app itself had just pushed it. A cold load, a reload, a shared link
 * and the Back button all produced `/search` with no query, and the screen said
 * "What are you looking for?" while the address bar still read `?q=liberty`.
 * Back was the worst of them: it restored the URL, popstate fired, and the box
 * emptied itself.
 *
 * The fragment is deliberately not included. `anchoredPullId` reads
 * `location.hash` directly at the moment it scrolls, and folding it in here
 * would make every anchored Pull a distinct `path` value and re-render the
 * source page on a hash change that only ever moves the viewport.
 */
function readLocation(): string {
  return window.location.pathname + window.location.search;
}

const DESTINATIONS: { path: string; label: string; signedIn?: true }[] = [
  { path: '/explore', label: 'Explore' },
  { path: '/search', label: 'Search' },
  /*
   * A destination rather than a seventh section, and last of the three.
   *
   * The sections are the reader's own material — a feed, a library, a history —
   * and every one of them is a row keyed to a user, which is why `SECTIONS` is
   * hidden from a visitor entirely. Appearance is neither: it is stored on the
   * device, it needs no account, and a visitor must be able to reach it. That is
   * the same shape Explore and Search already have, so it goes where they are.
   */
  { path: '/appearance', label: 'Appearance' },
  /*
   * The one destination a visitor must NOT see, which is why the list now carries a
   * flag rather than being split in two.
   *
   * Everything else here is reachable without an account -- that is the argument
   * Appearance makes just above. Account is the opposite: every control on it acts on
   * a reader, so for a visitor it would be a link to a sign-in wall wearing the name
   * of a page. Keeping it in `DESTINATIONS` with a flag preserves the property the
   * comment above depends on and CLAUDE.md states -- this array is the authority for
   * what has an address -- which splitting it into two arrays would quietly end.
   */
  { path: '/account', label: 'Account', signedIn: true },
];

/**
 * The address a visitor was reading when they chose to sign in.
 *
 * A path inside this app and nothing else. The value arrives from the address
 * bar and is spent on a navigation, so an absolute or protocol-relative one
 * would make the sign-in button an open redirect — and on the magic-link return
 * it would hand somebody else's origin the fragment the session arrives in.
 * `//host` and `/\host` are both other origins once a browser has parsed them.
 */
function safeNext(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}

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
   * The name of whatever is currently open, reported upward by the screen that loads it.
   *
   * `App` knows the *address* of a source but not its title, and the title is the half
   * a person recognises in a tab strip or a history list. There is nothing to derive it
   * from until a request comes back, so it has to be state.
   *
   * STORED WITH THE PATH IT DESCRIBES, which is the whole trick. The obvious version —
   * a bare string plus an effect that clears it when `path` changes — is a synchronous
   * setState inside an effect, which the lint rule rejects for the usual reason: it
   * renders once with the stale title and again with null. Pairing the title with its
   * address makes staleness a question the render can answer, so there is nothing to
   * reset and no second render. A name from the previous page simply stops matching.
   */
  const [routeTitle, setRouteTitle] = useState<{ path: string; title: string } | null>(null);
  /*
   * Whether this session still owes a second factor.
   *
   * `null` while unknown, which matters: rendering the shell during the check would
   * flash the reader's feed at them before the gate appears, and rendering the gate
   * would flash a challenge at everyone who has no factor at all.
   *
   * Supabase does not enforce this by itself. After an email code the session is
   * `aal1` and stays there unless the app asks for a challenge, and no policy here
   * refuses an `aal1` token — so without this a reader who enrolled TOTP, saved their
   * recovery codes and felt safer had exactly the protection they had before, and the
   * app would never have told them. A control that cannot be exercised is worse than
   * an absent one, because it is believed.
   */
  const [factorState, setFactorState] = useState<{ userId: string; owes: boolean } | null>(null);
  const [factorChecks, setFactorChecks] = useState(0);
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
  const [path, setPath] = useState(readLocation);

  /*
   * Ask on every session change, and again after a challenge is satisfied.
   *
   * `getAuthenticatorAssuranceLevel` returns what this session has and what the account
   * requires; they differ exactly when a verified factor exists and has not been
   * satisfied. Failing open on an error is deliberate and is the lesser evil: the
   * alternative is a reader locked out of their own account by a network blip, and the
   * factor is re-checked on the next load.
   */
  useEffect(() => {
    const userId = session?.user.id;
    if (!userId) return;
    let live = true;
    void supabase.auth.mfa
      .getAuthenticatorAssuranceLevel()
      .then(({ data, error }) => {
        if (!live) return;
        if (error) throw error;
        setFactorState({
          userId,
          owes: data.nextLevel === 'aal2' && data.nextLevel !== data.currentLevel,
        });
      })
      .catch(() => {
        if (live) setFactorState({ userId, owes: false });
      });
    return () => {
      live = false;
    };
  }, [session, factorChecks]);

  // The attribute is the single source of truth for the CSS; this keeps it in step.
  useEffect(() => {
    applyFocus(focus, document.documentElement);
  }, [focus]);

  /*
   * Keep the document title in step with what is showing.
   *
   * Set in an effect rather than during render because it is a DOM write, and React
   * may render a component more than once for one commit. `titleFor` is pure and
   * tested; this is only the part that touches the document.
   */
  useEffect(() => {
    document.title = titleFor({
      pathname: window.location.pathname,
      tab,
      // Only if it describes the address currently showing. Otherwise the tab keeps
      // saying "On Liberty" while the next source loads, which is worse than saying
      // "Source": confidently wrong for as long as the request takes.
      documentTitle: routeTitle?.path === path ? routeTitle.title : null,
      query: queryParam(path, 'q'),
    });
  }, [path, tab, routeTitle]);

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
     * A session arriving is also the moment `?next=` is spent.
     *
     * Both ways in end here — a code typed into this tab and a magic link
     * returning to a fresh document — so this is the one place that knows a
     * reader has just become somebody with a feed. The address bar is read at
     * that moment rather than closed over, because on the link path this
     * document has never seen the earlier one.
     *
     * `replaceState`, not `push`: `/?next=…` only ever forwards, so Back must
     * return to wherever the reader came from rather than to it.
     */
    const arrive = (s: Session | null) => {
      setSession(s);
      if (!s) return;
      /*
       * The parameter first, then the device.
       *
       * `?next=` is present on the in-tab path — the reader typed a code into
       * the document that still carries it. It is absent on the one-click path,
       * because `magic_link.html` hardcodes its own address rather than routing
       * through `.ConfirmationURL`, so `emailRedirectTo` reaches nothing. The
       * fallback is what the device remembered when the email was sent.
       *
       * `takeDestination` spends it either way, including when the parameter
       * won — otherwise an unused value would sit there and redirect a later
       * sign-in that asked for somewhere else.
       */
      const remembered = takeDestination();
      const to = safeNext(queryParam(readLocation(), 'next')) ?? safeNext(remembered);
      if (!to) return;
      history.replaceState(null, '', to);
      setPath(to);
    };

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
      .then(({ data }) => arrive(data.session))
      .catch((e: unknown) => {
        // Log only. `null` is already the initial state, so assigning it here could
        // never do anything *except* revoke a session `onAuthStateChange` had
        // already delivered — auth-js emits INITIAL_SESSION on its own independent
        // path, and a slow rejection from a lock timeout arriving afterwards would
        // drop a signed-in reader back to the sign-in screen mid-session.
        console.error('Could not restore the session', e);
      })
      .finally(() => setReady(true));

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => arrive(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Back and forward have to work, or the reader who opened the terms is stuck
  // in them.
  useEffect(() => {
    const onPop = () => setPath(readLocation());
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
    if (readLocation() !== '/') navigate('/');
  }

  function navigate(to: string) {
    history.pushState(null, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  }

  /*
   * Stable across renders, so `Source`'s load effect can depend on it honestly.
   *
   * An inline arrow would be a new function every render, and the effect that calls it
   * would either re-run every render or lie in its dependency array — the lint rule
   * that noticed is right on both counts.
   *
   * The address is read at call time rather than captured, so the title is filed
   * against the page the answer actually arrived for, not the one that was showing
   * when the callback was made.
   */
  const reportRouteTitle = useCallback((title: string | null) => {
    setRouteTitle(title === null ? null : { path: readLocation(), title });
  }, []);

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

  /*
   * The idea a visitor was on when they agreed to sign in, kept through it.
   *
   * "Sign in to keep these" called `navigate('/')`, which is the one path that
   * throws away what they were reading: `/` is not public, so the shell renders
   * the sign-in screen and the shared `/source/:id?s=…#p-…` is gone from the
   * address bar. Signing in then landed them on the title page — the share path
   * discarding the shared idea at the exact moment the reader agreed to it.
   *
   * So the destination rides in the query string, through the sign-in screen and
   * through the email round trip (see `emailRedirectTo` in `Auth`). This is the
   * screen's copy of it; the session listener above is what spends it.
   */
  const next = safeNext(queryParam(path, 'next'));

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
  if (legal)
    return (
      <Suspense fallback={<RouteFallback />}>
        <Legal doc={legal} onNavigate={navigate} />
      </Suspense>
    );

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
  const exploreOpen = isPath(path, '/explore');
  const appearanceOpen = isPath(path, '/appearance');
  /*
   * A real address rather than a seventh section, for the same reason the legal
   * documents have one: it is a place a reader is sent to. "Delete your account" in a
   * privacy policy, a support reply, or their own bookmarks has to resolve to
   * something, and a tab that only exists after six clicks inside a shell cannot be
   * linked to. Signed-in only -- unlike Appearance, every control on it acts on a
   * reader, so there is nothing here for a visitor to see.
   */
  /*
   * Stored against the user it describes, so signing out and back in cannot show the
   * previous account's answer for a frame — and so nothing has to be reset in an
   * effect, which is a synchronous setState the lint rule rightly refuses. `null` means
   * "not answered for this reader yet", which is a different thing from "does not owe".
   */
  const owesFactor = session && factorState?.userId === session.user.id ? factorState.owes : null;

  const accountOpen = isPath(path, '/account');
  const topicSlug = routeParam(path, '/topic');
  /*
   * A path that matches nothing.
   *
   * `vercel.json` rewrites every path to the bundle and the service worker falls back
   * to it, which is what makes `/privacy` resolve on a cold load — and also what made
   * `/nonsense` return 200 with the app in it. Before this, a visitor on a typo'd URL
   * got the sign-in form and a signed-in reader got the feed, both under an address
   * that described neither.
   *
   * Asked of `lib/title.ts` rather than rebuilt here, so the list of what has an
   * address exists once. Two copies of it would drift, and the failure would be a page
   * whose title says "Not found" above content that says otherwise.
   */
  const notFound = !isKnownPath(window.location.pathname);
  const routeOpen =
    sourceId !== null ||
    pullId !== null ||
    searchOpen ||
    exploreOpen ||
    appearanceOpen ||
    accountOpen ||
    topicSlug !== null;

  /*
   * The library is readable without an account, and it always was.
   *
   * `anon` has held select on works, summaries, pulls, topics and daily_pulls
   * since round 1, and `summaries_read_published` narrows it to published and
   * public rows — so the database has been ready for this the whole time and
   * only the client gate was wrong. Verified against the hosted project: as
   * `anon`, the catalogue reports 42 sources, a topic page fills, search
   * returns ideas, and `get_source_delta` answers.
   *
   * It matters most for a link somebody shares. `og` has been redirecting
   * browsers to `/pull/:id` since round 2, and until now that path put a
   * stranger on a sign-in form — so every share this product has ever produced
   * ended at a wall. A shared idea now opens on the idea.
   *
   * The personal surfaces stay gated, and not for lack of nerve: the feed is
   * ranked against a reader's own history, Review reads their memory, and
   * Library, History and Preferences are all rows keyed to a user. There is
   * nothing to show a visitor on any of them.
   *
   * Appearance joins them for a reason of its own rather than by extension. It
   * is not personal data at all — `lib/appearance.ts` keeps it in `localStorage`
   * precisely because a visitor has no row to write a theme into — so gating it
   * would be the sign-in wall protecting nothing, at the moment it costs most: a
   * stranger who followed a shared link into a bone-white page at two in the
   * morning, and cannot turn the lights down without signing up first.
   */
  const publicRoute =
    sourceId !== null ||
    pullId !== null ||
    searchOpen ||
    exploreOpen ||
    appearanceOpen ||
    topicSlug !== null;
  const visitor = !session;

  if (!ready)
    return (
      <p className="meta" style={{ padding: 'var(--space-6)' }} role="status">
        Loading…
      </p>
    );
  /*
   * Ahead of the auth gate, deliberately. A visitor who mistypes a URL was not asking
   * to sign in, and answering a wrong address with a sign-up wall is the least useful
   * thing the app could say — it implies the page exists and is being withheld.
   */
  if (notFound)
    return (
      <main className="stack measure" style={{ padding: 'var(--space-6)' }}>
        <p className="meta">404</p>
        <h1 className="display">There is nothing at this address.</h1>
        <p>
          The link may be old, or mistyped. Everything that has an address of its own is reachable
          from the feed.
        </p>
        <div className="stack">
          <button type="button" className="btn btn--primary" onClick={() => navigate('/')}>
            Go to the feed
          </button>
          <button type="button" className="btn" onClick={() => navigate('/explore')}>
            Browse everything
          </button>
        </div>
      </main>
    );

  if (!session && !publicRoute) return <Auth onNavigate={navigate} next={next} />;

  /*
   * Ahead of everything a signed-in reader can see, and after the public routes.
   *
   * A visitor reading a shared Pull is unaffected — they have no account and owe no
   * factor. A reader who does owe one gets the challenge instead of the app, not a
   * banner over it: `/account` is behind this gate too, which is why the way back in
   * (a recovery code) lives on the gate itself rather than in settings the locked-out
   * reader cannot reach.
   */
  if (session && owesFactor === null)
    return (
      <p className="meta" style={{ padding: 'var(--space-6)' }} role="status">
        Loading…
      </p>
    );
  if (session && owesFactor)
    return <SecondFactorGate onPassed={() => setFactorChecks((n) => n + 1)} />;

  const shell = (
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
          {!visitor &&
            SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="btn btn--plain shell__masthead-item"
                aria-current={tab === s.id && !routeOpen ? 'page' : undefined}
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
          {DESTINATIONS.filter((d) => !d.signedIn || !visitor).map((d) => (
            <button
              key={d.path}
              type="button"
              className="btn btn--plain shell__masthead-item"
              aria-current={isPath(path, d.path) ? 'page' : undefined}
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

        {visitor ? (
          /*
              A door, not a wall. A visitor reached this screen through a shared
              link or the catalogue; the offer to keep what they find is the
              reason to sign in, and it belongs where they already are rather
              than in front of the thing they came for.

              Which is why the address travels with them. The fragment is part of
              it: `#p-<pullId>` is the idea that was shared, and a sign-in that
              returns to the source without it returns to the wrong place.
            */
          <button
            type="button"
            className="btn btn--plain"
            onClick={() =>
              navigate(`/?next=${encodeURIComponent(readLocation() + window.location.hash)}`)
            }
          >
            Sign in to keep these
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => void supabase.auth.signOut()}
          >
            Sign out
          </button>
        )}
      </header>

      <div className="shell__body">
        <aside className="shell__rail" aria-label="Sections">
          <p className="meta shell__group">{visitor ? 'Browse' : 'Reading'}</p>
          <nav className="shell__nav">
            {!visitor &&
              SECTIONS.map((s) => (
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
            {DESTINATIONS.filter((d) => !d.signedIn || !visitor).map((d) => (
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
            {session && (
              <div hidden={tab !== 'feed' || routeOpen}>
                <Feed
                  userId={session.user.id}
                  onStats={setStats}
                  refreshKey={prefsSaved}
                  onOpenSource={(id) => navigate(`/source/${id}`)}
                />
              </div>
            )}
            {sourceId !== null && (
              <Source
                key={`${sourceId}:${summaryParam ?? ''}`}
                workId={sourceId}
                summaryId={summaryParam ?? undefined}
                userId={session?.user.id ?? null}
                onNavigate={navigate}
                onTitle={reportRouteTitle}
              />
            )}
            {pullId !== null && (
              <PullRedirect
                pullId={pullId}
                userId={session?.user.id ?? null}
                onReplace={replaceWith}
                onNavigate={navigate}
              />
            )}
            {exploreOpen && <Explore onNavigate={navigate} />}
            {appearanceOpen && <Appearance />}
            {accountOpen && session && (
              <Suspense fallback={<RouteFallback />}>
                <Account userId={session.user.id} email={session.user.email ?? null} />
              </Suspense>
            )}
            {topicSlug !== null && (
              // Keyed on the slug so moving between topics is a fresh
              // component rather than one that has to remember to reset its
              // limit — the same reason `Source` is keyed on its work id.
              <Topic key={topicSlug} slug={decodeSegment(topicSlug)} onNavigate={navigate} />
            )}
            {searchOpen && (
              <Search
                query={searchQuery}
                onNavigate={navigate}
                onSearch={(q) => navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search')}
              />
            )}
            {session && tab === 'daily' && !routeOpen && (
              <Daily onNavigate={navigate} onGoToFeed={() => goToTab('feed')} />
            )}
            {session && tab === 'review' && !routeOpen && <Review />}
            {session && tab === 'library' && !routeOpen && <Library userId={session.user.id} />}
            {session && tab === 'history' && !routeOpen && (
              <History onNavigate={navigate} onGoToFeed={() => goToTab('feed')} />
            )}
            {session && tab === 'preferences' && !routeOpen && (
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

        {/*
            The tally is an account of one sitting — ideas met, kept, recalled,
            and the time the Delta spared. Every number in it is derived from a
            reader's own history, so for a visitor it would be five zeroes and a
            dash presented as a result. Omitted rather than emptied.
          */}
        {!visitor && (
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
        )}
      </div>

      <Colophon onNavigate={navigate} />
    </div>
  );

  /*
   * `OnboardingGate` reads the preference row keyed to a user and decides
   * whether the picker has been seen, so it can only wrap a session. A visitor
   * gets the shell directly — there is no preference to have not set yet.
   */
  return session ? <OnboardingGate userId={session.user.id}>{shell}</OnboardingGate> : shell;
}
