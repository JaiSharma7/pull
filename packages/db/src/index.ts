import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

export type { Database } from './database.types.js';
export type Db = SupabaseClient<Database>;

export function createBrowserClient(url: string, anonKey: string): Db {
  return createClient<Database>(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}
