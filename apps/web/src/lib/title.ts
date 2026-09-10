import { isPath, routeParam } from './routes.js';

/**
 * What the browser tab, the history entry and the screen reader should call this page.
 *
 * `index.html` set `<title>What a Pull</title>` once and nothing ever changed it, so
 * every screen, every source and every search reported the same six characters. Three
 * things depend on that string and all three were broken by it: a tab strip with four
 * of this app open is unusable, browser history is a list of identical rows, and a
 * screen reader announces the same title after every navigation, which is the one
 * signal a non-visual reader has that the page changed at all.
 *
 * Pure, and separate from `App` for the reason `routes.ts` gives about itself: the
 * mapping is the part worth testing, and testing it should not require a DOM or a
 * Supabase client.
 *
 * The suffix is dropped on the root so the feed is just the product name rather than
 * "What a Pull · What a Pull". Everything else is `<page> · What a Pull`, narrowest
 * part first, because a tab strip truncates from the right and the distinguishing
 * word has to survive that.
 */
export const SITE_TITLE = 'What a Pull';

/** Sections are tab state rather than routes, so they are named separately. */
export type TitleTab = 'feed' | 'daily' | 'review' | 'library' | 'history' | 'preferences';

const TAB_TITLES: Record<TitleTab, string> = {
  feed: 'For You',
  daily: 'Daily Pull',
  review: 'Review',
  library: 'Library',
  history: 'History',
  preferences: 'Preferences',
};

const PATH_TITLES: Record<string, string> = {
  '/explore': 'Explore',
  '/search': 'Search',
  '/graph': 'Synapse Graph',
  '/import': 'Import History',
  '/demo': 'Demo',
  '/metacognition': 'Metacognitive ROI',

  '/settings': 'Settings',
  '/appearance': 'Appearance',
  '/account': 'Account',
  '/paths': 'Learning Paths',
  '/privacy': 'Privacy Policy',
  '/terms': 'Terms of Service',
};

export interface TitleInput {
  /** `window.location.pathname` — without the query string. */
  pathname: string;
  /** The section showing when no route is open. */
  tab: TitleTab;
  /** The work or summary title, once the source page knows it. */
  documentTitle?: string | null;
  /** The current search text, if any. */
  query?: string | null;
}

/**
 * Does this path match anything?
 *
 * Derived from the pathname rather than passed in, because `App` cannot pass it: the
 * legal routes return before the route flags are computed, so a hook below that point
 * would be conditional. Deriving it here also keeps one list of what has an address
 * instead of two that can disagree.
 *
 * `/source/:id` and `/topic/:slug` count as matched even when the row turns out not to
 * exist. Those screens distinguish "no such source" from "the request failed", which
 * is a better answer than a generic 404 — and at the moment the title is set, nobody
 * knows yet which it will be.
 */
export function isKnownPath(pathname: string): boolean {
  if (isPath(pathname, '/')) return true;
  if (fixedRoute(pathname)) return true;
  // The parameterised routes are known exactly when `routeParam` -- the reader `App`
  // uses to open them -- finds one segment: `/path/a/b` is not a path called `a/b`.
  // Matching the prefix alone called it known, so `notFound` stayed false while
  // `routeOpen` was false too, and the reader got the feed, or a titled empty screen,
  // under an address that described neither. One rule in one place, so the title and
  // the screen cannot disagree about which addresses exist.
  return PARAMETERISED.some((prefix) => routeParam(pathname, prefix) !== null);
}

const PARAMETERISED = ['/source', '/pull', '/topic', '/path'] as const;

/**
 * The fixed route this address names, read the way `App` reads it -- `isPath`, which
 * drops a trailing slash, the query and the fragment -- rather than as a raw key.
 * `/explore/` opened in `App` and was "Not found" here (review finding).
 */
function fixedRoute(pathname: string): string | undefined {
  return Object.keys(PATH_TITLES).find((route) => isPath(pathname, route));
}

export function titleFor({ pathname, tab, documentTitle, query }: TitleInput): string {
  const suffix = ` · ${SITE_TITLE}`;

  if (!isKnownPath(pathname)) return `Not found${suffix}`;

  /*
   * A source names itself once it is loaded, and says "Source" until then.
   *
   * Not the raw id: `/source/8f3e…` in a history list is worse than a generic word,
   * because it looks like an answer. The generic word is honest about waiting.
   */
  if (pathname.startsWith('/source/') || pathname.startsWith('/pull/')) {
    return `${documentTitle?.trim() || 'Source'}${suffix}`;
  }

  if (pathname.startsWith('/topic/')) {
    return `${documentTitle?.trim() || 'Topic'}${suffix}`;
  }

  if (pathname.startsWith('/path/')) {
    return `${documentTitle?.trim() || 'Learning Path'}${suffix}`;
  }

  if (isPath(pathname, '/search')) {
    const q = query?.trim();
    return q ? `${q} · Search${suffix}` : `Search${suffix}`;
  }

  const fixed = fixedRoute(pathname);
  if (fixed) return `${PATH_TITLES[fixed]}${suffix}`;

  // Only `/` reaches here, since anything else has been matched or called not-found.
  return tab === 'feed' ? SITE_TITLE : `${TAB_TITLES[tab]}${suffix}`;
}
