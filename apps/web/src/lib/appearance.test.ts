import { afterEach, describe, expect, it, vi } from 'vitest';
// Vite's `?raw`, not `node:fs`. `apps/web` is a browser package whose tsconfig
// declares only `vite/client` types, and widening that to include node would let
// browser code import `node:fs` and still typecheck — a worse trade than reading
// this file the way the bundler already can.
import indexHtml from '../../index.html?raw';
import {
  applyAppearance,
  appearanceSummary,
  CONTRAST,
  DEFAULT_APPEARANCE,
  narrow,
  readStoredAppearance,
  storeAppearance,
  TEXT_SIZE,
  THEME,
  type Appearance,
  type Root,
} from './appearance.js';

/** Records what reached the document element, in order. */
function fakeRoot() {
  const attrs = new Map<string, string>();
  const calls: string[] = [];
  const root: Root = {
    setAttribute(name, value) {
      attrs.set(name, value);
      calls.push(`set ${name}=${value}`);
    },
    removeAttribute(name) {
      attrs.delete(name);
      calls.push(`remove ${name}`);
    },
  };
  return { root, attrs, calls };
}

/** A localStorage that behaves, and one that throws the way a blocked one does. */
function stubStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  });
  return map;
}

function stubHostileStorage() {
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
    setItem() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('narrow', () => {
  it('accepts every value the stylesheet implements', () => {
    for (const v of THEME.options) expect(narrow(THEME, v)).toBe(v);
    for (const v of CONTRAST.options) expect(narrow(CONTRAST, v)).toBe(v);
    for (const v of TEXT_SIZE.options) expect(narrow(TEXT_SIZE, v)).toBe(v);
  });

  it('falls to the base for anything else', () => {
    // The value comes from localStorage, so it comes from a previous version of
    // the app, another tab, or a devtools console. `data-theme="purple"` matches
    // no rule, so passing it through would be a setting that silently does
    // nothing rather than one that is refused.
    for (const junk of ['purple', '', 'DARK', 'system ', null, undefined, 7, {}, []]) {
      expect(narrow(THEME, junk)).toBe('system');
    }
  });
});

describe('applyAppearance', () => {
  it('writes only what differs from the default', () => {
    const { root, attrs } = fakeRoot();
    applyAppearance({ theme: 'dark', contrast: 'high', text: 'large' }, root);
    expect(Object.fromEntries(attrs)).toEqual({
      'data-theme': 'dark',
      'data-contrast': 'high',
      'data-text': 'large',
    });
  });

  it('removes the attribute rather than writing the base value', () => {
    /*
     * The case this exists for. `tokens.css` reads the system palette through
     * `:root:not([data-theme='light'])` inside a prefers-color-scheme query, so
     * writing `data-theme="system"` would match neither that nor
     * `[data-theme='dark']` — and a reader who chose "Match my system" would be
     * pinned to light forever, which is precisely what the option exists to
     * avoid. Same shape for the other two.
     */
    const { root, attrs, calls } = fakeRoot();
    applyAppearance(DEFAULT_APPEARANCE, root);
    expect(attrs.size).toBe(0);
    expect(calls).toEqual(['remove data-theme', 'remove data-contrast', 'remove data-text']);
  });

  it('clears an attribute when a reader goes back to the default', () => {
    const { root, attrs } = fakeRoot();
    applyAppearance({ theme: 'dark', contrast: 'high', text: 'large' }, root);
    applyAppearance({ theme: 'system', contrast: 'normal', text: 'large' }, root);
    expect(Object.fromEntries(attrs)).toEqual({ 'data-text': 'large' });
  });

  it('applies each setting independently of the others', () => {
    const { root, attrs } = fakeRoot();
    applyAppearance({ theme: 'system', contrast: 'high', text: 'normal' }, root);
    expect(Object.fromEntries(attrs)).toEqual({ 'data-contrast': 'high' });
  });
});

describe('reading and storing', () => {
  it('round-trips every combination', () => {
    for (const theme of THEME.options) {
      for (const contrast of CONTRAST.options) {
        for (const text of TEXT_SIZE.options) {
          stubStorage();
          const chosen: Appearance = { theme, contrast, text };
          storeAppearance(chosen);
          expect(readStoredAppearance()).toEqual(chosen);
          vi.unstubAllGlobals();
        }
      }
    }
  });

  it('reads the default when nothing has been stored', () => {
    stubStorage();
    expect(readStoredAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it('survives a browser that blocks site data instead of taking the app down', () => {
    /*
     * `localStorage` throws outright — not returns null — when a browser is set
     * to block site data. Unguarded, this read is the exception that stops the
     * app rendering at all, which would mean a privacy setting turning the whole
     * product into a blank page.
     */
    stubHostileStorage();
    expect(() => readStoredAppearance()).not.toThrow();
    expect(readStoredAppearance()).toEqual(DEFAULT_APPEARANCE);
    expect(() => storeAppearance({ theme: 'dark', contrast: 'high', text: 'large' })).not.toThrow();
  });

  it('ignores a stored value the stylesheet does not implement', () => {
    stubStorage({ 'wap:theme': 'purple', 'wap:contrast': 'high', 'wap:text': 'enormous' });
    expect(readStoredAppearance()).toEqual({ theme: 'system', contrast: 'high', text: 'normal' });
  });
});

describe('appearanceSummary', () => {
  it('says so plainly when nothing has been changed', () => {
    expect(appearanceSummary(DEFAULT_APPEARANCE)).toBe('Everything is at its default.');
  });

  it('names what is not at its default, the way every list leads with a count', () => {
    expect(appearanceSummary({ theme: 'dark', contrast: 'normal', text: 'normal' })).toBe(
      'Night — everything else is at its default.',
    );
    expect(appearanceSummary({ theme: 'light', contrast: 'high', text: 'large' })).toBe(
      'Paper · High contrast · Large text — everything else is at its default.',
    );
  });

  it('does not call the system default a change', () => {
    expect(appearanceSummary({ theme: 'system', contrast: 'high', text: 'normal' })).toBe(
      'High contrast — everything else is at its default.',
    );
  });
});

/**
 * The inline script in `index.html` is a second copy of this module's keys and
 * attributes, and it has to be — it runs before the bundle parses, which is the
 * only way a reader who chose Night avoids a bone-white flash on every load.
 *
 * A duplicate is only acceptable while something stops it drifting. Renaming
 * `wap:theme` here and not there would not break a test, would not break a
 * build, and would silently strand every reader's stored setting: the module
 * would write the new key while the pre-paint script kept reading the old one,
 * so the flash would come back and nobody would know why.
 */
describe('the pre-paint script in index.html', () => {
  const html = indexHtml;

  it('exists at all, and before the module script', () => {
    const inline = html.indexOf('localStorage.getItem');
    const bundle = html.indexOf('src="/src/main.tsx"');
    expect(inline, 'no inline appearance script found in index.html').toBeGreaterThan(-1);
    expect(bundle, 'no module script found in index.html').toBeGreaterThan(-1);
    expect(inline, 'the pre-paint script must run before the bundle').toBeLessThan(bundle);
  });

  it.each([
    [THEME.key, THEME.attr, THEME.base],
    [CONTRAST.key, CONTRAST.attr, CONTRAST.base],
    [TEXT_SIZE.key, TEXT_SIZE.attr, TEXT_SIZE.base],
  ])('carries %s -> %s with the base %s', (key, attr, base) => {
    expect(html, `index.html does not read ${key}`).toContain(`'${key}'`);
    expect(html, `index.html does not set ${attr}`).toContain(`'${attr}'`);
    expect(html, `index.html does not know ${base} means "no attribute"`).toContain(`'${base}'`);
  });

  it('guards the storage read, because a blocked browser throws rather than returning null', () => {
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(script, 'the pre-paint read is not wrapped in try/catch').toMatch(/try\s*\{/);
    expect(script).toMatch(/catch\s*\(/);
  });
});
