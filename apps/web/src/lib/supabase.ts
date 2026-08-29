import { createBrowserClient, type Db } from '@wap/db';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy apps/web/.env.example to apps/web/.env.',
  );
}

export const supabase: Db = createBrowserClient(url, key);
