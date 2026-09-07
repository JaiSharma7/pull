import { normaliseHandle } from './handle.js';
import { rpcError, sqlState } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * The reader's own profile row, and the one thing they can change about it.
 *
 * `profiles_read_own` and `profiles_write_own` mean this is a plain PostgREST read
 * of one row — there is no directory to page and nothing to look up about anybody
 * else. That is deliberate and is law 5's shape for this table: a public profile is
 * a decision someone makes, not the absence of a policy.
 *
 * The write goes through `claim_handle` rather than a `PATCH`, because a username is
 * the one column where the interesting cases are all failures — taken, reserved,
 * mis-shaped — and each needs a sentence rather than a constraint name. See
 * 20260906090000.
 */

export interface Profile {
  handle: string;
  displayName: string | null;
  /**
   * When the reader chose this name. Null means the database made one up at sign-up
   * and has never asked — which is the whole question the username screen answers.
   */
  handleSetAt: string | null;
}

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('handle, display_name, handle_set_at')
    .eq('id', userId)
    // `maybeSingle`, not `single`: a missing row is a state this app can be in for a
    // moment — `handle_new_user` runs on the auth insert, and a reader whose profile
    // failed to create should see the app rather than an error about a table.
    .maybeSingle();
  if (error) throw rpcError(error);
  if (!data) return null;
  return {
    handle: data.handle,
    displayName: data.display_name,
    handleSetAt: data.handle_set_at,
  };
}

/** The SQLSTATEs `claim_handle` raises with a message written for a reader. */
const SPEAKABLE = ['22023', '23505', '42501'];

/**
 * Claim a username, and report a refusal in words.
 *
 * The messages come from the function itself, which is why they are shown as they
 * arrive: every one of them was written to be read by the person who typed the name.
 * Anything else — a transport failure, a schema that has not been pushed yet — gets
 * this module's own sentence, because Postgres's version of those names an index or a
 * relation and asks the reader to care about it.
 */
export async function claimHandle(handle: string): Promise<string> {
  const { data, error } = await supabase.rpc('claim_handle', {
    new_handle: normaliseHandle(handle),
  });
  if (error) {
    const wrapped = rpcError(error);
    const code = sqlState(error);
    if (code !== undefined && SPEAKABLE.includes(code)) throw wrapped;
    throw new Error('Could not save that username. Try again in a moment.', { cause: wrapped });
  }
  return data;
}
