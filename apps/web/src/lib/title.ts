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
  '/appearance': 'Appearance',
  '/account': 'Account',
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
  if (pathname === '/') return true;
  if (PATH_TITLES[pathname]) return true;
  return (
    pathname.startsWith('/source/') ||
    pathname.startsWith('/pull/') ||
    pathname.startsWith('/topic/')
  );
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

  if (pathname === '/search') {
    const q = query?.trim();
    return q ? `${q} · Search${suffix}` : `Search${suffix}`;
  }

  const known = PATH_TITLES[pathname];
  if (known) return `${known}${suffix}`;

  // Only `/` reaches here, since anything else has been matched or called not-found.
  return tab === 'feed' ? SITE_TITLE : `${TAB_TITLES[tab]}${suffix}`;
}
