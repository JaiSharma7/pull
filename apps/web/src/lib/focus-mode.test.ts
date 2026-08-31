import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyFocus, readStoredFocus, storeFocus } from './focus-mode.js';

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
