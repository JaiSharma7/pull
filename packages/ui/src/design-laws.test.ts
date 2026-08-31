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

  it('brings each rail in at the width where it can pay for itself', () => {
    /*
     * The rails are the edges. What they show — what this session has done, what the
     * Delta spared you — is the visible evidence that a session is a finite thing, so
     * hiding them at a wide viewport would remove the only thing saying so.
     *
     * They arrive one at a time, and that is this law meeting a stronger one rather
     * than being relaxed. Both used to appear together at 60rem, and measuring it in a
     * browser showed the layout getting *worse* as the window grew: at 959px the
     * reading column was a full 544px and at 961px it was 481px, staying under the
     * measure until 1040px. Two pixels of window cost 63 pixels of line, across a band
     * that includes 1024 — a split screen, or a scaled display.
     *
     * `.shell__column`'s own comment calls the measure "the one thing this layout
     * exists to protect", so where the two collide the line wins and the peripheral
     * context waits. The rail (navigation) comes in at 60rem, the aside (the session
     * tally, also reported on the Enough screen) at 66rem.
     *
     * Both thresholds are pinned here because both are load-bearing: lowering the
     * aside's reintroduces the bug, and raising the rail's would strand navigation on
     * a laptop that has room for it.
     */
    const all = cssFiles.map(code).join('\n');

    const block = (minWidth: string) =>
      all.match(new RegExp(`@media \\(min-width: ${minWidth}\\)\\s*\\{[\\s\\S]*?\\n\\}`))?.[0] ??
      '';

    // The element's own rule, not a span of text containing both strings. A lazy
    // `[\s\S]*?` between them crosses rule boundaries, so it would pass on
    // `.shell__rail { display: none } .shell__masthead-nav { display: block }` —
    // rails hidden, law broken, test green.
    const ownRule = (css: string, selector: string) =>
      css.match(new RegExp(`(^|[;}]|\\n)\\s*\\${selector}\\s*\\{[^}]*\\}`))?.[0] ?? '';

    const twoPane = block('63rem');
    expect(twoPane, 'no two-pane rule found at 63rem').not.toBe('');
    const railRule = ownRule(twoPane, '.shell__rail');
    expect(railRule, 'no .shell__rail rule of its own at 63rem').not.toBe('');
    expect(railRule, 'the navigation rail is hidden where it should appear').toMatch(
      /display:\s*block/,
    );

    const threePane = block('66rem');
    expect(threePane, 'no three-pane rule found at 66rem').not.toBe('');
    const asideRule = ownRule(threePane, '.shell__aside');
    expect(asideRule, 'no .shell__aside rule of its own at 66rem').not.toBe('');
    expect(asideRule, 'the session aside is hidden where it should appear').toMatch(
      /display:\s*block/,
    );

    /*
     * The outer tracks must be identical, because that is what centres the column.
     *
     * `.shell__column` sets `margin-inline: auto`, which centres it in the *middle
     * track* — and the middle track is centred in the window only when the tracks
     * either side of it are equal. They were not, and the column drifted across the
     * window as it grew: measured in a browser, 98px right of centre at 1024px (a rail
     * with nothing balancing it) and 25–32px left of centre above 1200px (an aside
     * declared wider than the rail). Nothing in the CSS looked wrong; the asymmetry
     * was two clamps written independently.
     *
     * Pinned as one shared value used twice rather than as two values that happen to
     * match, since two matching literals are one careless edit away from not matching.
     */
    const grid =
      twoPane.match(/\.shell__body\s*\{[^}]*grid-template-columns:([^;]*);/)?.[1]?.trim() ?? '';
    expect(grid, 'no grid declared at 63rem').not.toBe('');
    const tracks = grid.split(/\s+(?![^(]*\))/).filter(Boolean);
    expect(tracks.length, `expected three tracks, got "${grid}"`).toBe(3);
    expect(tracks[0], 'the outer tracks differ, so the reading column is off-centre').toBe(
      tracks[2],
    );
    expect(tracks[1], 'the middle track is not the flexible one').toMatch(/minmax\(0,\s*1fr\)/);

    // The aside must not redeclare a width of its own; that is how the asymmetry
    // returned last time. It may only become visible in the track already reserved.
    expect(
      threePane,
      'the 66rem block redeclares the grid, which risks reintroducing the asymmetry',
    ).not.toMatch(/grid-template-columns/);
  });

  it('lets the masthead navigation wrap', () => {
    /*
     * The number of sections is not fixed, and this nav is the only copy of them below
     * 60rem. It was a single unbreakable flex row: six buttons measured 517px inside a
     * 375px window and gave the whole page a horizontal scrollbar. It fit at four
     * sections and broke when Daily Pull and History were added — a layout bug shipped
     * by a change that never touched this file, which is why it is pinned rather than
     * left to the next person to notice.
     */
    const nav = read('components.css').match(/\.shell__masthead-nav\s*\{[^}]*\}/)?.[0] ?? '';
    expect(nav, 'no .shell__masthead-nav rule found').not.toBe('');
    expect(nav, 'the masthead navigation cannot wrap, so it overflows narrow windows').toMatch(
      /flex-wrap:\s*wrap/,
    );
    expect(nav, 'the nav cannot shrink below its content without min-width: 0').toMatch(
      /min-width:\s*0/,
    );
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
