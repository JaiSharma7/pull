/**
 * The app's few real URLs.
 *
 * Reading is tab state on purpose — a Pull is not a page — but three things need an
 * address you can send someone: the legal documents, a source, and a single Pull.
 *
 * Pure and free of the Supabase client, so it can be tested at all. `lib/library.ts`
 * and `lib/preferences.ts` are split for the same reason.
 */

/**
 * The id in `/source/<id>` or `/pull/<id>`, or null if the path is not that route.
 *
 * The fragment and query string come off before the id does, and that is the whole
 * reason this is a function worth testing. `/pull/:id` resolves to
 * `/source/<uuid>#p-<pullId>`, and an earlier version left the anchor attached — so
 * the id became `"<uuid>#p-<uuid>"`, Postgres rejected it as 22P02, and the one path
 * this route exists to serve rendered "Could not load this source".
 *
 * It also only failed in-app: a cold load of the same URL worked, because
 * `location.pathname` carries no fragment. A bug that disappears when you reload it
 * is one nobody reports accurately.
 */
export function routeParam(pathname: string, prefix: string): string | null {
  const clean = pathname.split('#')[0]!.split('?')[0]!.replace(/\/+$/, '') || '/';
  if (!clean.startsWith(`${prefix}/`)) return null;
  const id = clean.slice(prefix.length + 1);
  // A further slash means a deeper path this route does not own, not an id with a
  // slash in it: `/source/a/b` is not a source called `a/b`.
  return id.length > 0 && !id.includes('/') ? id : null;
}

/**
 * A path segment, decoded, without letting a malformed one take the app down.
 *
 * `decodeURIComponent` throws `URIError` on an incomplete escape — `%`, `%zz`,
 * `%E0%A4%A` — and it was being called on the topic slug during render, with no
 * error boundary above it. So `/topic/%`, a URL anyone can type or link, blanked
 * the entire application rather than showing the topic's not-found state. Found
 * by a Codex review of PR #33.
 *
 * A malformed segment returns RAW rather than null. Null would mean "this is not
 * a topic route at all", and the reader would land somewhere unrelated with no
 * explanation; the raw string is simply a slug no topic has, so `get_topic`
 * matches nothing and `Topic` renders the "no such topic" screen it already has.
 * The honest answer to `/topic/%` is that there is no such topic.
 *
 * Passing the raw string to the RPC is safe — it is a text parameter to a
 * parameterised query, not interpolation.
 */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The Pull an anchor names, for `#p-<pullId>`. Null when there is no anchor. */
export function anchoredPullId(hash: string): string | null {
  if (!hash.startsWith('#p-')) return null;
  const id = hash.slice('#p-'.length);
  return id.length > 0 ? id : null;
}

/**
 * A query parameter from a path that may also carry a fragment.
 *
 * `/pull/:id` resolves to `/source/<workId>?s=<summaryId>#p-<pullId>`, so the value
 * has a fragment glued to its end unless the fragment is removed first. Written here
 * beside `routeParam` rather than inline in the shell because the two have to agree
 * about the order those suffixes come off in, and agreement is easier to keep when
 * it is in one file with tests.
 */
export function queryParam(pathname: string, key: string): string | null {
  const query = pathname.split('?')[1]?.split('#')[0];
  if (!query) return null;
  const value = new URLSearchParams(query).get(key);
  return value && value.length > 0 ? value : null;
}

/**
 * Is this path exactly one route, ignoring the query and the fragment?
 *
 * `routeParam` answers "what id does this path carry"; some routes carry none.
 * `/search?q=liberty` is the first of them, and comparing `location.pathname`
 * directly would have been enough right up until the first trailing slash or the
 * first query string — the two things `routeParam` already exists because of.
 * One place that knows the order those suffixes come off in.
 */
export function isPath(pathname: string, exact: string): boolean {
  const clean = pathname.split('#')[0]!.split('?')[0]!.replace(/\/+$/, '') || '/';
  const target = exact.replace(/\/+$/, '') || '/';
  return clean === target;
}
