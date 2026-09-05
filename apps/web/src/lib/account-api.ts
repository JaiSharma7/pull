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

/**
 * Call one of the account RPCs and normalise its error.
 *
 * A thin wrapper rather than a cast: `supabase.rpc` is fully typed against the
 * generated `Database`, so the function name and its arguments are checked here. What
 * this adds is the `rpcError` normalisation every other api module in this app does —
 * postgrest-js resolves with a plain object, so `throw error` hands callers something
 * that fails `instanceof Error`.
 */
async function callRpc<T>(
  name: Parameters<typeof supabase.rpc>[0],
  args?: Parameters<typeof supabase.rpc>[1],
): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw rpcError(error);
  return data as T;
}

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
  const { count, error } = await supabase
    .from('mfa_recovery_codes')
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
/*
 * Every table holding rows that belong to a reader, the column that says so, and a
 * column that ORDERS them.
 *
 * The order is not decoration, and neither is what is done with it. This used to order
 * by `column` — the same value on every row that survived the filter, so it ordered
 * nothing, and PostgREST was free to return page 2 overlapping page 1.
 *
 * A TOTAL ORDER WAS NECESSARY AND NOT SUFFICIENT, and the first version of this comment
 * claimed otherwise: it said the ordering fixed the case where another tab inserts a row
 * mid-export. It does not. `.range(from, from + 99)` is `LIMIT/OFFSET`, and an offset is
 * unstable under concurrent writes however well ordered the rows are — a row that lands
 * before the current offset shifts every later page by one, so the file carries one row
 * twice and omits another while `incomplete` stays empty. Measured on 250 rows: row 109
 * duplicated, the concurrently inserted row absent, and the document still claiming to
 * be whole. Because `id` is `gen_random_uuid()`, an inserted row lands at a random
 * position, so roughly half of all mid-export writes do this.
 *
 * So the walk is keyset now: order by `key`, ask for what sorts after the last one seen,
 * and carry that forward. Nothing shifts under a cursor that names a row rather than
 * counting from the start.
 *
 * `key` is therefore a column unique WITHIN one reader's rows, which makes it both a
 * total order and a usable cursor: the primary key where it is a single `id`, and the
 * other half of a composite key where it is not.
 */
const EXPORTED: { table: string; column: string; key: string }[] = [
  { table: 'profiles', column: 'id', key: 'id' },
  { table: 'preference_profiles', column: 'user_id', key: 'user_id' },
  { table: 'stashes', column: 'user_id', key: 'id' },
  { table: 'saved_items', column: 'user_id', key: 'id' },
  { table: 'notes', column: 'user_id', key: 'id' },
  { table: 'highlights', column: 'user_id', key: 'id' },
  { table: 'history_events', column: 'user_id', key: 'id' },
  { table: 'progress', column: 'user_id', key: 'summary_id' },
  { table: 'knowledge_states', column: 'user_id', key: 'pull_id' },
  { table: 'convictions', column: 'user_id', key: 'id' },
  { table: 'explanations', column: 'user_id', key: 'id' },
  { table: 'interrupt_events', column: 'user_id', key: 'id' },
  // Every recall attempt as it happened, which is the evidence behind
  // `knowledge_states` rather than a duplicate of it: the grade, the stated
  // confidence, what was typed, and the stability before and after. An export
  // that carried only the derived numbers would hand a reader the conclusions
  // and keep the working.
  { table: 'recall_events', column: 'user_id', key: 'id' },
  { table: 'feed_impressions', column: 'user_id', key: 'id' },
  { table: 'feed_recipes', column: 'user_id', key: 'id' },
  { table: 'follows', column: 'follower_id', key: 'followee_id' },
  { table: 'generation_jobs', column: 'requester_id', key: 'id' },
  // Three more that `docs/privacy.md` names as the reader's own and this list did
  // not carry, which made "every row stored against your account" untrue of it.
  // `user_knowledge_vectors` is the centroid the Delta compares candidates
  // against — the policy calls it personal data and says it is deleted with the
  // account, so it is the reader's to take. `session_seeds` is what decides the
  // order they were shown things in. `reports` is what they have told us about
  // somebody else's content, which is their own writing and readable by them
  // through `reports_own`.
  { table: 'session_seeds', column: 'user_id', key: 'id' },
  { table: 'user_knowledge_vectors', column: 'user_id', key: 'user_id' },
  { table: 'reports', column: 'reporter_id', key: 'id' },
];

/*
 * WHAT IS DELIBERATELY NOT HERE, so a future reader does not assume an omission.
 *
 *   mfa_recovery_codes  A list of unspent second factors. Writing them into a
 *                       file the reader will email themselves is the opposite of
 *                       what they are for; the account screen shows them once, at
 *                       the moment they are generated, and that is the only place
 *                       they should ever appear.
 *   rate_limits         Operational counters keyed to the account rather than
 *                       anything the reader did. Nothing in them is theirs.
 *
 * `imports`, `import_items` and `user_questions` are the reader's and belong
 * here; they arrive with the PR that lets a reader create one, so that this list
 * and the tables it names land together.
 */

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

  for (const { table, column, key } of EXPORTED) {
    const rows: unknown[] = [];
    try {
      // The cursor: the `key` of the last row taken, or nothing on the first page.
      let after: string | null = null;
      for (;;) {
        let query = supabase
          .from(table as never)
          .select('*')
          .eq(column, userId)
          // A column unique within this reader's rows, so this is a total order and
          // every row has a distinct place in it — which is what makes it usable as a
          // cursor as well as an order.
          .order(key, { ascending: true })
          .limit(PAGE);
        if (after !== null) query = query.gt(key, after);
        const { data: page, error } = await query;
        if (error) throw rpcError(error);
        const got = (page ?? []) as unknown[];
        rows.push(...got);
        if (got.length < PAGE) break;
        const last = got[got.length - 1] as Record<string, unknown>;
        const cursor = last[key];
        // A page of rows whose key cannot be read is a walk that cannot continue, and
        // looping on the same cursor would repeat that page forever. Recorded as an
        // incomplete table, which is what this function does with everything it
        // cannot finish.
        if (typeof cursor !== 'string') {
          throw new Error(`the ${key} of the last row on a page was not readable`);
        }
        after = cursor;
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
