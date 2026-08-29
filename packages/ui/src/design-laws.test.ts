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
