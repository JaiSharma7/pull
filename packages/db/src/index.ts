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
   * Optional. Omitting it genuinely leaves supabase-js's derived default in place, which
   * takes the conditional spread below to achieve. Passing the same value it would derive
   * changes nothing about the client. `apps/web` passes it so that IT can name the key too — it has to read the
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
      /*
       * Spread rather than named, because `applySettingDefaults` merges by object spread
       * and an explicit `undefined` WINS over supabase-js's derived default -- so writing
       * `storageKey` unconditionally would destroy `sb-<ref>-auth-token` for any caller
       * that omitted it, leaving the key empty and silently disabling the cross-tab
       * BroadcastChannel, which requires a truthy one. `storage` above is safe named
       * because auth-js guards it with a truthiness check instead. Measured in round three
       * of the review on #48.
       */
      ...(storageKey === undefined ? {} : { storageKey }),
    },
  });
}

// Type-only parity guard between generated enums and their TS mirrors.
export type { EnumParityChecks } from './enum-parity.js';
