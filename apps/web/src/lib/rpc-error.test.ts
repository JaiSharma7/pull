import { describe, expect, it } from 'vitest';
import { rpcError, TRANSPORT_ERROR } from './rpc-error.js';
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
