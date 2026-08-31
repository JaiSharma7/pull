/**
 * Refuse a throwaway address before it costs an email.
 *
 * Supabase's built-in SMTP is **rate-limited per hour and counts every request**, not
 * every delivery. That makes the send budget a shared resource between real readers and
 * anyone pointing a script at the sign-in form: a few dozen `signInWithOtp` calls to
 * `mailinator.com` addresses exhaust the hour, and the next genuine reader — the owner
 * included — is told to wait with no way to shorten it.
 *
 * So the cheapest place to stop a throwaway signup is **before the request is made**.
 * A refusal here costs nothing and consumes none of the budget.
 *
 * **This is not the enforcement layer.** Anything in the browser can be bypassed by not
 * using the browser, and a script hitting the Auth endpoint directly never runs a line
 * of it. The real block is the `BEFORE INSERT` trigger on `auth.users`
 * (`20260831180000_block_disposable_signup_domains`), which no client can route around.
 * This module exists to protect the send budget and to give a person a straight answer
 * immediately rather than after a round trip; the database exists to be right.
 *
 * Pure, and separately tested, for the reason `history.ts` is: a module that imports
 * `supabase.js` drags `VITE_SUPABASE_URL` into the test environment and fails for
 * reasons that have nothing to do with what it does.
 */

/**
 * Domains that exist to be thrown away.
 *
 * Kept short and high-confidence on purpose. A blocklist is a promise that everything on
 * it is disposable, and the cost of being wrong is asymmetric in the worst direction:
 * a false positive turns a real person away from the product at the first screen, with
 * a message telling them their own address is not real. A missed throwaway costs one
 * email. So the bar for adding an entry is that the domain's *stated purpose* is
 * temporary mail — never that it merely looks unfamiliar or is popular with spam.
 *
 * Deliberately excludes every mainstream provider and every alias service people use as
 * their actual address — `gmail.com`, `proton.me`, `icloud.com`, `duck.com`,
 * `simplelogin.com`, `fastmail.com`, university and company domains. Hiding behind an
 * alias is a privacy choice, not an attack, and this product asks for an email and
 * nothing else precisely so that choice stays cheap.
 *
 * The database copy in the migration is the authoritative list; this one is the fast
 * path. They are seeded from the same set and drift is a bug — if you add here, add
 * there in the same commit.
 */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  '0-mail.com',
  '10minutemail.com',
  '20minutemail.com',
  'anonbox.net',
  'burnermail.io',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'harakirimail.com',
  'inboxbear.com',
  'incognitomail.com',
  'jetable.org',
  'mail-temporaire.fr',
  'mail7.io',
  'mailcatch.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mailsac.com',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'mytemp.email',
  'nowmymail.com',
  'sharklasers.com',
  'spam4.me',
  'spamgourmet.com',
  'temp-mail.io',
  'temp-mail.org',
  'tempail.com',
  'tempinbox.com',
  'tempmail.net',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.de',
  'trbvm.com',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
]);

/**
 * The domain part, lowercased — or null when the address is not one.
 *
 * Not a validity check: `<input type="email">` and the Auth endpoint both do that, and
 * duplicating an email grammar here would be a third opinion about what an address is.
 * This only needs to answer "what comes after the last `@`", and to answer *nothing*
 * rather than something wrong when there is no sensible answer.
 */
export function emailDomain(email: string): string | null {
  const at = email.trim().toLowerCase().lastIndexOf('@');
  if (at <= 0) return null;
  const domain = email
    .trim()
    .toLowerCase()
    .slice(at + 1);
  // A domain needs a dot and something either side of it. Anything else is a typo, and
  // treating a typo as a blocked domain would give the reader the wrong explanation.
  if (!/^[^\s@.]+(\.[^\s@.]+)+$/.test(domain)) return null;
  return domain;
}

/**
 * Whether this address is a throwaway.
 *
 * Subdomains count: the throwaway services hand out `foo.mailinator.com` and
 * `x.yopmail.com` freely, so matching only the exact domain blocks the front door and
 * leaves every window open. Matching on a suffix boundary — `.` before the entry, never
 * a bare `endsWith` — is what keeps `notmailinator.com` and `mymaildrop.cc` out of it.
 */
export function isDisposableEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (domain === null) return false;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  for (const blocked of DISPOSABLE_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}
