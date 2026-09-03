import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Mark } from '@wap/ui';
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
import { Graph } from './routes/Graph.js';
import { Library } from './routes/Library.js';
import { MetacognitiveDashboard } from './routes/MetacognitiveDashboard.js';
import { OnboardingDemo } from './components/OnboardingDemo.js';
import { Ingestion } from './routes/Ingestion.js';

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
import { isGuest } from './lib/guest.js';
import { legalDocFor } from './lib/legal-routes.js';
import { decodeSegment, isPath, queryParam, routeParam } from './lib/routes.js';
import { takeDestination } from './lib/pending-destination.js';
import { isKnownPath, titleFor } from './lib/title.js';
import { supabase, tabAdopts } from './lib/supabase.js';

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
   * All four are `signedIn`, and the flag is load-bearing rather than tidy.
   *
   * `publicRoute` below lists what a visitor may actually open, and none of these are in
   * it — so while they were advertised without the flag, a signed-out visitor on Explore
   * was shown four destinations that each dropped them onto the sign-in screen the
   * moment they were selected. The navigation promised something the router refused.
   *
   * They belong behind it on their own merits too: the graph, the ROI figures and the
   * import are all keyed to a reader, which is the same reason `SECTIONS` is hidden from
   * a visitor. The demo runs inside onboarding, where there is already a session.
   */
  { path: '/graph', label: 'Graph', signedIn: true },
  { path: '/import', label: 'Import', signedIn: true },
  { path: '/metacognition', label: 'Progress', signedIn: true },

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
   * Whether a guest has asked to leave, and is being asked to mean it.
   *
   * A plain boolean, cleared on navigation by the adjustment beside `confirmationPath`
   * below — read that one for why it is shaped the way it is. This component never
   * unmounts, so left to itself the flag is sticky: a guest who presses "End this guest
   * session", thinks better of it, goes to Explore and comes back meets the panel already
   * asking "Yes — end it and sign in" as its primary button, with no memory of having
   * asked for it. A two-press confirmation whose first press can be days old and on
   * another screen is a one-press confirmation.
   *
   * Lives here rather than in the panel because the panel is inline JSX in this
   * component; if it ever becomes its own route it should take this and its reset with it.
   */
  const [guestLeaving, setGuestLeaving] = useState(false);
  /*
   * Where keyboard focus goes when that flag flips, and why this is a ref rather than an
   * effect keyed on `guestLeaving`.
   *
   * Pressing either control unmounts the button that was pressed and mounts a different
   * one, so focus falls to `<body>` — a keyboard reader is dropped at the top of the
   * document with no announcement, in the middle of a confirmation they are halfway
   * through. The fix has to move focus, and it has to move it only on that transition:
   * an effect keyed on `guestLeaving` alone also fires when the panel first mounts, which
   * would steal focus from whatever a reader was doing and land it on a button that ends
   * their session. So the handlers say where focus should go, and the effect below spends
   * that intent exactly once.
   *
   * Entering the confirmation focuses the SAFE control, not the destructive one. Space
   * or Enter pressed twice in a row is the misclick this pair exists to catch, and
   * focusing "Yes" would make the second press land on it.
   */
  const guestWantsFocus = useRef<'end' | 'keep' | null>(null);
  const guestEndRef = useRef<HTMLButtonElement>(null);
  const guestKeepRef = useRef<HTMLButtonElement>(null);
  /*
   * Spends that intent, once, after the render that swapped the buttons over.
   *
   * No dependency array on purpose: a ref is not reactive, so there is nothing React
   * could key this on, and the guard makes it a no-op on every render but the one that
   * matters. Declared up here with the rest of the hooks rather than beside the panel it
   * serves, because this component returns early for the specimen and legal routes and a
   * hook below those runs in some renders and not others.
   */
  useEffect(() => {
    const want = guestWantsFocus.current;
    if (want === null) return;
    guestWantsFocus.current = null;
    (want === 'keep' ? guestKeepRef : guestEndRef).current?.focus();
  });
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
   * The address the guest confirmation was last reconciled against, and the reconciliation
   * itself. Both live here, beside `path`, and the placement is the whole point.
   *
   * Any navigation puts the confirmation back in its box — including coming back. This is
   * React's documented "adjust state during render when something changes" pattern, which
   * is the right shape because the two wrong ones are already ruled out: a sticky boolean
   * was the original bug, and an effect whose body calls `setState` is a cascading render
   * that this repo's lint rejects. Keyed on the path CHANGING rather than on its value, so
   * a return trip is a different visit and starts from the safe state.
   *
   * It sits ABOVE the early returns for the specimen and legal routes rather than beside
   * the panel it serves, and that is not tidiness — it is the third time this exact
   * defect has been fixed. Below them, a render that returns early never reaches the
   * comparison, so `confirmationPath` never advances: open the confirmation on /account,
   * follow the Privacy link in the colophon (which renders below the guest panel, so both
   * are on screen together), press Back, and `/account === /account` means no reset. The
   * destructive button is primary again on a first press that was never made. A hook
   * below an early return is a lint error and gets caught; a plain `if` below one is
   * silent, which is why this comment is longer than the code.
   */
  const [confirmationPath, setConfirmationPath] = useState(path);
  if (confirmationPath !== path) {
    setConfirmationPath(path);
    setGuestLeaving(false);
  }

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
      /*
       * Only adopt a session this tab's storage actually holds.
       *
       * auth-js broadcasts auth events across tabs on a `BroadcastChannel`, and its
       * receiving handler notifies with a session it never wrote to this tab's storage
       * (`GoTrueClient.js`, the handler around line 276). Every LOCAL path saves first and
       * notifies second, all fourteen of them, so this costs a real sign-in nothing.
       *
       * It costs a guest tab a great deal. A guest's token is in per-tab `sessionStorage`,
       * so when another tab signs in with an email the broadcast would make this tab render
       * that reader -- their name, their Library, `/account` -- while every request it sent
       * still carried the guest's JWT. The reader would stash and grade into an anonymous
       * account the sweep deletes a day later, and the offline drain's own guard would pass
       * because it compares the id this listener set. Measured in Chromium against a real
       * supabase-js client in round two of the review on #48.
       *
       * Ignoring it leaves this tab as the guest it still is, which is the one description
       * of it that matches what the network sees.
       *
       * SIGNED_OUT is guarded too, and exempting it was a bug of its own: a guest tab
       * pressing "Yes — end it and sign in", or simply outliving the sweep and failing a
       * refresh, broadcasts SIGNED_OUT and threw every other tab on the machine to the
       * sign-in screen mid-read. A local sign-out clears storage before it notifies, so
       * null-on-both-sides still adopts and a real sign-out is unaffected.
       */
      if (!tabAdopts(s?.user.id ?? null)) return;
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
  const graphOpen = isPath(path, '/graph');
  const importOpen = isPath(path, '/import');
  const demoOpen = isPath(path, '/demo');
  const metacognitionOpen = isPath(path, '/metacognition');
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
    graphOpen ||
    importOpen ||
    demoOpen ||
    metacognitionOpen ||
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
  /*
   * A guest is signed in, and is not a reader with an account.
   *
   * The distinction is deliberately narrow. Everything keyed to a user works for a
   * guest — the sections, the feed, the onboarding picker, the tally — because a guest
   * IS a user, so `visitor` is the flag almost every line below wants. The only screen
   * that would be a dead end is Account: it lists sessions, enrols a second factor and
   * deletes the account, and every one of those either needs an address or needs a
   * recent sign-in that a guest can never perform. So the destination is withheld and
   * the route says why, rather than rendering controls that cannot complete.
   */
  const guest = isGuest(session);
  /*
   * Computed once and used by both navigations. They were filtering the same array with
   * the same predicate written out twice, which is exactly how the masthead and the
   * rail come to disagree about what a reader may reach.
   */
  const destinations = DESTINATIONS.filter((d) => !d.signedIn || (!visitor && !guest));

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
        <span className="shell__brand">
          <Mark className="shell__mark" />
          <span className="shell__wordmark">What a Pull</span>
        </span>

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
          {destinations.map((d) => (
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
        {/*
          Wrapped, so the trailing controls stay together and stay right. The auto margin
          moved off this button and onto the group: an auto margin resolves per flex line,
          so with three trailing children it pushed only the ones sharing its line and let
          the last wrap alone to the left under the others.
        */}
        <span className="shell__actions">
          <button
            type="button"
            className="btn btn--plain"
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
          ) : guest ? (
            /*
            A marker and a way out, and neither of them is `signOut` here.

            The first draft put "Sign in" in the pixel where every account holder's
            "Sign out" sits, wired straight to `signOut()`, with the consequence stated
            only in a `title`. Three things were wrong with that, and they compound.

            It is destructive and irreversible: a guest has no address and no password,
            so the token in this browser IS the credential, and ending the session
            deletes an evening of reading with no way to get it back. A `title` needs a
            hover, so a keyboard reader tabbing to it never sees the warning, and a
            screen reader treats it as a description of a button that already has a name
            and mostly does not announce it. The disclosure that does exist in text
            lived on /account -- which this same commit withholds from a guest's
            navigation, so it was written for an audience that could not reach it.

            And it frequently did not even sign anyone in. `signOut()` alone only
            reaches the sign-in screen from an address that is not a public route; from
            /explore, /search, /appearance or a shared source -- all of which a guest
            can be on -- the session ended and the shell simply re-rendered as a
            visitor, so the reader lost everything and gained nothing.

            So this navigates to /account instead, which for a guest is the panel below:
            the consequence in plain visible text, and the destructive step behind a
            second, deliberate press. /account is not a public route, so `signOut()`
            there does land on the sign-in screen -- the one place it always worked.
          */
            <span className="shell__guest">
              <span className="meta">Reading as a guest</span>
              {/*
              The control disappears on the page it leads to. `navigate` pushes
              unconditionally, so pressing it from /account changed nothing on screen and
              grew the Back stack by one — a button that looks live, does nothing visible,
              and costs the reader a press to undo. The marker stays, because the fact it
              states is still true.
            */}
              {!accountOpen && (
                <button
                  type="button"
                  className="btn btn--plain"
                  onClick={() => navigate('/account')}
                >
                  Sign in
                </button>
              )}
            </span>
          ) : (
            <button
              type="button"
              className="btn btn--plain"
              onClick={() => void supabase.auth.signOut()}
            >
              Sign out
            </button>
          )}
        </span>
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
            {destinations.map((d) => (
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
            {graphOpen && !guest && (
              <Graph
                userId={session?.user.id ?? null}
                onOpenSource={(id) => navigate(`/source/${id}`)}
              />
            )}
            {/* No `onComplete` destination. It used to navigate to /metacognition, which
                re-implies by navigation the thing the import does not do: nothing here
                reaches the Delta, so landing the reader on the ROI dashboard afterwards
                suggests it did. */}
            {importOpen && !guest && <Ingestion />}

            {demoOpen && (
              <OnboardingDemo onComplete={() => navigate('/')} onSkip={() => navigate('/')} />
            )}
            {metacognitionOpen && !guest && (
              <MetacognitiveDashboard
                userId={session?.user.id ?? null}
                onNavigate={navigate}
                onGoToReview={() => goToTab('review')}
              />
            )}
            {appearanceOpen && <Appearance />}

            {accountOpen && session && !guest && (
              <Suspense fallback={<RouteFallback />}>
                <Account userId={session.user.id} email={session.user.email ?? null} />
              </Suspense>
            )}
            {/*
              An answer rather than an empty column.

              `/account` is withheld from a guest's navigation, and a URL is still a URL:
              somebody arrives here from a bookmark or a shared address. Every control on
              the real screen acts on an address — the sessions list, the second factor,
              deletion, which needs a sign-in from the last ten minutes and therefore a
              code in a mailbox — so rendering it would be a page of things that cannot
              complete. This says which one thing to do instead.
            */}
            {/*
              The same answer `/account` gives, for the same reason and now for the three
              destinations gated from a guest above. A URL is still a URL: adding
              `&& !guest` to the routes without a fallback meant a guest arriving at
              /graph, /import or /metacognition by bookmark got a titled tab, a masthead,
              a rail and an entirely empty main — `routeOpen` hides the feed, and
              `isKnownPath` matches, so the 404 branch does not catch it either.
            */}
            {(graphOpen || importOpen || metacognitionOpen) && guest && (
              <section className="stack measure">
                <p className="meta">Reading as a guest</p>
                <h1>This one needs an account.</h1>
                <p>
                  A guest session keeps your reading on this device and nothing else. These screens
                  are built from a knowledge model that belongs to an account — what you have read,
                  how well you are holding on to it, and what connects to what — so there is nothing
                  here to show you yet.
                </p>
                <p className="meta">
                  Everything you have read as a guest carries over when you sign in.
                </p>
                <button type="button" className="btn btn--primary" onClick={() => navigate('/')}>
                  Back to reading
                </button>
              </section>
            )}

            {accountOpen && guest && (
              <section className="stack measure">
                <p className="meta">Account</p>
                {/*
                  A plain `h1`, matching Account.tsx. `.prose__heading` carries a 3rem
                  top margin and expects to be the first child of a `.prose`; used here
                  it wins over the stack's 1rem and floats the eyebrow away from its own
                  heading, so the two versions of this route open differently.
                */}
                <h1>You are reading as a guest.</h1>
                <p>
                  There is no account to manage here yet — every control on this screen acts on an
                  email address, and a guest session has none. That is also what makes the next part
                  worth reading before you press it.
                </p>
                {/*
                  Plain body text, deliberately not `.meta`.

                  `.meta` is uppercase mono at --step--1: a chip face, right for "For You" and
                  "The Delta" and wrong for the one paragraph on this screen that carries a
                  consequence. All-caps destroys word shape, and this is the sentence a reader
                  has to actually read rather than glance at.
                */}
                <p id="guest-consequence">
                  Signing in starts a <strong>fresh account</strong>. This guest session ends when
                  you do, and it cannot be reopened — there is no address to send a code to — so
                  what you have read and stashed as a guest stays behind.
                </p>
                {/*
                  The expiry, said here as well as on the sign-in screen.

                  A guest reads the sign-in screen once, before they have anything to lose, and
                  this screen only once they do. Saying it in one place would mean the sentence
                  that matters — everything here goes in a day — is only ever shown to somebody
                  who has not yet made anything worth keeping.
                */}
                <p>
                  This session also ends on its own. Closing this tab ends it here, the way a
                  private window does, and the account behind it is deleted a day after you last use
                  it, along with everything keyed to it. Signing in with an email address is what
                  makes any of it stay.
                </p>
                {/*
                  Two presses, which is the shape every irreversible action on the real
                  Account screen already takes: "make them do something that could not be a
                  misclick". This one has less recoverability than any of them — no address,
                  so no export and no way back — and a reader can arrive here from a
                  bookmark, primed to hit the primary button because they came to sign in.
                  Oxblood is not what makes it safe; the second press is.
                */}
                {/*
                  `.shell__confirm`, not `.stack`, and the difference is visible rather than
                  pedantic. `.stack` separates children with `margin-block-start` alone,
                  which does nothing useful between two `<button>`s: they are
                  `inline-block`, so they flow onto one line and the margin lands above
                  the pair. This confirmation rendered as "YES — END IT AND SIGN IN"
                  butted against "KEEP READING AS A GUEST" with a text node's worth of
                  space between them, destructive option first.
                */}
                {/*
                  Announced, because focus alone does not say what happened.
                  Pressing the trigger swaps it for two different buttons and moves focus
                  to the safe one, so a screen reader says "Keep reading as a guest,
                  button" and nothing else -- no indication that a confirmation opened, or
                  that the destructive option is now one press away and sits BEFORE this
                  button in the DOM. A live region that is always present and changes its
                  text is what gets announced; rendering the region itself conditionally
                  is the version that stays silent.
                */}
                <p className="sr-only" role="status">
                  {guestLeaving
                    ? 'Confirm ending this guest session. This cannot be undone. Two choices ' +
                      'follow: end it and sign in, or keep reading as a guest.'
                    : ''}
                </p>
                <div className="shell__confirm">
                  {guestLeaving ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--primary"
                        aria-describedby="guest-consequence"
                        onClick={() => {
                          // Navigate first: `signOut()` alone leaves the address at
                          // /account, which keeps the tab title reading "Account" over the
                          // sign-in screen and drops the next guest straight back onto this
                          // panel instead of the feed.
                          navigate('/');
                          void supabase.auth.signOut();
                        }}
                      >
                        Yes — end it and sign in
                      </button>
                      <button
                        type="button"
                        ref={guestKeepRef}
                        className="btn btn--plain"
                        onClick={() => {
                          // Focus returns to the control that opened the confirmation,
                          // which is where a keyboard reader was before they asked.
                          guestWantsFocus.current = 'end';
                          setGuestLeaving(false);
                        }}
                      >
                        Keep reading as a guest
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      ref={guestEndRef}
                      className="btn btn--primary"
                      aria-describedby="guest-consequence"
                      onClick={() => {
                        guestWantsFocus.current = 'keep';
                        setGuestLeaving(true);
                      }}
                    >
                      End this guest session and sign in
                    </button>
                  )}
                </div>
              </section>
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
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                }}
              >
                <p className="meta">The Delta</p>
                {/* Same condition as `destinations` above, which withholds /metacognition
                    from a guest. The two navigations disagreed: the rail offered a guest a
                    link the masthead deliberately hid, and the route would have refused it.
                    No arrow either — nothing else in the app labels a button that way. */}
                {!visitor && !guest ? (
                  <button
                    type="button"
                    className="btn btn--plain meta"
                    style={{ textDecoration: 'underline' }}
                    onClick={() => navigate('/metacognition')}
                  >
                    Your progress
                  </button>
                ) : null}
              </div>

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
