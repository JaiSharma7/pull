import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

export type { Database } from './database.types.js';
export type Db = SupabaseClient<Database>;

/**
 * Where the auth token is kept.
 *
 * Optional, and omitting it keeps supabase-js's default (`localStorage`), which is what
 * "stay signed in" means and what a reader with an address wants. `apps/web` passes one
 * because a guest session must not survive the browser closing — see
 * `apps/web/src/lib/guest-storage.ts`, where that policy and its reasoning live. It is
 * not decided here: this factory knows how to build a client, not what a guest is.
 */
export interface AuthTokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createBrowserClient(
  url: string,
  anonKey: string,
  storage?: AuthTokenStore,
  /**
   * Optional, and passing the same value supabase-js would derive changes nothing about
   * the client. `apps/web` passes it so that IT can name the key too — it has to read the
   * stored token back to tell a session this tab actually holds from one another tab
   * broadcast to it. Deriving the same string in two places without pinning it is how the
   * two quietly stop agreeing.
   */
  storageKey?: string,
): Db {
  return createClient<Database>(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage,
      storageKey,
    },
  });
}

// Type-only parity guard between generated enums and their TS mirrors.
export type { EnumParityChecks } from './enum-parity.js';
