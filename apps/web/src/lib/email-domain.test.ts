import { describe, expect, it } from 'vitest';
import { DISPOSABLE_DOMAINS, emailDomain, isDisposableEmail } from './email-domain.js';

/*
 * The asymmetry is the whole design, so it is what the tests are about.
 *
 * A missed throwaway costs one email out of an hourly budget. A false positive tells a
 * real person, on the first screen they ever see, that their own address is not real —
 * and they have no way to argue. Every case below is either "this genuinely is a
 * throwaway service" or "this must never be mistaken for one".
 */

describe('emailDomain', () => {
  it('takes the part after the last @, lowercased', () => {
    expect(emailDomain('  Reader@Example.COM ')).toBe('example.com');
  });

  it('splits on the last @, not the first', () => {
    // Quoted local parts can contain @. Splitting on the first one would read the
    // domain as part of the name and let anything through.
    expect(emailDomain('"odd@name"@mailinator.com')).toBe('mailinator.com');
  });

  it('answers nothing rather than something wrong', () => {
    for (const junk of ['', 'reader', 'reader@', '@example.com', 'reader@localhost', 'a@b.']) {
      expect(emailDomain(junk), junk).toBeNull();
    }
  });
});

describe('isDisposableEmail', () => {
  it('blocks the throwaway services', () => {
    for (const address of ['x@mailinator.com', 'x@yopmail.com', 'x@guerrillamail.com']) {
      expect(isDisposableEmail(address), address).toBe(true);
    }
  });

  it('blocks their subdomains, which is how they are actually handed out', () => {
    // Matching only the exact domain blocks the front door and leaves the windows open.
    expect(isDisposableEmail('x@foo.mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@a.b.yopmail.com')).toBe(true);
  });

  it('does not block a domain that merely ends with one', () => {
    /*
     * The bug a bare `endsWith` would ship. `notmailinator.com` is a different
     * registrable domain from `mailinator.com` and could belong to anyone; the suffix
     * match has to be on a dot boundary or the blocklist quietly grows teeth nobody
     * intended.
     */
    expect(isDisposableEmail('x@notmailinator.com')).toBe(false);
    expect(isDisposableEmail('x@mymaildrop.cc')).toBe(false);
  });

  it('never blocks a mainstream provider or a privacy alias', () => {
    /*
     * The false-positive guard, pinned as a test because the failure is invisible in
     * review — a blocklist that grew one careless entry would turn real readers away at
     * the first screen and nothing would look broken. Aliasing is a privacy choice, and
     * this product asks for an email and nothing else so that choice stays cheap.
     */
    for (const address of [
      'reader@gmail.com',
      'reader@outlook.com',
      'reader@live.com',
      'reader@icloud.com',
      'reader@proton.me',
      'reader@protonmail.com',
      'reader@duck.com',
      'reader@simplelogin.com',
      'reader@fastmail.com',
      'reader@hey.com',
      'reader@my.utexas.edu',
    ]) {
      expect(isDisposableEmail(address), address).toBe(false);
    }
  });

  it('treats an unparseable address as not-disposable, leaving it to the real validator', () => {
    // Refusing here would give the reader the wrong explanation for a typo: "that is a
    // throwaway address" when what they did was miss the dot.
    expect(isDisposableEmail('reader')).toBe(false);
    expect(isDisposableEmail('')).toBe(false);
  });

  it('keeps the list free of anything that is not a throwaway service', () => {
    // A guard on the data rather than the code. The list is the part most likely to be
    // edited casually, and one wrong entry is a silent lockout for real people.
    for (const provider of ['gmail.com', 'outlook.com', 'live.com', 'icloud.com', 'proton.me']) {
      expect(DISPOSABLE_DOMAINS.has(provider), `${provider} is on the blocklist`).toBe(false);
    }
    for (const entry of DISPOSABLE_DOMAINS) {
      expect(entry, `"${entry}" is not a bare lowercase domain`).toMatch(
        /^[a-z0-9-]+(\.[a-z0-9-]+)+$/,
      );
    }
  });
});
