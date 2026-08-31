/**
 * Reading an auth failure for what the reader should do next.
 *
 * Most sign-in errors are answered by trying again. Exactly one is made *worse* by it,
 * and that one had no special handling — which is how the owner of this product spent
 * two hours locked out of it on 2026-08-31, retrying, while a valid session sat one
 * unopened panel away.
 */

/** The shape supabase-js returns; narrowed here so this module needs no auth import. */
export interface AuthErrorLike {
  code?: string;
  message: string;
}

/**
 * Whether the mailbox route is closed for now.
 *
 * Supabase's built-in SMTP counts **requests, not deliveries**, so each retry pushes
 * the window further out. A screen that reports this and offers only "try again" is
 * telling the reader to do the one thing that cannot work — and the longer they
 * believe it, the longer the wait they are creating.
 *
 * `code` is the stable contract and is checked first. The message match is a fallback
 * for GoTrue builds that send no code, and it is deliberately loose: the only
 * consequence of a false positive is that a panel opens which was always safe to open,
 * while a false negative restores the dead end this exists to remove.
 */
export function isEmailRateLimited(error: AuthErrorLike): boolean {
  if (error.code === 'over_email_send_rate_limit') return true;
  return /rate limit/i.test(error.message);
}
