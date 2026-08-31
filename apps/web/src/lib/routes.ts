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

/** The Pull an anchor names, for `#p-<pullId>`. Null when there is no anchor. */
export function anchoredPullId(hash: string): string | null {
  if (!hash.startsWith('#p-')) return null;
  const id = hash.slice('#p-'.length);
  return id.length > 0 ? id : null;
}
