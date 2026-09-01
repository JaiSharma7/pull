import { describe, expect, it } from 'vitest';
import { pullUrl, shareCapability, shareLabel, shareTarget } from './share.js';

describe('pullUrl', () => {
  it('builds the canonical address', () => {
    expect(pullUrl('https://whatapull.com', 'abc')).toBe('https://whatapull.com/pull/abc');
  });

  it('does not double the slash when the origin carries one', () => {
    expect(pullUrl('https://whatapull.com/', 'abc')).toBe('https://whatapull.com/pull/abc');
    expect(pullUrl('https://whatapull.com///', 'abc')).toBe('https://whatapull.com/pull/abc');
  });

  it('encodes the id rather than trusting it', () => {
    expect(pullUrl('https://x.test', 'a b/c')).toBe('https://x.test/pull/a%20b%2Fc');
  });
});

describe('shareTarget', () => {
  it('names the source alongside the idea', () => {
    expect(
      shareTarget({
        origin: 'https://x.test',
        pullId: 'p1',
        headline: 'An idea',
        workTitle: 'Walden',
      }),
    ).toEqual({
      title: 'An idea',
      text: 'An idea — Walden',
      url: 'https://x.test/pull/p1',
    });
  });

  it('omits the dash when there is no source to name', () => {
    expect(
      shareTarget({ origin: 'https://x.test', pullId: 'p1', headline: 'An idea', workTitle: null })
        .text,
    ).toBe('An idea');
  });
});

describe('shareCapability and shareLabel', () => {
  it('prefers the share sheet where there is one', () => {
    const cap = shareCapability({ share: () => {}, clipboard: { writeText: () => {} } });
    expect(cap).toEqual({ canShare: true, canCopy: true });
    expect(shareLabel(cap)).toBe('Share');
  });

  it('says "Copy link" when that is what will actually happen', () => {
    // A button that says "Share" and silently copies is a small lie.
    const cap = shareCapability({ clipboard: { writeText: () => {} } });
    expect(shareLabel(cap)).toBe('Copy link');
  });

  it('degrades to a plain label when the browser can do neither', () => {
    expect(shareLabel(shareCapability({}))).toBe('Link');
  });

  it('is not fooled by a non-function share property', () => {
    expect(shareCapability({ share: true, clipboard: { writeText: 'nope' } })).toEqual({
      canShare: false,
      canCopy: false,
    });
  });
});
