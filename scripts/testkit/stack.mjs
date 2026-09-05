/**
 * Where the test accounts live, and the one credential that can create them.
 *
 * Creating a user, minting a sign-in link for one, and backdating its history are all
 * admin operations: they need the secret key, which law 7 says belongs in exactly one
 * place and never in a file. So this reads it from `supabase status` at the moment it
 * is needed and keeps it in memory. Nothing here writes a credential to disk, and the
 * recorder never sees one either — it is handed a single-use sign-in link instead.
 *
 * The loopback check is the other half. `supabase status` reports whatever stack is
 * linked, and a linked project would hand this script a *hosted* secret key: the same
 * script that deletes and rebuilds `reader@pull.test` on a laptop would then delete and
 * rebuild a real account. That is the failure `src/lib/supabase.ts` guards the dev
 * server against, and it is worse here, because a secret key is not bounded by RLS.
 * There is deliberately no opt-out flag.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUPABASE = join(ROOT, 'node_modules', '.bin', 'supabase');

/** RFC 2606 reserves `.test`, so a persona's address can never route anywhere real. */
export const PERSONA_DOMAIN = 'pull.test';

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/;

/**
 * The running local stack, or a readable reason why there isn't one.
 *
 * `supabase status -o json` prints a line about stopped services before the JSON, so
 * the object is taken from the first brace rather than by parsing the whole stream.
 */
export function localStack() {
  let raw;
  try {
    raw = execFileSync(SUPABASE, ['status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('No local Supabase stack is running. Start one with `pnpm db:start`.');
  }

  const brace = raw.indexOf('{');
  if (brace < 0) throw new Error(`Could not read \`supabase status\`:\n${raw}`);
  const status = JSON.parse(raw.slice(brace));

  if (!LOOPBACK.test(status.API_URL ?? '')) {
    throw new Error(
      `Refusing to run against ${status.API_URL}, which is not the local stack.\n\n` +
        'This script holds a secret key and deletes accounts by address. Against a hosted\n' +
        'project that is a real reader’s account, and RLS does not bound a secret key.\n' +
        'Unlink the project (`supabase unlink`) or run this on a laptop stack.',
    );
  }

  return {
    apiUrl: status.API_URL,
    dbUrl: status.DB_URL,
    mailUrl: status.MAILPIT_URL ?? status.INBUCKET_URL,
    publishableKey: status.PUBLISHABLE_KEY,
    secretKey: status.SECRET_KEY,
  };
}

/** A call to GoTrue's admin API. Secret key, so: this file and callers in this file only. */
export async function admin(stack, path, body, method = 'POST') {
  const res = await fetch(`${stack.apiUrl}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: stack.secretKey,
      Authorization: `Bearer ${stack.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`auth ${path} → ${res.status} ${text}`);
  return json;
}

/**
 * A single-use sign-in link for a persona, as the app's own email would carry it.
 *
 * `generate_link` returns the `hashed_token` that `{{ .TokenHash }}` renders, which is
 * what `readUrlToken` in Auth.tsx already knows how to spend. So the recorder signs in
 * by opening `/?token_hash=…&type=magiclink` and the app runs its real `verifyOtp`
 * path — no injected session, no test-only branch in the app, and no mailbox to poll.
 *
 * Single-use, so mint one per sign-in rather than caching.
 */
export async function signInLink(stack, email) {
  const link = await admin(stack, 'admin/generate_link', { type: 'magiclink', email });
  return { tokenHash: link.hashed_token, code: link.email_otp };
}

/** The same token spent server-side, for seeding a persona through the app's own RPCs. */
export async function sessionFor(stack, email) {
  const { tokenHash } = await signInLink(stack, email);
  const res = await fetch(`${stack.apiUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: stack.publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
  const session = await res.json();
  if (!res.ok || !session.access_token) {
    throw new Error(`Could not open a session for ${email}: ${JSON.stringify(session)}`);
  }
  return { accessToken: session.access_token, userId: session.user.id };
}

/**
 * PostgREST as the persona, not as an admin.
 *
 * Seeding goes through the same RPCs and tables the app calls, under the persona's own
 * token, so every row a persona ends up with is a row RLS would have allowed them to
 * write. A fixture built with the secret key can be a state no reader could reach, and
 * then the bug it reproduces is not one either.
 */
export async function asReader(
  stack,
  accessToken,
  path,
  { method = 'POST', body, headers = {} } = {},
) {
  const res = await fetch(`${stack.apiUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: stack.publishableKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rest ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
