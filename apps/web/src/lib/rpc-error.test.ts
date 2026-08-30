import { describe, expect, it } from 'vitest';
import { rpcError } from './rpc-error.js';

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
