#!/usr/bin/env node
/**
 * A link that signs you in as a persona, for driving the app by hand.
 *
 *   pnpm personas:link reader
 *   pnpm personas:link reader --base=http://192.168.1.24:5173     # a phone on the LAN
 *
 * The recorder mints its own; this is for the other half of the work, where a person
 * looks at the thing on a real device. Print it, open it on the phone, and the app runs
 * its ordinary `verifyOtp` path — the persona has a session in Safari, with its three
 * weeks of history, and nothing in the app knows it was a test.
 *
 * Single-use and short-lived: `otp_expiry` is ten minutes (supabase/config.toml), and
 * spending it once spends it. Run this again rather than saving one.
 */
import { personaByKey } from './personas.mjs';
import { localStack, signInLink } from './stack.mjs';

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith('--'));
const base = (args.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:5173').slice(7);

if (!key) {
  console.error('Usage: pnpm personas:link <persona> [--base=http://…]');
  process.exit(1);
}

const persona = personaByKey(key);
if (persona.guest) {
  console.log(
    'The visitor persona has no account — press “Look around as a guest” on the sign-in screen.',
  );
  process.exit(0);
}

const stack = localStack();
const { tokenHash, code } = await signInLink(stack, persona.email);

console.log(`${persona.label} — ${persona.email}\n`);
console.log(`${base}/?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink\n`);
console.log(`Or type the code ${code} on the sign-in screen after asking for one.`);
console.log('Single-use, and it expires in ten minutes.');
