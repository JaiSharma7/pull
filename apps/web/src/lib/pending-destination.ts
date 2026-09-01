/**
 * The destination a sign-in was started from, remembered across the email.
 *
 * `?next=` carries the address through the in-tab flow: a reader on
 * `/source/x#p-y` presses "Sign in to keep these", lands on `/?next=/source/x…`,
 * types the code, and `App.arrive` spends the parameter still sitting in the
 * address bar.
 *
 * The one-click path is not that path, and a Codex review caught it. The magic
 * link in `supabase/templates/magic_link.html` deliberately does NOT route
 * through `.ConfirmationURL` — it hardcodes
 * `…/auth/confirm?token_hash={{ .TokenHash }}` precisely so a misconfigured
 * hosted Site URL cannot break sign-in, and that comment explains at length why.
 * The cost, unnoticed until now, is that `emailRedirectTo` reaches nothing: the
 * link has no `next`, so a reader who clicks it is signed in correctly and
 * dropped on the feed, having lost the idea they were reading.
 *
 * WHY THIS AND NOT A TEMPLATE VARIABLE. Appending `&next={{ .RedirectTo }}`
 * would put a full absolute URL in the parameter, and `safeNext` rejects
 * absolute URLs on purpose — that rejection is the open-redirect guard. Relaxing
 * it to accept "absolute but same-origin" would widen the exact surface the
 * guard exists to narrow, to buy something the device already knows.
 *
 * So the destination never leaves the device. It is written here when the email
 * is sent and read back when the session arrives, and it is still passed through
 * `safeNext` afterwards — this is a fallback for a missing parameter, not a
 * second way to bypass the check on one.
 *
 * localStorage rather than sessionStorage because the link usually opens a NEW
 * TAB, and a new tab gets an empty sessionStorage. The honest limit is that a
 * link opened in a different browser, or on a different device, still lands on
 * the feed — nothing carried in this direction could help there, which is why
 * the template offers the typed code first and why that path already worked.
 */

const KEY = 'wap:pending-destination';

/**
 * How long a remembered destination stays worth honouring.
 *
 * Fifteen minutes, matched to roughly the life of a magic link rather than
 * picked for roundness. The failure this bounds is small but real: a reader
 * starts a sign-in from a source page, abandons it, and signs in from the front
 * door days later — without a TTL they would be thrown to an idea they have
 * forgotten asking for, by a mechanism invisible to them.
 */
export const PENDING_TTL_MS = 15 * 60 * 1000;

interface Stored {
  to: string;
  at: number;
}

/**
 * Remember where to return, if there is anywhere worth returning to.
 *
 * A null or empty destination CLEARS rather than storing, so a sign-in started
 * from the front door erases a destination left by an earlier one. Without that,
 * the previous attempt's address would outlive it and redirect a reader who
 * asked for nothing.
 */
export function rememberDestination(to: string | null, now: number = Date.now()): void {
  try {
    if (!to) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify({ to, at: now } satisfies Stored));
  } catch {
    // Blocked site data. The in-tab flow still carries `?next=`; only the
    // cross-tab one degrades, and it degrades to today's behaviour.
  }
}

/**
 * Read it back, once.
 *
 * Every exit clears the key — expired, malformed, or spent. A destination that
 * survives being read is one that can fire a second time, on a later sign-in
 * that asked for somewhere else.
 *
 * Returns the raw stored string. The caller passes it through `safeNext`; this
 * module deliberately does not, so there is exactly one place in the app that
 * decides what a safe destination is.
 */
export function takeDestination(now: number = Date.now()): string | null {
  // No initialiser: every path that reaches the read below has assigned it, and
  // the `catch` returns rather than falling through. eslint 10's
  // `no-useless-assignment` is right that a `= null` here is dead.
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Stored).to !== 'string' ||
      typeof (parsed as Stored).at !== 'number'
    ) {
      return null;
    }
    const { to, at } = parsed as Stored;
    // `now - at` rather than an absolute comparison: a clock that moved
    // backwards produces a negative age, which must read as "not fresh" rather
    // than as a very old entry that happens to pass a one-sided test.
    const age = now - at;
    if (age < 0 || age > PENDING_TTL_MS) return null;
    return to;
  } catch {
    return null;
  }
}
