import { createBrowserClient, type Db } from '@wap/db';
import { browserAuthStorage } from './guest-storage.js';

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

/*
 * A dev server may not talk to a hosted project without saying so out loud.
 *
 * This repository is public, and `.env.production` carries the hosted URL and the
 * publishable key — correctly, since both ship in the bundle every visitor already
 * downloads. The consequence is that a contributor who copies the wrong env file, or
 * runs `vite dev --mode production` to reproduce something, is developing against
 * live reader data: their test saves land in someone's Library, their `record_read`
 * calls move a stranger's knowledge states, and a stray delete is not undoable.
 *
 * RLS keeps them inside their own account, so this is not a confidentiality control.
 * It is about not writing to production by accident, which no policy can prevent
 * because every one of those writes is a thing the account is allowed to do.
 *
 * `import.meta.env.DEV` is true only under `vite dev`, so a production build is
 * unaffected. The opt-out exists because pointing a dev server at a staging project
 * is legitimate; what is not legitimate is doing it without having decided to.
 */
if (
  import.meta.env.DEV &&
  !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url) &&
  import.meta.env.VITE_ALLOW_REMOTE_SUPABASE !== 'true'
) {
  throw new Error(
    `Refusing to start a dev server against ${url}, which is not the local stack.\n\n` +
      'Run `pnpm db:start` and use the committed apps/web/.env.development, or set\n' +
      'VITE_ALLOW_REMOTE_SUPABASE=true in apps/web/.env.local if you mean it. Writes from\n' +
      'a dev server reach real readers, and RLS cannot tell them apart from real use.',
  );
}

/*
 * A guest's token goes to `sessionStorage` and everybody else's to `localStorage`, so a
 * guest session ends with the browser the way an incognito window does. The reasoning,
 * and what it costs, are in `guest-storage.ts`.
 *
 * `browserAuthStorage()` reaches for the accessors lazily rather than taking them as
 * arguments here. That is not style: in a browser with site data blocked, naming
 * `globalThis.localStorage` throws, and this line runs at module scope before anything
 * has rendered.
 */
export const supabase: Db = createBrowserClient(url, key, browserAuthStorage());

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

// `void` silences the lint rule, not the rejection. supabase-js rethrows anything
// that is not an AuthError — a DNS failure, a wedged Web Lock — and this runs at
// module scope, so without the catch that surfaces as an uncaught promise rejection
// before the app has rendered anything. The listener below recovers the value the
// moment auth resolves, so there is nothing to do here but decline to crash.
void supabase.auth
  .getSession()
  .then(({ data }) => {
    currentUserId = data.session?.user.id ?? null;
  })
  .catch(() => {
    currentUserId = null;
  });

supabase.auth.onAuthStateChange((_event, session) => {
  currentUserId = session?.user.id ?? null;
});

export function getCurrentUserId(): string | null {
  return currentUserId;
}
