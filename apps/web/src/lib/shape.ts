/**
 * Narrowing an RPC response into something the screens can trust.
 *
 * Every read in this app comes back from a Postgres function returning `jsonb`,
 * which supabase-js types as `Json` — so a cast to the interface a screen wants
 * asserts a shape nobody checked. This repo has already lost a pipeline run to
 * exactly that class of mistake: four values TypeScript accepted and Postgres
 * rejected, discovered only after the expensive call had been paid for.
 *
 * These are the primitives the per-feature shapers are built from. They fail
 * toward absence rather than toward `"undefined"` on screen: a missing string is
 * empty, a missing number is null or zero, and a row without an id — which
 * cannot be linked to or keyed — is dropped rather than rendered dead.
 *
 * Pure, so they can be tested in `environment: 'node'` without standing up the
 * Supabase client that `lib/supabase.ts` constructs on import.
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A string, or empty. Never the literal `"undefined"`. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A string, or null — for columns that are genuinely nullable. */
export function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * A finite number, or 0.
 *
 * `Number.isFinite` rather than a truthiness check, because `NaN` and `Infinity`
 * both survive `typeof v === 'number'` and both render as themselves.
 */
export function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** A finite number, or null — for a year or a duration that may be absent. */
export function nullableInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The object rows of an array, discarding anything that is not one. */
export function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/** A type guard for `.filter()`, so a shaper that drops rows keeps its type. */
export function nonNull<T>(v: T | null): v is T {
  return v !== null;
}
