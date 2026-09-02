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
 * Do the app and the database disagree about what exists?
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
 * WHAT IT PROVES, AND WHAT IT DOES NOT. These codes say the app asked for something the
 * database does not have. They do NOT say which side is behind, and the first draft of
 * this claimed they did. A column dropped on purpose by a newer migration, read by an
 * older bundle out of the service worker's cache — which law 3 guarantees exists — is
 * the same code with the direction reversed, and there the answer is a reload, not a
 * migration. `PGRST204` inverts it a second way: it comes from PostgREST's schema cache,
 * which goes stale *after* a migration is applied, and is answered by
 * `notify pgrst, 'reload schema'` rather than by pushing anything.
 *
 * So the name is a description of the symptom and the copy says only that the two are
 * out of step. The commands belong here, in front of whoever is reading the repository,
 * and in `console.warn` — not asserted at a reader who cannot act on any of them.
 *
 * The codes: `42703` is Postgres refusing a column; `42P01` a table; `42883` a function,
 * which is how a missing RPC arrives once PostgREST has passed it through. `PGRST202`
 * and `PGRST204` are PostgREST's own versions of the last two, raised from its cached
 * schema before the query is sent, and they carry no SQLSTATE at all. All five are the
 * same fact — this deployment's schema and this bundle disagree — and the four beyond
 * the first matter because 20260901140000, 150000 and 190000 add functions that a
 * project behind on migrations does not have.
 */
const SCHEMA_MISMATCH_CODES = ['42703', '42P01', '42883', 'PGRST202', 'PGRST204'];

export function isSchemaMismatch(error: unknown): boolean {
  if (error instanceof Error) {
    const code = /^PostgrestError (.+)$/.exec(error.name)?.[1];
    return code !== undefined && SCHEMA_MISMATCH_CODES.includes(code);
  }
  const e = (error ?? {}) as RpcErrorShape;
  return typeof e.code === 'string' && SCHEMA_MISMATCH_CODES.includes(e.code);
}

/**
 * Can this write ever succeed as written?
 *
 * The offline queue retries a failed write until it lands, and for a network
 * failure or an unwell server that is right. It is wrong for a write the server
 * has looked at and refused for a reason that will not change: a save for a pull
 * that was deleted while the reader was offline, a patch to a row they no longer
 * own. Those kept `hasPending` true and the retry timer alive for the life of the
 * tab -- one IndexedDB read and one request every five minutes, forever -- and
 * the roadmap carried it as a known gap because the obvious bound, "give up after
 * N attempts", trades it for the worse failure of silently discarding something
 * the reader did.
 *
 * So the classification is conservative and by SQLSTATE, not by count. A write is
 * dropped only when Postgres itself said the request cannot be satisfied:
 *
 *   23503  foreign key -- the row this write points at is gone
 *   23514  check violation -- the value can never be accepted
 *   22P02  invalid text representation -- an id that is not a uuid at all
 *   42501  insufficient privilege -- RLS refused it for this account, and will again
 *
 * Everything else stays queued: transport failures, 5xx, a rate limit, an expired
 * token (refreshed on the next attempt), and a schema mismatch -- which
 * `isSchemaMismatch` recognises and which a pending migration or a reload resolves.
 * Not knowing is the same as transient; the cost of a wrong "permanent" is a lost
 * write, and the cost of a wrong "transient" is a retry.
 */
const PERMANENT_CODES = ['23503', '23514', '22P02', '42501'];

export function isPermanentFailure(error: unknown): boolean {
  let code: string | undefined;
  if (error instanceof Error) {
    code = /^PostgrestError (.+)$/.exec(error.name)?.[1];
  } else {
    const e = (error ?? {}) as RpcErrorShape;
    code = typeof e.code === 'string' ? e.code : undefined;
  }
  return code !== undefined && PERMANENT_CODES.includes(code);
}
