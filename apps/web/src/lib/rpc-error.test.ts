import { describe, expect, it } from 'vitest';
import { isPermanentFailure, isSchemaMismatch, rpcError, TRANSPORT_ERROR } from './rpc-error.js';
import { isOfflineFailure } from './offline.js';

/**
 * The bug this guards against reached a real screen: the feed rendered
 * "Could not load the feed: [object Object]" because supabase-js rejects with a
 * plain object and the catch site tested `instanceof Error`.
 *
 * The assertion that matters is not "returns an Error" — it is that the message
 * a reader sees never becomes "[object Object]".
 */
describe('rpcError', () => {
  const postgrest = {
    message: 'permission denied for function get_feed',
    details: null,
    hint: null,
    code: '42501',
  };

  it('turns a PostgREST error object into a real Error', () => {
    const e = rpcError(postgrest);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('permission denied for function get_feed');
  });

  it('never produces [object Object] for any shape a caller might throw', () => {
    for (const input of [postgrest, {}, null, undefined, { code: '23505' }, 'plain string']) {
      const message = rpcError(input).message;
      expect(message).not.toContain('[object Object]');
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('keeps the SQLSTATE reachable, since callers branch on it', () => {
    expect(rpcError(postgrest).name).toBe('PostgrestError 42501');
    expect(rpcError({ message: 'x' }).name).toBe('PostgrestError');
  });

  it('joins details and hint so the useful half is not dropped', () => {
    const e = rpcError({
      message: 'insert violates policy',
      details: 'Failing row contains (1, null)',
      hint: 'Check the RLS policy on saved_items',
    });
    expect(e.message).toContain('insert violates policy');
    expect(e.message).toContain('Failing row contains');
    expect(e.message).toContain('Check the RLS policy');
  });

  it('passes a real Error through untouched, so stacks survive', () => {
    const original = new Error('network down');
    expect(rpcError(original)).toBe(original);
  });
});

/**
 * The seam where "could not reach the server" survives, or does not.
 *
 * postgrest-js catches a `fetch` rejection and *resolves* with an error object, so
 * the original `TypeError` becomes a string inside a message. A downstream
 * `instanceof TypeError` therefore never matches — and an offline check written that
 * way is dead code that passes its own unit test in isolation while doing nothing on
 * the real path.
 *
 * These assert the two ends together, because testing either alone is what let that
 * ship: `rpcError` marking transport failures, and `isOfflineFailure` recognising the
 * mark. Wired end to end, a reader on a flaky connection gets their cached Pulls
 * instead of an error, which is what law 3 promised them.
 */
describe('a request that never reached the server', () => {
  /** What postgrest-js actually resolves with when fetch rejects. */
  const transport = {
    message: 'TypeError: Failed to fetch',
    details: 'TypeError: Failed to fetch',
    hint: '',
    code: '',
  };

  it('is marked as a transport failure rather than a Postgres one', () => {
    expect(rpcError(transport).name).toBe(TRANSPORT_ERROR);
  });

  it('is recognised as offline once marked', () => {
    // The end-to-end assertion. Before this, `isOfflineFailure` saw a plain Error
    // named 'PostgrestError' and said no — so the feed showed an error screen while
    // the reader's downloaded Pulls sat unread in IndexedDB.
    expect(isOfflineFailure(rpcError(transport))).toBe(true);
  });

  it('does not mistake a refused request for an unreachable one', () => {
    // The distinction that matters: this arrived, and Postgres said no. It carries a
    // SQLSTATE, must keep it, and must reach the reader as something retryable
    // rather than as a shrug about their connection.
    const refused = {
      message: 'permission denied for function get_feed',
      details: null,
      hint: null,
      code: '42501',
    };
    expect(rpcError(refused).name).toBe('PostgrestError 42501');
    expect(isOfflineFailure(rpcError(refused))).toBe(false);
  });

  it('does not treat a missing code as a transport failure', () => {
    // `code: ''` is PostgREST saying "never reached Postgres". An absent code is a
    // different, vaguer thing and must not be read as the same claim.
    expect(rpcError({ message: 'TypeError: Failed to fetch' }).name).toBe('PostgrestError');
  });

  it('requires the message to name a transport error, not merely mention one', () => {
    // A Postgres error whose text happens to contain the word would otherwise be
    // misfiled, and the reader would be told to check a connection that is fine.
    const mentions = { message: 'function raised: TypeError somewhere', code: '' };
    expect(rpcError(mentions).name).toBe('PostgrestError');
  });
});

describe('isSchemaMismatch', () => {
  it('recognises the SQLSTATE for a column that does not exist', () => {
    // The exact shape the hosted project returned on 2026-09-01, seven migrations
    // behind a frontend that had already shipped the query.
    expect(
      isSchemaMismatch({
        code: '42703',
        message: 'column works.source_url does not exist',
      }),
    ).toBe(true);
  });

  it('recognises PostgREST catching it a layer earlier, where there is no SQLSTATE', () => {
    expect(
      isSchemaMismatch({
        code: 'PGRST204',
        message: "Could not find the 'source_url' column of 'works' in the schema cache",
      }),
    ).toBe(true);
  });

  it('covers the table and function cases, not just the column one', () => {
    /*
     * The same deploy gap produces these. 20260901140000, 150000 and 190000 add
     * functions the hosted project does not have, so an account screen reaching
     * `delete_my_account` lands here exactly as a source page reaching `source_url`
     * does — and before this it fell through to "something went wrong".
     */
    for (const code of ['42P01', '42883', 'PGRST202']) {
      expect(isSchemaMismatch({ code, message: 'missing' }), code).toBe(true);
      expect(isSchemaMismatch(rpcError({ code, message: 'missing' })), code).toBe(true);
    }
  });

  it('survives the round trip through rpcError, which is how callers actually see it', () => {
    /*
     * The catch sites hold an `Error`, not the wire object — `rpcError` folds the
     * SQLSTATE into `name` and there is nowhere else for it to have gone. A check
     * that only understood the raw shape would be dead code at every call site.
     */
    expect(isSchemaMismatch(rpcError({ code: '42703', message: 'column x does not exist' }))).toBe(
      true,
    );
    expect(isSchemaMismatch(rpcError({ code: 'PGRST204', message: 'schema cache' }))).toBe(true);
  });

  it('leaves every other failure alone', () => {
    /*
     * The guard against over-matching, and it matters more here than usual: this
     * message tells the reader nothing is wrong with their request and sends the
     * operator to run a migration. Saying it about an ordinary permission failure
     * would send them somewhere there is nothing to fix.
     */
    for (const e of [
      { code: '42501', message: 'permission denied for table works' },
      { code: '23505', message: 'duplicate key value violates unique constraint' },
      { code: 'PGRST116', message: 'JSON object requested, multiple rows returned' },
      { code: '', message: 'TypeError: Failed to fetch' },
      { message: 'no code at all' },
    ]) {
      expect(isSchemaMismatch(e), e.message).toBe(false);
      expect(isSchemaMismatch(rpcError(e)), e.message).toBe(false);
    }
  });

  it('is false for anything that is not an error shape', () => {
    expect(isSchemaMismatch(null)).toBe(false);
    expect(isSchemaMismatch(undefined)).toBe(false);
    expect(isSchemaMismatch(new Error('plain'))).toBe(false);
  });
});

describe('isPermanentFailure', () => {
  it('recognises a refusal that a retry cannot change', () => {
    for (const code of ['23503', '23514', '22P02']) {
      expect(isPermanentFailure({ code, message: 'refused' })).toBe(true);
      expect(isPermanentFailure(rpcError({ code, message: 'refused' }))).toBe(true);
    }
  });

  it('does not treat an RLS refusal as permanent, because anon gets one too', () => {
    // A request whose session refresh failed goes out with only the publishable
    // key, and RLS answers 42501 exactly as it would for an account that may never
    // do this. The code cannot tell those apart, so a queue drained in that minute
    // would be emptied for good. Kept, it lands once the session is back.
    expect(isPermanentFailure({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isPermanentFailure(rpcError({ code: '42501', message: 'denied' }))).toBe(false);
  });

  it('treats everything it does not know as transient', () => {
    // The direction of the error matters: a wrong "permanent" loses something the
    // reader did; a wrong "transient" costs a retry.
    expect(isPermanentFailure({ code: '', message: 'TypeError: Failed to fetch' })).toBe(false);
    expect(isPermanentFailure({ code: '57014', message: 'canceling statement' })).toBe(false);
    expect(isPermanentFailure({ code: 'PGRST301', message: 'JWT expired' })).toBe(false);
    expect(isPermanentFailure({ code: '42703', message: 'column does not exist' })).toBe(false);
    expect(isPermanentFailure(new Error('plain'))).toBe(false);
    expect(isPermanentFailure(null)).toBe(false);
  });
});
