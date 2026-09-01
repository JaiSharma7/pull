import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * The account: where you are signed in, everything you have written, and the door out.
 *
 * None of this goes through an Edge Function. Every operation here is a
 * `security definer` RPC that derives the reader from `auth.uid()` inside Postgres
 * (20260901140000), which is both smaller and safer than the alternative: an Edge
 * Function would need a service-role key in a new place and would then have to
 * re-derive, in TypeScript, an identity the database already knows for certain.
 *
 * The export is the exception and is deliberately the other way round — it is a plain
 * set of selects through RLS, so the guarantee that a reader exports only themselves
 * is the same guarantee that governs every other read in the app, rather than a new
 * one written for this file.
 */

/*
 * The generated `Database` type does not know these functions until `pnpm db:types`
 * has been run against a stack carrying 20260901140000 and 20260901150000.
 *
 * `packages/db/src/database.types.ts` is generated and must never be hand-edited (CI
 * regenerates it and fails on a diff), so the cast lives here instead, named, in one
 * place, rather than being sprinkled at each call site. Deleting this helper and
 * calling `supabase.rpc` directly is the whole of the follow-up once the types are
 * regenerated — and the typecheck will point at every line that needs it.
 */
type UntypedRpc = (
  name: string,
  args?: Record<string, unknown>,
) => PromiseLike<{
  data: unknown;
  error: unknown;
}>;

async function callRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await (supabase.rpc as unknown as UntypedRpc)(name, args);
  if (error) throw rpcError(error);
  return data as T;
}

/**
 * The same gap, for `mfa_recovery_codes`, which the generated types do not carry yet.
 *
 * Narrower than it looks: it returns the query builder untyped, so the one call below
 * loses column checking on a table with three columns. Everything else in this file
 * keeps its types. Like `callRpc`, this disappears the moment `pnpm db:types` runs.
 */
interface CountQuery {
  select(
    columns: string,
    options: { count: 'exact'; head: true },
  ): {
    is(column: string, value: null): PromiseLike<{ count: number | null; error: unknown }>;
  };
}

const untypedFrom = supabase.from as unknown as (table: string) => CountQuery;

export interface AccountSession {
  id: string;
  createdAt: string;
  refreshedAt: string | null;
  notAfter: string | null;
  aal: string;
  userAgent: string | null;
  ip: string | null;
  isCurrent: boolean;
}

interface SessionRow {
  id: string;
  created_at: string;
  refreshed_at: string | null;
  not_after: string | null;
  aal: string;
  user_agent: string | null;
  ip: string | null;
  is_current: boolean;
}

export async function fetchSessions(): Promise<AccountSession[]> {
  const rows = await callRpc<SessionRow[] | null>('my_sessions');
  return (rows ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    refreshedAt: r.refreshed_at,
    notAfter: r.not_after,
    aal: r.aal,
    userAgent: r.user_agent,
    ip: r.ip,
    isCurrent: r.is_current,
  }));
}

/** Ends one session. Returns false if it was already gone. */
export async function revokeSession(id: string): Promise<boolean> {
  return callRpc<boolean>('revoke_session', { p_session_id: id });
}

/** Ends every session but this one, and returns how many. */
export async function revokeOtherSessions(): Promise<number> {
  return callRpc<number>('revoke_other_sessions');
}

/**
 * Seconds since the current session was created, or null if it cannot be found.
 *
 * Used to decide whether to ask for a fresh code before something irreversible. The
 * server enforces the same bound in `delete_my_account`; this exists so the UI can ask
 * *before* the reader types their address rather than refusing them afterwards.
 */
export async function sessionAgeSeconds(): Promise<number | null> {
  return callRpc<number | null>('session_age_seconds');
}

/** The window `delete_my_account` allows, mirrored so the UI and the RPC agree. */
export const REAUTH_WINDOW_SECONDS = 600;

export async function deleteAccount(): Promise<void> {
  await callRpc<null>('delete_my_account');
}

// ---------------------------------------------------------------- recovery codes

export async function generateRecoveryCodes(): Promise<string[]> {
  return callRpc<string[]>('generate_mfa_recovery_codes');
}

/**
 * Spend a recovery code to remove a lost second factor.
 *
 * Not to sign in — see 20260901150000. Only GoTrue mints tokens and grants `aal2`, so
 * nothing here can substitute for the factor. Because sign-in is passwordless, taking
 * the factor off is a complete recovery path on its own: the reader can still receive
 * an email code.
 */
export async function redeemRecoveryCode(code: string): Promise<boolean> {
  return callRpc<boolean>('redeem_mfa_recovery_code', { p_code: code });
}

export async function unusedRecoveryCodeCount(): Promise<number> {
  const { count, error } = await untypedFrom('mfa_recovery_codes')
    .select('code_hash', { count: 'exact', head: true })
    .is('used_at', null);
  if (error) throw rpcError(error);
  return count ?? 0;
}

// ---------------------------------------------------------------------- export

/**
 * Everything the account holds, as one JSON document.
 *
 * Paged, every table of it. `max_rows` is 100 (supabase/config.toml) and this is the
 * "your words are yours" path, so an export that silently stopped at a hundred rows
 * would be worse than no export at all: it looks complete, and the reader only finds
 * out it was not when they need the part that is missing.
 *
 * Assembled in the browser rather than server-side on purpose. Every select below goes
 * through the same RLS that governs the rest of the app, so "a reader can only export
 * themselves" is not a property this file has to establish — it is the property the
 * database already enforces for every other read. A server-side exporter would be a
 * second, weaker place for that rule to live.
 *
 * `mfa_recovery_codes` is deliberately absent. It holds hashes of a live credential;
 * putting them in a file the reader downloads and forwards is a way to leak one.
 */
const EXPORTED: { table: string; column: string }[] = [
  { table: 'profiles', column: 'id' },
  { table: 'preference_profiles', column: 'user_id' },
  { table: 'stashes', column: 'user_id' },
  { table: 'saved_items', column: 'user_id' },
  { table: 'notes', column: 'user_id' },
  { table: 'highlights', column: 'user_id' },
  { table: 'history_events', column: 'user_id' },
  { table: 'progress', column: 'user_id' },
  { table: 'knowledge_states', column: 'user_id' },
  { table: 'convictions', column: 'user_id' },
  { table: 'explanations', column: 'user_id' },
  { table: 'interrupt_events', column: 'user_id' },
  { table: 'feed_impressions', column: 'user_id' },
  { table: 'feed_recipes', column: 'user_id' },
  { table: 'follows', column: 'follower_id' },
  { table: 'generation_jobs', column: 'requester_id' },
];

export interface AccountExport {
  exportedAt: string;
  userId: string;
  email: string | null;
  /** Tables that could not be read, with why. Present so a partial export says so. */
  incomplete: { table: string; reason: string }[];
  data: Record<string, unknown[]>;
}

export async function buildAccountExport(
  userId: string,
  email: string | null,
): Promise<AccountExport> {
  const PAGE = 100;
  const data: Record<string, unknown[]> = {};
  const incomplete: { table: string; reason: string }[] = [];

  for (const { table, column } of EXPORTED) {
    const rows: unknown[] = [];
    try {
      for (let from = 0; ; from += PAGE) {
        const { data: page, error } = await supabase
          .from(table as never)
          .select('*')
          .eq(column, userId)
          // Ordered so the pages partition the set rather than overlapping: without
          // it PostgREST may return rows in any order and a range walk can repeat or
          // skip. `column` is on every table here and is never null for these rows.
          .order(column, { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw rpcError(error);
        const got = (page ?? []) as unknown[];
        rows.push(...got);
        if (got.length < PAGE) break;
      }
      data[table] = rows;
    } catch (e) {
      /*
       * A table that cannot be read is recorded rather than swallowed or fatal.
       *
       * Fatal would mean one unreadable table denies the reader everything else they
       * asked for. Swallowed would mean the file says nothing about the gap, which is
       * the failure this whole function is written to avoid — so the omission is
       * named in the document itself.
       */
      incomplete.push({ table, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { exportedAt: new Date().toISOString(), userId, email, incomplete, data };
}
