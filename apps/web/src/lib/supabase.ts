import { createBrowserClient, type Db } from '@wap/db';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  // Both are committed — .env.development for `vite dev`, .env.production for the
  // build — so reaching this means an env file was deleted or Vite ran in a mode that
  // loads neither. Naming both files is the difference between a one-line fix and a
  // blank page with a stack trace pointing at a module that looks fine.
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. ' +
      'These ship in apps/web/.env.development (local stack) and apps/web/.env.production ' +
      '(hosted). Override either in apps/web/.env.local.',
  );
}

export const supabase: Db = createBrowserClient(url, key);

/**
 * Who is signed in right now, tracked at module scope rather than in component
 * state.
 *
 * A background task — the offline drain in particular — has to be able to ask
 * this at any moment, including after the component that started it has gone.
 * Signing out unmounts the whole feed rather than re-rendering it, so anything
 * held in a ref or in React state stops updating at exactly the moment it
 * matters, and a drain still in flight would keep believing the old account was
 * present while writing through a session that is now someone else's.
 */
let currentUserId: string | null = null;

void supabase.auth.getSession().then(({ data }) => {
  currentUserId = data.session?.user.id ?? null;
});

supabase.auth.onAuthStateChange((_event, session) => {
  currentUserId = session?.user.id ?? null;
});

export function getCurrentUserId(): string | null {
  return currentUserId;
}
