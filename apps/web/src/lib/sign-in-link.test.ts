import { describe, expect, it } from 'vitest';
import { parseSignInLink } from './sign-in-link.js';

/*
 * Every case here is a real string a reader can end up holding, not a shape invented to
 * exercise the parser. The redirect-landing case is the one the whole module exists for:
 * production's Site URL was `http://localhost:3000`, so a *successful* sign-in redirected
 * a real session onto a dead page and the reader was locked out by a hop that worked.
 */

const REF = 'https://zjvfwhjwaytyogdxeddo.supabase.co';

describe('parseSignInLink', () => {
  it('reads a session off the page a wrong Site URL redirected to', () => {
    const got = parseSignInLink(
      'http://localhost:3000/#access_token=eyJhb.ACCESS&expires_in=3600&refresh_token=REFRESH&token_type=bearer&type=magiclink',
    );
    expect(got).toEqual({ kind: 'session', accessToken: 'eyJhb.ACCESS', refreshToken: 'REFRESH' });
  });

  it('refuses a half session rather than minting one that expires in an hour', () => {
    // `setSession` will accept an access token alone and produce a session that cannot
    // refresh. It works, then silently stops working — the worst of both outcomes.
    expect(parseSignInLink('http://localhost:3000/#access_token=ACCESS&expires_in=3600')).toEqual({
      kind: 'unrecognised',
    });
  });

  it('reads the unclicked link straight out of the email', () => {
    const got = parseSignInLink(
      `${REF}/auth/v1/verify?token=pkce_9f2b&type=magiclink&redirect_to=http://localhost:3000`,
    );
    expect(got).toEqual({ kind: 'token-hash', tokenHash: 'pkce_9f2b', type: 'magiclink' });
  });

  it('keeps the type a first-ever link carries, rather than assuming a returning reader', () => {
    // A signup token is not in the table `magiclink` looks in. Defaulting the type would
    // turn a brand-new reader's first click into "invalid or expired".
    expect(parseSignInLink(`${REF}/auth/v1/verify?token=abc&type=signup`)).toMatchObject({
      type: 'signup',
    });
  });

  it("reads this app's own one-click link, address and all", () => {
    expect(parseSignInLink('https://pull-puce.vercel.app/?code=418302&email=a%40b.com')).toEqual({
      kind: 'code',
      code: '418302',
      email: 'a@b.com',
    });
  });

  it('accepts the bare code, because that is what people actually copy', () => {
    expect(parseSignInLink('  418302 ')).toEqual({ kind: 'code', code: '418302', email: null });
  });

  it('un-wraps a URL a mail client broke across lines', () => {
    // Copying from Outlook or Gmail routinely yields exactly this.
    const wrapped = `${REF}/auth/v1/verify?token=pkce_9f2b&type=\n  magiclink`;
    expect(parseSignInLink(wrapped)).toMatchObject({ kind: 'token-hash', type: 'magiclink' });
  });

  it('reports a spent link as spent, in GoTrue’s own terms', () => {
    const got = parseSignInLink(
      'http://localhost:3000/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    );
    expect(got.kind).toBe('error');
    expect(got).toMatchObject({ message: expect.stringContaining('already been used') });
  });

  it('prefers the error to a token sitting beside it on the same address', () => {
    /*
     * Not hypothetical: mail scanners GET the link before the human does, so the reader's
     * click lands on `…/verify?token=…` redirected to `#error=…otp_expired`. Reading the
     * token first would re-submit something GoTrue has already refused and report a
     * second, vaguer failure in place of the true one.
     */
    const got = parseSignInLink(
      `${REF}/auth/v1/verify?token=spent&type=magiclink#error=access_denied&error_code=otp_expired`,
    );
    expect(got.kind).toBe('error');
  });

  it('does not read a fragment as part of the query string', () => {
    expect(parseSignInLink('https://x.test/?code=418302#foo=bar')).toMatchObject({
      code: '418302',
    });
  });

  it('says so plainly when the paste is not a sign-in at all', () => {
    for (const junk of ['', '   ', 'https://pull-puce.vercel.app/', 'what a pull']) {
      expect(parseSignInLink(junk), junk).toEqual({ kind: 'unrecognised' });
    }
  });
});
