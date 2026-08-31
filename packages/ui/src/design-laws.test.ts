import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Archive's design laws, enforced instead of merely documented.
 *
 * The product must never drift toward the pastel-gradient, candy-rounded,
 * drop-shadowed look it exists to be different from. Review catches that
 * unreliably; a test catches it every time.
 *
 * See docs/design.md and .claude/skills/design-check/SKILL.md.
 */

const STYLES = join(import.meta.dirname, 'styles');
const cssFiles = readdirSync(STYLES).filter((f) => f.endsWith('.css'));
const read = (f: string) => readFileSync(join(STYLES, f), 'utf8');

/** Strip comments so prose about gradients doesn't trip the checks. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '');

describe('The Archive design laws', () => {
  it('has stylesheets to check', () => {
    expect(cssFiles.length).toBeGreaterThan(0);
  });

  it('uses no gradients anywhere — flat ground plus grain, never a gradient', () => {
    for (const f of cssFiles) {
      expect(code(f), `${f} contains a gradient`).not.toMatch(/(linear|radial|conic)-gradient/);
    }
  });

  it('uses no box-shadow for elevation — separation is by hairline rule', () => {
    for (const f of cssFiles) {
      // The focus ring is the sole exception: there a shadow is an
      // accessibility affordance, not decoration.
      const shadows = [...code(f).matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]!.trim());
      const decorative = shadows.filter((v) => !v.includes('--focus-ring'));
      expect(decorative, `${f} uses box-shadow for elevation`).toEqual([]);
    }
  });

  it('defines colour only in tokens.css', () => {
    for (const f of cssFiles.filter((name) => name !== 'tokens.css')) {
      // Data-URI SVGs carry their own encoded markup; strip them before looking
      // for hex, or the embedded paper-grain filter reads as a colour literal.
      const withoutDataUris = code(f).replace(/url\("data:[^"]*"\)/g, '');
      const hexes: string[] = withoutDataUris.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hexes, `${f} hardcodes ${hexes.join(', ')} outside tokens.css`).toEqual([]);
    }
  });

  it('keeps corner radii small — candy rounding is the look being avoided', () => {
    const tokens = read('tokens.css');
    for (const name of ['--radius:', '--radius-sm:']) {
      const value = tokens.match(new RegExp(`${name}\\s*([\\d.]+)px`))?.[1];
      expect(Number(value), `${name} is too round`).toBeLessThanOrEqual(4);
    }
    for (const f of cssFiles.filter((name) => name !== 'tokens.css')) {
      const literals = [...code(f).matchAll(/border-radius:\s*([\d.]+)px/g)].map((m) =>
        Number(m[1]),
      );
      for (const px of literals) {
        expect(px, `${f} sets a ${px}px radius literal`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('has exactly one accent colour', () => {
    const tokens = read('tokens.css');
    const accents = [...tokens.matchAll(/^\s*--accent(?:-hover)?:\s*([^;]+);/gm)];
    // One --accent and one --accent-hover per theme block; every value must
    // resolve to the oxblood family, never a second hue.
    const values = new Set(accents.map((m) => m[1]!.trim()));
    for (const v of values) {
      expect(v, 'a second accent colour was introduced').toMatch(
        /var\(--oxblood(-soft)?\)|#(8c2f26|a8433a|c96a5f|dc8074)/i,
      );
    }
  });

  it('respects prefers-reduced-motion', () => {
    const all = cssFiles.map(read).join('\n');
    expect(all).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('defines a visible focus ring and never removes focus outright', () => {
    const all = cssFiles.map(code).join('\n');
    expect(all).toMatch(/:focus-visible/);
    // `outline: none` is only acceptable where a focus ring replaces it.
    for (const f of cssFiles) {
      const blocks = code(f).split('}');
      for (const b of blocks) {
        if (/outline:\s*(none|0)/.test(b)) {
          expect(b, `${f} removes focus without providing a ring`).toMatch(/box-shadow/);
        }
      }
    }
  });

  it('supports dark mode by both system preference and explicit choice', () => {
    const tokens = read('tokens.css');
    expect(tokens).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(tokens).toMatch(/\[data-theme='dark'\]/);
  });
});

/**
 * Law 7 — a session must show its bounds.
 *
 * Shorts and Reels go full-bleed, hide their chrome and keep the next item sliding
 * into frame, so the reader is never shown how much is left. This product claims the
 * opposite — *enough for today* — and that claim is made by layout, not by copy.
 *
 * It was prose in `docs/design.md` while the colour laws were enforced here, which is
 * the asymmetry that let two fixed breakpoints sit in the layout for a whole round
 * without anyone noticing they made a 70rem window render as a 60rem one.
 */
describe('The Archive viewport laws', () => {
  it('never uses vh — mobile chrome makes it taller than the visible area', () => {
    // `100vh` puts primary actions underneath the address bar on exactly the devices
    // where a mis-placed button is hardest to recover from. `dvh`/`svh` are the
    // measurements that describe what the reader can actually see.
    for (const f of cssFiles) {
      const vh = [...code(f).matchAll(/\b\d*\.?\d+vh\b/g)].map((m) => m[0]);
      expect(vh, `${f} uses ${vh.join(', ')} — use dvh or svh`).toEqual([]);
    }
  });

  it('pins the reading column to --measure at every width, not only wide ones', () => {
    /*
     * The one dimension that must not respond. Extra width buys structure and
     * peripheral context; a 1400px line is one nobody can track back to the start of.
     *
     * Media queries are stripped before matching, and that is the whole point of the
     * assertion rather than an implementation detail. Searching the file as a whole
     * would pass on a stylesheet that caps the column only above 60rem — leaving it
     * unbounded on a phone, which is the exact failure this law describes.
     */
    const withoutMediaQueries = cssFiles
      .map(code)
      .join('\n')
      .replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');

    expect(withoutMediaQueries, 'the reading column no longer caps its width').toMatch(
      /\.shell__column\s*\{[^}]*max-width:\s*var\(--measure\)/,
    );
  });

  it('defines --measure once, in tokens.css', () => {
    // A second definition is how a screen quietly acquires its own idea of a
    // comfortable line length.
    for (const f of cssFiles.filter((name) => name !== 'tokens.css')) {
      expect(code(f), `${f} redefines --measure`).not.toMatch(/--measure:\s*[^;]+;/);
    }
  });

  it('keeps the session rails on screen above the three-pane breakpoint', () => {
    // The rails are the edges. What they show — what this session has done, what the
    // Delta spared you — is the visible evidence that a session is a finite thing,
    // so hiding them at a wide viewport would remove the only thing saying so.
    const all = cssFiles.map(code).join('\n');
    const wide = all.match(/@media \(min-width: 60rem\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(wide, 'no three-pane rule found at 60rem').not.toBe('');

    // The rail's own rule, not a span of text containing both strings. A lazy
    // `[\s\S]*?` between them crosses rule boundaries, so it would pass on
    // `.shell__rail { display: none } .shell__masthead-nav { display: block }` —
    // rails hidden, law broken, test green. That arrangement is one tidy-up away:
    // a second `@media (min-width: 60rem)` block already exists in components.css
    // and merging them would produce exactly it.
    const railRule = wide.match(/\.shell__rail[^{]*\{[^}]*\}/)?.[0] ?? '';
    expect(railRule, 'no .shell__rail rule inside the three-pane breakpoint').not.toBe('');
    expect(railRule, 'the rails are hidden where they should appear').toMatch(/display:\s*block/);
  });

  it('scales the base type scale fluidly rather than in fixed steps', () => {
    /*
     * Fixed rem steps rendered the same 39px headline on a 1504px laptop and a 375px
     * phone, changing only at two breakpoints in between. Every step in the base scale
     * is clamped now, and each keeps a `rem` term so an OS or browser font-size
     * preference still applies — a pure `vw` scale ignores the reader entirely.
     *
     * Scoped to the base `:root` block deliberately. `:root[data-text='large']`
     * overrides these with larger fixed values, and that is correct rather than a
     * violation: a reader who has asked for large text does not want it to shrink
     * again on a small screen. Fluidity serves the default; the override exists to
     * escape the default.
     */
    const tokens = read('tokens.css');
    const base = tokens.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(base, 'no base :root block found').not.toBe('');

    const steps = [...base.matchAll(/--step-{1,2}\d:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(steps.length, 'no type scale found in :root').toBeGreaterThan(4);
    for (const value of steps) {
      expect(value, `type step "${value}" is not fluid`).toMatch(/clamp\(/);
      expect(value, `type step "${value}" ignores the reader's font size`).toMatch(/rem/);
    }
  });
});
