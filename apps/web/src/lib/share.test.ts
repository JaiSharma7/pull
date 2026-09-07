import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pullUrl,
  shareCapability,
  shareLabel,
  shareNote,
  shareOrCopy,
  shareTarget,
  sheetIsNative,
} from './share.js';

/** A device that hands things on with a share sheet, and one that does not. */
const PHONE = { sheetIsNative: true };
const DESKTOP = { sheetIsNative: false };

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

describe('sheetIsNative', () => {
  it('is true only where the primary pointer is coarse', () => {
    expect(sheetIsNative({ matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }) })).toBe(
      true,
    );
    expect(sheetIsNative({ matchMedia: () => ({ matches: false }) })).toBe(false);
  });

  it('answers no where the question cannot be asked', () => {
    // `environment: 'node'`, an old browser, a locked-down embedder. Copying a
    // link is the safe direction: the worst it does is ask for a paste.
    expect(sheetIsNative({})).toBe(false);
  });
});

describe('shareCapability and shareLabel', () => {
  it('prefers the share sheet on a device that has one', () => {
    const cap = shareCapability({ share: () => {}, clipboard: { writeText: () => {} } }, PHONE);
    expect(cap).toEqual({ canShare: true, canCopy: true });
    expect(shareLabel(cap)).toBe('Share');
  });

  /*
   * The bug this file exists to keep fixed.
   *
   * Windows advertises `navigator.share` and answers it with a system flyout that
   * takes focus and does not always give it back. The button copies there instead.
   */
  it('refuses the share sheet on a desktop that advertises one', () => {
    const cap = shareCapability({ share: () => {}, clipboard: { writeText: () => {} } }, DESKTOP);
    expect(cap).toEqual({ canShare: false, canCopy: true });
    expect(shareLabel(cap)).toBe('Copy link');
  });

  it('says "Copy link" when that is what will actually happen', () => {
    // A button that says "Share" and silently copies is a small lie.
    const cap = shareCapability({ clipboard: { writeText: () => {} } }, PHONE);
    expect(shareLabel(cap)).toBe('Copy link');
  });

  it('degrades to a plain label when the browser can do neither', () => {
    expect(shareLabel(shareCapability({}, PHONE))).toBe('Link');
  });

  it('is not fooled by a non-function share property', () => {
    expect(shareCapability({ share: true, clipboard: { writeText: 'nope' } }, PHONE)).toEqual({
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

  /** Both halves of the device, because the pointer now decides as much as the API does. */
  function stubDevice(nav: object, coarse: boolean): void {
    vi.stubGlobal('navigator', nav);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: coarse && q === '(pointer: coarse)' }));
  }

  it('hands the whole target to the share sheet on a phone', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubDevice({ share }, true);
    await expect(shareOrCopy(target)).resolves.toBe('shared');
    expect(share).toHaveBeenCalledWith(target);
  });

  /*
   * The reported bug, end to end: a desktop share sheet is never opened, however
   * loudly the browser advertises one. On Windows it takes the focus and does not
   * reliably give it back, and `share()` never settles, so there is nothing this
   * code could do about it afterwards.
   */
  it('never opens the sheet on a desktop, even where one is offered', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubDevice({ share, clipboard: { writeText } }, false);
    await expect(shareOrCopy(target)).resolves.toBe('copied');
    expect(share).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(target.url);
  });

  it('treats a closed sheet as shared, not as a failure', async () => {
    // Somebody who changed their mind has not hit an error, and telling them
    // "could not share" is worse than saying nothing.
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubDevice({ share: vi.fn().mockRejectedValue(abortError()), clipboard: { writeText } }, true);
    await expect(shareOrCopy(target)).resolves.toBe('shared');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls through to the clipboard when a browser advertises share and refuses it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubDevice(
      { share: vi.fn().mockRejectedValue(new Error('NotAllowedError')), clipboard: { writeText } },
      true,
    );
    await expect(shareOrCopy(target)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(target.url);
  });

  it('copies the address alone, never the headline with it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubDevice({ clipboard: { writeText } }, true);
    await expect(shareOrCopy(target)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('https://x.test/pull/p1');
  });

  it('reports a refused clipboard rather than resolving as though it worked', async () => {
    stubDevice({ clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } }, true);
    await expect(shareOrCopy(target)).resolves.toBe('failed');
  });

  it('reports failure when the browser can do neither', async () => {
    stubDevice({}, true);
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
