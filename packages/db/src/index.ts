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

export function createBrowserClient(url: string, anonKey: string, storage?: AuthTokenStore): Db {
  return createClient<Database>(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage },
  });
}

// Type-only parity guard between generated enums and their TS mirrors.
export type { EnumParityChecks } from './enum-parity.js';
