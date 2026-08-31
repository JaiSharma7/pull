import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyFocus,
  enterFullscreen,
  exitFullscreen,
  fullscreenSupported,
  readStoredFocus,
  storeFocus,
} from './focus-mode.js';

/** A stand-in for documentElement that records what was done to it. */
function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applyFocus', () => {
  it('sets the attribute on, and removes it off', () => {
    const root = fakeRoot();
    applyFocus(true, root);
    expect(root.attrs.get('data-focus')).toBe('on');

    applyFocus(false, root);
    // Removed, not set to "off". A present-but-off attribute invites a selector that
    // matches `[data-focus]` and is then true in a state nobody intended.
    expect(root.attrs.has('data-focus')).toBe(false);
  });
});

describe('readStoredFocus', () => {
  it('is off when nothing is stored', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    expect(readStoredFocus()).toBe(false);
  });

  it('is on only for the exact stored value', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'on', setItem: () => {} });
    expect(readStoredFocus()).toBe(true);
    vi.stubGlobal('localStorage', { getItem: () => 'true', setItem: () => {} });
    expect(readStoredFocus()).toBe(false);
  });

  it('survives a browser that blocks site data', () => {
    /*
     * Not defensive padding. Safari with "Prevent cross-site tracking" and any browser
     * set to block storage make `localStorage` *throw* on access rather than return
     * null — and this is read during first render, so an unguarded access is the
     * exception that stops the app rendering at all.
     */
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('The operation is insecure.');
      },
      setItem: () => {
        throw new DOMException('The operation is insecure.');
      },
    });
    expect(readStoredFocus()).toBe(false);
    expect(() => storeFocus(true)).not.toThrow();
  });
});

/*
 * Fullscreen is best-effort in every browser worth naming — `requestFullscreen`
 * rejects outside a user gesture, iPhone Safari does not implement it, and embedded
 * contexts forbid it. The contract is therefore "never throws", because the click
 * handler that calls it also toggles the mode that actually carries the feature.
 */
describe('fullscreen', () => {
  const docWith = (over: Partial<Document> & { el?: object }) =>
    ({
      documentElement: over.el ?? {},
      fullscreenElement: null,
      ...over,
    }) as unknown as Document;

  it('reports support from the method actually being there', () => {
    expect(fullscreenSupported(docWith({ el: { requestFullscreen: () => {} } }))).toBe(true);
    expect(fullscreenSupported(docWith({ el: {} }))).toBe(false);
  });

  it('does nothing where fullscreen is unsupported', async () => {
    await expect(enterFullscreen(docWith({ el: {} }))).resolves.toBeUndefined();
  });

  it('swallows a rejected request rather than breaking the toggle', async () => {
    // Firefox and Safari both reject when the call is not inside a user gesture.
    const doc = docWith({
      el: { requestFullscreen: () => Promise.reject(new Error('not allowed')) },
    });
    await expect(enterFullscreen(doc)).resolves.toBeUndefined();
  });

  it('does not re-request when already fullscreen', async () => {
    let calls = 0;
    const doc = docWith({
      el: {
        requestFullscreen: () => {
          calls += 1;
          return Promise.resolve();
        },
      },
      fullscreenElement: {} as Element,
    });
    await enterFullscreen(doc);
    expect(calls).toBe(0);
  });

  it('only exits when there is something to exit', async () => {
    let calls = 0;
    const doc = docWith({ exitFullscreen: () => ((calls += 1), Promise.resolve()) });
    await exitFullscreen(doc);
    expect(calls).toBe(0);

    const inFs = docWith({
      fullscreenElement: {} as Element,
      exitFullscreen: () => ((calls += 1), Promise.resolve()),
    });
    await exitFullscreen(inFs);
    expect(calls).toBe(1);
  });
});
