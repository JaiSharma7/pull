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
/** `name` given to an error whose request never reached the server. */
export const TRANSPORT_ERROR = 'FetchError';

/**
 * Did the request fail to happen, rather than fail?
 *
 * postgrest-js catches a `fetch` rejection and *resolves* with an error object
 * carrying `code: ''` and the original error stringified into `message` — so
 * "TypeError: Failed to fetch" arrives as data, and there is no `TypeError` left
 * anywhere downstream to recognise. Any later `e instanceof TypeError` is dead
 * code, which is precisely what happened to the feed's offline check.
 *
 * The distinction decides what the reader is told, so it is worth keeping. A
 * request that never left the device means their cached Pulls are the right
 * answer. A request that arrived and was refused means something is wrong and
 * they should hear about it rather than be told to check their connection.
 *
 * Recognised here — the last place that still knows the wire shape — rather than
 * by string-matching a message five layers away.
 */
function isTransportFailure(e: RpcErrorShape): boolean {
  // An empty code, not an absent one: PostgREST sends `code: ''` for a failure
  // that never reached Postgres, while anything Postgres refused has a SQLSTATE.
  if (e.code !== '') return false;
  return /^(TypeError|FetchError|NetworkError|AuthRetryableFetchError)\b/.test(e.message ?? '');
}

export function rpcError(error: unknown): Error {
  if (error instanceof Error) return error;

  const e = (error ?? {}) as RpcErrorShape;
  const detail = [e.message, e.details, e.hint].filter(Boolean).join(' — ');
  const wrapped = new Error(detail || 'The request failed and returned no message.');

  if (isTransportFailure(e)) {
    wrapped.name = TRANSPORT_ERROR;
    return wrapped;
  }

  // Keep the SQLSTATE reachable. Callers already branch on 23505, and "not
  // authorised" versus "constraint violated" are very different things to be told.
  wrapped.name = e.code ? `PostgrestError ${e.code}` : 'PostgrestError';
  return wrapped;
}

/**
 * Is this deployment's database older than the code talking to it?
 *
 * Two things ship this product and only one of them is automatic. Vercel redeploys
 * `apps/web` on every push to `main`; migrations reach the hosted project only when
 * somebody runs `supabase db push`. So a pull request that adds a column and selects
 * it — which is an ordinary, correct pull request — puts a query for that column in
 * front of every reader the moment it merges, and the column arrives whenever the
 * next person remembers.
 *
 * That is not hypothetical and it is why this exists. On 2026-09-01 the hosted project
 * was seven migrations behind, `works.source_url` did not exist there, and every source
 * page a reader opened from a card answered "Something went wrong reaching the library"
 * — with `column works.source_url does not exist` printed underneath in the small grey
 * line nobody reads as an instruction.
 *
 * The reader cannot act on either sentence. Whoever runs the deployment can act on this
 * one immediately, and it is the difference between an afternoon of bisecting the
 * frontend and one command.
 *
 * `42703` is Postgres refusing a column that is not there. `PGRST204` is PostgREST's
 * own version, raised from its cached schema before the query is sent — the same fact
 * caught one layer earlier, and it arrives with no SQLSTATE at all.
 */
export function isSchemaBehind(error: unknown): boolean {
  if (error instanceof Error) {
    return /^PostgrestError (42703|PGRST204)$/.test(error.name);
  }
  const e = (error ?? {}) as RpcErrorShape;
  return e.code === '42703' || e.code === 'PGRST204';
}
