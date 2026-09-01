/**
 * Which addresses are legal documents, without loading the documents.
 *
 * Split out of `routes/Legal.tsx` so the route *test* is not tied to the route's
 * *content*. `Legal.tsx` imports both policies through `?raw`, which is about 25KB of
 * Markdown; `App` needs to ask "is this path /privacy?" on every render, and asking
 * that through a module carrying two policies means every visitor downloads both in
 * order to read one Pull. With the question here, `Legal` can be a lazy chunk and the
 * text arrives only for the people who open it.
 *
 * The pure/impure split is the same one `lib/routes.ts` makes and for the same reason:
 * a path predicate is worth testing, and testing it should not require a bundler that
 * understands `?raw`.
 */
export const LEGAL_PATHS = { '/privacy': 'privacy', '/terms': 'terms' } as const;

export type LegalDoc = (typeof LEGAL_PATHS)[keyof typeof LEGAL_PATHS];

export function legalDocFor(pathname: string): LegalDoc | null {
  // Trailing slashes are the same page; anything else is not this route.
  const path = pathname.replace(/\/+$/, '') || '/';
  return LEGAL_PATHS[path as keyof typeof LEGAL_PATHS] ?? null;
}
