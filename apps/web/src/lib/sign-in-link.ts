/**
 * Read a sign-in out of whatever the reader pasted.
 *
 * This exists because of a failure mode that no amount of client code can prevent and
 * that the reader experiences as "the app is broken": **Site URL is hosted configuration
 * this repository cannot push.** If it is wrong, GoTrue still verifies the link, still
 * mints a real session, and then 303-redirects it to an address that does not serve this
 * app. The auth logs record `action: login` and the reader sees a dead page.
 *
 * That is the worst shape a bug can take — everything succeeded except the last hop, so
 * nothing surfaces an error anywhere. The session is *in the address bar* of the page
 * they are looking at, and there is no way to spend it.
 *
 * So: let them paste the address. Every route in gets recognised, because the reader
 * cannot be expected to know which kind of string they are holding:
 *
 * | What they paste                                     | Where it came from                      |
 * | --------------------------------------------------- | --------------------------------------- |
 * | `…/#access_token=…&refresh_token=…`                 | the dead page the redirect landed on    |
 * | `…/auth/v1/verify?token=…&type=magiclink`           | the raw link in the email, unclicked    |
 * | `…/?code=123456&email=…`                            | this app's own one-click email link     |
 * | `123456`                                            | the code, typed or copied               |
 * | `…#error=access_denied&error_code=otp_expired`      | a link a mail scanner already spent     |
 *
 * Pure and separately tested. `history.ts` exists as its own module for exactly this
 * reason — a parser that imports `supabase.js` drags `VITE_SUPABASE_URL` into the test
 * environment and the test fails for a reason that has nothing to do with the parser.
 */

/** What a pasted string turned out to be. */
export type SignInLink =
  /** A complete session, already minted. Spend it with `setSession`. */
  | { kind: 'session'; accessToken: string; refreshToken: string }
  /**
   * The refresh half on its own. Spend it with `refreshSession`.
   *
   * A refresh token alone is enough to mint a whole session, which makes this the one
   * route in that touches no email at all — the way back when the mail itself is the
   * thing that is broken. Supabase's built-in SMTP is rate-limited per hour and counts
   * every request, so a reader who has been retrying a sign-in that silently failed can
   * exhaust it and then be unable to ask for the code that would let them in.
   */
  | { kind: 'refresh'; refreshToken: string }
  /** An unspent link, still hashed. Spend it with `verifyOtp({ token_hash })`. */
  | { kind: 'token-hash'; tokenHash: string; type: string }
  /** A six-digit code. Spend it with `verifyOtp({ email, token })`. */
  | { kind: 'code'; code: string; email: string | null }
  /** GoTrue said no, and said why. */
  | { kind: 'error'; message: string }
  | { kind: 'unrecognised' };

/**
 * The parameters after `#` or `?`, without requiring a parseable URL.
 *
 * `new URL()` throws on a bare fragment, and a reader who copies from a mail client
 * very often gets a fragment, a line-wrapped URL, or a URL with a stray leading space.
 * Refusing those would put the burden of understanding the paste back on the reader,
 * which is the entire problem this module exists to remove.
 */
function params(raw: string, sep: '#' | '?'): URLSearchParams {
  const at = raw.indexOf(sep);
  if (at === -1) return new URLSearchParams();
  let rest = raw.slice(at + 1);
  // A fragment terminates the query string; without this, `?code=1#access_token=x`
  // reads `code` as `1#access_token=x` and the code never matches.
  if (sep === '?') {
    const hash = rest.indexOf('#');
    if (hash !== -1) rest = rest.slice(0, hash);
  }
  return new URLSearchParams(rest);
}

/** GoTrue's own words, made readable. `error_description` arrives `+`-encoded. */
function readError(p: URLSearchParams): string | null {
  const code = p.get('error_code');
  const description = p.get('error_description');
  if (!code && !description && !p.get('error')) return null;
  if (code === 'otp_expired') {
    return 'That link has already been used or has expired. Send yourself a fresh one.';
  }
  return description?.replace(/\+/g, ' ') ?? 'That link did not work. Send yourself a new one.';
}

export function parseSignInLink(raw: string): SignInLink {
  // Mail clients wrap long URLs, and a wrapped URL pastes with newlines inside it.
  const text = raw.trim().replace(/\s+/g, '');
  if (!text) return { kind: 'unrecognised' };

  // Just the digits, which is what a reader copying from the email most often has.
  if (/^\d{6,10}$/.test(text)) return { kind: 'code', code: text, email: null };

  const hash = params(text, '#');
  const query = params(text, '?');

  /*
   * Errors are read before successes, and from both halves.
   *
   * A spent link comes back as `#error=…` on an address that may still carry the
   * original `?token=…` in its query string. Reading the success first would send the
   * reader to `verifyOtp` with a token GoTrue has already rejected — turning a clear
   * "this link was already used" into a second, vaguer failure.
   */
  const failure = readError(hash) ?? readError(query);
  if (failure) return { kind: 'error', message: failure };

  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  if (accessToken && refreshToken) return { kind: 'session', accessToken, refreshToken };
  /*
   * The asymmetry here is deliberate, and it is not a shortcut.
   *
   * A refresh token alone is *more* than enough — `refreshSession` exchanges it for a
   * whole new session, access half included. An access token alone is *less* than
   * enough: `setSession` will take it and produce a session that cannot refresh, so it
   * works and then silently stops working an hour later, which is worse than a clean
   * refusal. So one half is accepted and the other is rejected.
   */
  if (refreshToken) return { kind: 'refresh', refreshToken };

  /*
   * `token_hash` first, then `token`.
   *
   * `token_hash` is what an email template emits from `{{ .TokenHash }}` — the form
   * that lets a link point straight at this app instead of at GoTrue's `/verify`, so
   * no redirect happens and the project's Site URL never enters into it. `token` is
   * the older shape, from a `{{ .ConfirmationURL }}` link copied before it was
   * clicked. Both spend the same way.
   */
  const tokenHash = query.get('token_hash') ?? query.get('token');
  if (tokenHash) {
    // `type` decides which table GoTrue looks in. Defaulting to `magiclink` is right for
    // a returning reader; a first-ever link is `signup` and says so.
    return { kind: 'token-hash', tokenHash, type: query.get('type') ?? 'magiclink' };
  }

  const code = query.get('code')?.trim();
  if (code) return { kind: 'code', code, email: query.get('email')?.trim() || null };

  return { kind: 'unrecognised' };
}
