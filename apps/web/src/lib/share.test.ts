import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pullUrl,
  shareCapability,
  shareLabel,
  shareNote,
  shareOrCopy,
  shareTarget,
} from './share.js';

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

/*
 * The outcome, which every caller used to throw away.
 *
 * `navigator` is read at call time rather than imported, which is what lets this
 * run in `environment: 'node'` at all — the global is stubbed per test and
 * removed again, so no test inherits another's browser.
 */
describe('shareOrCopy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const target = { title: 'An idea', text: 'An idea — Walden', url: 'https://x.test/pull/p1' };
  const abortError = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });

  it('hands the whole target to the share sheet where there is one', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share });
    await expect(shareOrCopy(target)).resolves.toBe('shared');
    expect(share).toHaveBeenCalledWith(target);
  });

  it('treats a closed sheet as shared, not as a failure', async () => {
    // Somebody who changed their mind has not hit an error, and telling them
    // "could not share" is worse than saying nothing.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      share: vi.fn().mockRejectedValue(abortError()),
      clipboard: { writeText },
    });
    await expect(shareOrCopy(target)).resolves.toBe('shared');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls through to the clipboard when a browser advertises share and refuses it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      share: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
      clipboard: { writeText },
    });
    await expect(shareOrCopy(target)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(target.url);
  });

  it('copies the address alone, never the headline with it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(shareOrCopy(target)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('https://x.test/pull/p1');
  });

  it('reports a refused clipboard rather than resolving as though it worked', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    await expect(shareOrCopy(target)).resolves.toBe('failed');
  });

  it('reports failure when the browser can do neither', async () => {
    vi.stubGlobal('navigator', {});
    await expect(shareOrCopy(target)).resolves.toBe('failed');
  });
});

describe('shareNote', () => {
  it('confirms the path the reader cannot see', () => {
    // A button that says "Copy link", copies, and says nothing is the same
    // silence as one that failed.
    expect(shareNote('copied')).toBe('Link copied.');
    expect(shareNote('failed')).toContain('Could not copy the link');
  });

  it('adds nothing after a share sheet, which has already answered', () => {
    expect(shareNote('shared')).toBeNull();
  });
});
