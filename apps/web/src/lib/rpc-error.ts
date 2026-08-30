/** The shape PostgREST puts in `{ error }`. Not an Error — which is the problem. */
interface RpcErrorShape {
  message?: string;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
}

/**
 * Turn a PostgREST error into a real `Error`.
 *
 * supabase-js resolves with `{ data, error }` where `error` is a plain object, so
 * `throw error` hands callers something that fails `instanceof Error` and
 * stringifies to `[object Object]`. The feed rendered precisely that to the reader
 * on a failed load: the real message existed the whole time and never reached the
 * screen.
 *
 * Normalising at the throw site rather than at each catch means every caller gets
 * to assume what it already assumed — that a rejection is an Error.
 *
 * This lives apart from `api.ts` on purpose. Importing that module constructs the
 * Supabase client, which throws without `VITE_*` env — so a pure helper kept there
 * could only be tested by standing up configuration it does not use.
 */
export function rpcError(error: unknown): Error {
  if (error instanceof Error) return error;

  const e = (error ?? {}) as RpcErrorShape;
  const detail = [e.message, e.details, e.hint].filter(Boolean).join(' — ');
  const wrapped = new Error(detail || 'The request failed and returned no message.');
  // Keep the SQLSTATE reachable. Callers already branch on 23505, and "not
  // authorised" versus "constraint violated" are very different things to be told.
  wrapped.name = e.code ? `PostgrestError ${e.code}` : 'PostgrestError';
  return wrapped;
}
