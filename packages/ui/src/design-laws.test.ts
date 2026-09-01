import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

  /**
   * The same law, in the units the px check cannot see.
   *
   * `border-radius: 50%` is a circle, and the assertion above matches only
   * `([\d.]+)px` — so every percentage, `rem`, `em` and `9999px`-in-disguise
   * shorthand walked past it. A pill-shaped button written as `border-radius:
   * 50%` is exactly the candy rounding law 1 exists to refuse, and it would have
   * shipped green.
   *
   * Found while reviewing a stylesheet that used it legitimately, which is the
   * useful case to reason from: a radio input is a circle because that is what
   * distinguishes it from a checkbox, and squaring it to 2px would make the
   * control lie about what it does. So this is an allow-list rather than a ban,
   * and — like ORNAMENT_ONLY below — the list is the point. A selector earns a
   * place on it by being a control whose shape carries meaning, not by being
   * inconvenient to fix.
   */
  const ROUND_BY_NATURE = new Set(['.appearance__radio', '.appearance__radio:focus-visible']);

  it('allows a non-px radius only where the shape is the affordance', () => {
    const offenders: string[] = [];

    for (const f of cssFiles.filter((name) => name !== 'tokens.css')) {
      for (const [, selector, body] of code(f).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const radius = body!.match(/border-radius:\s*([^;]+)/)?.[1]?.trim();
        if (!radius) continue;
        // The px form is judged by the assertion above; anything else lands here.
        // A bare `0` is not a unit slip — it is the flattest a corner gets, and
        // the one value this law could never object to.
        if (/^0[a-z%]*$/i.test(radius)) continue;
        if (/^[\d.]+px$/.test(radius) || /^var\(--radius(-sm)?\)$/.test(radius)) continue;

        const sel = selector!.trim();
        if (sel.split(',').every((one) => ROUND_BY_NATURE.has(one.trim()))) continue;
        offenders.push(`${f}: ${sel} sets border-radius: ${radius}`);
      }
    }

    expect(
      offenders,
      `a radius the px check cannot measure is still a radius:\n  ${offenders.join('\n  ')}\n` +
        `Use --radius / --radius-sm, or add the selector to ROUND_BY_NATURE if its shape ` +
        `is what tells a reader what the control does.`,
    ).toEqual([]);
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

  it('never leaves a width with no navigation on it', () => {
    /*
     * The masthead nav hides because the rail takes over, so the width where one goes
     * must be the width where the other arrives. They are one decision written in two
     * places, and they drifted the moment the rail moved from 60rem to 63rem to
     * protect the measure — leaving 960px to 1008px with the nav hidden and the rail
     * not yet shown, and no way to change section at all.
     *
     * Neither rule is wrong read on its own, which is why this is pinned as a
     * relationship rather than as two numbers.
     */
    const all = cssFiles.map(code).join('\n');
    const hidesNavAt = [
      ...all.matchAll(
        /@media \(min-width: ([\d.]+)rem\)\s*\{[^{}]*\.shell__masthead-nav\s*\{[^}]*display:\s*none/g,
      ),
    ].map((m) => Number(m[1]));
    expect(hidesNavAt.length, 'no rule hides the masthead navigation').toBe(1);

    const showsRailAt = [
      ...all.matchAll(
        /@media \(min-width: ([\d.]+)rem\)\s*\{[\s\S]*?\.shell__rail\s*\{[^}]*display:\s*block/g,
      ),
    ].map((m) => Number(m[1]));
    expect(showsRailAt.length, 'no rule shows the navigation rail').toBe(1);

    expect(
      hidesNavAt[0],
      `the masthead nav hides at ${hidesNavAt[0]}rem but the rail only appears at ${showsRailAt[0]}rem, leaving a band with no navigation`,
    ).toBe(showsRailAt[0]);
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

/**
 * The two laws `docs/design.md` states and this file did not enforce.
 *
 * Both were found by a design review rather than by a test, and both had shipped
 * as live violations on four rules each — which is the argument for pinning them
 * here rather than trusting the next reviewer to look. The stylesheets were
 * fixed in a separate pass; this describe block is only about closing the gap
 * that let them through.
 */
describe('The Archive legibility laws', () => {
  /** `#rrggbb` → relative luminance, per WCAG 2.x. */
  const luminance = (hex: string) => {
    const channels = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };

  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  /**
   * One level of `var()` indirection, which is exactly what the palettes use:
   * `--text-faint: var(--warm-faint)` in the light block, a literal in the dark
   * one. Resolving deeper is not needed and would invite this helper to become a
   * CSS engine.
   */
  const palette = (block: string) => {
    const raw = new Map<string, string>();
    for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      raw.set(name!, value!.trim());
    }
    const resolved = new Map<string, string>();
    for (const [name, value] of raw) {
      const ref = value.match(/^var\((--[\w-]+)\)$/);
      const literal = ref ? (raw.get(ref[1]!) ?? '') : value;
      if (/^#[0-9a-f]{6}$/i.test(literal)) resolved.set(name, literal);
    }
    return resolved;
  };

  const tokens = read('tokens.css');
  const lightBlock = tokens.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const darkBlock = tokens.match(/:root\[data-theme='dark'\]\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  /**
   * Tokens that may sit below the text threshold, because no rule uses them for
   * text. Every entry is a deliberate exemption with a named use — the list is
   * the point, not the escape hatch. Adding to it should feel like a decision.
   *
   *   --text-faint  the `·` chip separator in components.css, and the `::before`
   *                 list ordinals in source.css and daily.css. Ornament that
   *                 carries no word a reader has to make out.
   */
  const ORNAMENT_ONLY = new Set(['--text-faint']);

  it.each([
    ['light', () => lightBlock],
    ['dark', () => darkBlock],
  ])('every %s text token a rule can use clears 4.5:1 on both surfaces', (theme, get) => {
    const block = get();
    expect(block, `no ${theme} palette block found in tokens.css`).not.toBe('');
    const p = palette(block);

    const surface = p.get('--surface');
    const raised = p.get('--surface-raised');
    expect(surface, `${theme} palette has no resolvable --surface`).toBeDefined();
    expect(raised, `${theme} palette has no resolvable --surface-raised`).toBeDefined();

    const textTokens = [...p.keys()].filter((n) => n.startsWith('--text'));
    expect(textTokens.length, `${theme} palette exposes no --text-* tokens`).toBeGreaterThan(2);

    for (const name of textTokens) {
      if (ORNAMENT_ONLY.has(name)) continue;
      for (const [label, ground] of [
        ['--surface', surface!],
        ['--surface-raised', raised!],
      ] as const) {
        const ratio = contrast(p.get(name)!, ground);
        expect(
          ratio,
          `${theme}: ${name} on ${label} is ${ratio.toFixed(2)}:1 — docs/design.md requires 4.5:1 ` +
            `for body text. Either darken the token, or add it to ORNAMENT_ONLY with the ` +
            `non-text uses that justify it.`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  /**
   * The high-contrast setting must be able to rescue anything a rule can reach.
   *
   * `:root[data-contrast='high']` remaps `--text-muted` and both rules, but not
   * `--text-faint` — so a reader who has asked for more contrast got exactly the
   * same 2.72:1 from the four rules that had adopted it. A token that is exempt
   * from the ratio check above must therefore also be one the setting does not
   * need to reach: ornament in both directions, or neither.
   */
  /**
   * The token check above cannot see a RULE adopting an ornament token for text
   * — which is how all four of the reviewed violations actually happened. So the
   * exemption is paid for here: a token on ORNAMENT_ONLY may be a `color:` only
   * where it is genuinely ornament.
   *
   * Ornament means one of two shapes, and the list is deliberately short:
   *
   *   ::before / ::after   a generated counter or mark, not a word the reader
   *                        has to make out. The list ordinals in source.css and
   *                        daily.css.
   *   an explicit selector the separator in a chip row, which is a single `·`.
   *
   * Anything else using a sub-threshold token is text at 2.72:1, whatever it is
   * called.
   */
  const ORNAMENT_SELECTORS = new Set(['.pull-card__chip-sep']);

  it('uses an ornament-only token as a colour only where it is actually ornament', () => {
    const offenders: string[] = [];

    for (const f of cssFiles) {
      if (f === 'tokens.css') continue; // the palette defines them; it does not paint with them
      for (const [, selector, body] of code(f).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        for (const token of ORNAMENT_ONLY) {
          if (!new RegExp(`color:\\s*var\\(${token}\\)`).test(body!)) continue;
          const sel = selector!.trim();
          const isPseudo = /::(before|after)\b/.test(sel);
          const isListed = sel.split(',').every((s) => ORNAMENT_SELECTORS.has(s.trim()));
          if (!isPseudo && !isListed) offenders.push(`${f}: ${sel} paints text with ${token}`);
        }
      }
    }

    expect(
      offenders,
      `these render words a reader has to read, at a ratio docs/design.md forbids:\n  ` +
        `${offenders.join('\n  ')}\n` +
        `Use --text-muted, or add the selector to ORNAMENT_SELECTORS if it really is a mark.`,
    ).toEqual([]);
  });

  /**
   * A forced theme must tell the browser which scheme it is.
   *
   * `base.css` sets `color-scheme: light dark`, which is correct for the default
   * — the user agent paints scrollbars, autofill and native controls to match
   * the OS. It is wrong the instant a reader overrides the theme: measured, an
   * OS in dark mode with "Paper" chosen rendered the bone palette with a dark
   * scrollbar, because the UA was still being told the page could be either.
   *
   * The palette and the furniture around it have to agree, and nothing else in
   * this file would have noticed them disagreeing — every colour assertion here
   * reads the stylesheet, and a scrollbar is not in it.
   */
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
  ])('declares color-scheme for the forced %s theme', (theme, scheme) => {
    const tokens = read('tokens.css');
    const block = tokens.match(
      new RegExp(`:root\\[data-theme='${theme}'\\]\\s*\\{[\\s\\S]*?\\n\\}`),
    )?.[0];
    expect(block, `no :root[data-theme='${theme}'] block in tokens.css`).toBeTruthy();
    expect(
      block,
      `a reader who forces the ${theme} theme still gets UA surfaces painted for the OS`,
    ).toMatch(new RegExp(`color-scheme:\\s*${scheme}\\s*;`));
  });

  it('leaves no text token both below the threshold and beyond the reach of high contrast', () => {
    const high = tokens.match(/:root\[data-contrast='high'\]\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(high, 'no [data-contrast=high] block found').not.toBe('');
    const remapped = new Set([...high.matchAll(/(--[\w-]+):/g)].map((m) => m[1]!));

    for (const name of ORNAMENT_ONLY) {
      expect(
        remapped.has(name),
        `${name} is exempt from the contrast floor but IS remapped under ` +
          `[data-contrast='high'] — so something treats it as text after all. Take it out ` +
          `of ORNAMENT_ONLY and let the ratio check judge it.`,
      ).toBe(false);
    }
  });

  /**
   * The type ramp: uppercase and positive tracking belong to the metadata role.
   *
   * `.btn` sets `text-transform: uppercase` and `letter-spacing: 0.06em`, which
   * is right for a control. Four rules then promoted a `.btn` to the display face
   * for a headline or a topic name and inherited both, so content rendered as
   * Fraunces ALL CAPS at +1.0 to +1.5px tracking.
   *
   * THE CHECK HAS TO READ THE MARKUP, and the first version of it did not — which
   * is worth recording, because it failed in exactly the way this whole review
   * round is about. It looked for `.btn` in the CSS *selector*; but `.btn` is
   * never in the selector, it is in the `className` string:
   *
   *     className="btn btn--plain explore__parent-name"
   *     .explore__parent-name { font-family: var(--font-display) }
   *
   * So the assertion could not fire for any real case, and it passed when the fix
   * it was written to protect was reverted. A test that cannot fail is worse than
   * no test, because it also stops anyone writing the one that would.
   *
   * The broad alternative — "every display-face rule must declare
   * text-transform" — was measured and rejected: 8 of the 13 display-face rules
   * omit it today and all 8 are correct, so it would mean editing working
   * stylesheets to satisfy a test.
   *
   * Reading `apps/web` from a `packages/ui` test crosses a package boundary. That
   * is deliberate: the invariant is repo-wide, the classes and the rules that
   * style them live on opposite sides of it, and the check is worth more than the
   * layering. Missing markup is a hard failure rather than a skip.
   */
  it('never puts the display face on a class that markup combines with .btn', () => {
    const roots = [
      join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'src'),
      join(import.meta.dirname, 'components'),
    ].filter(existsSync);
    expect(roots.length, 'no component source found — this check would pass vacuously').toBe(2);

    /** Every class that markup ever puts alongside `btn`. */
    const withButton = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          for (const [, list] of readFileSync(full, 'utf8').matchAll(
            /className=(?:"([^"]*)"|\{`([^`]*)`\})/g,
          )) {
            const classes = (list ?? '').split(/\s+/).filter(Boolean);
            if (!classes.includes('btn')) continue;
            for (const c of classes) if (c !== 'btn' && !c.startsWith('btn--')) withButton.add(c);
          }
        }
      }
    };
    for (const r of roots) walk(r);
    expect(withButton.size, 'no className combined with btn was found').toBeGreaterThan(4);

    const offenders: string[] = [];
    for (const f of cssFiles) {
      for (const [, selector, body] of code(f).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (!/font-family:\s*var\(--font-display\)/.test(body!)) continue;
        // The bare class this rule styles, if markup ever pairs it with `btn`.
        const named = [...selector!.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
        if (!named.some((c) => withButton.has(c))) continue;

        const clearsTransform = /text-transform:\s*(?!uppercase)[\w-]+/.test(body!);
        const clearsTracking = /letter-spacing:\s*/.test(body!);
        if (!clearsTransform || !clearsTracking) {
          offenders.push(
            `${f}: ${selector!.trim()} — ` +
              [
                clearsTransform ? null : 'inherits text-transform: uppercase from .btn',
                clearsTracking ? null : 'inherits letter-spacing: 0.06em from .btn',
              ]
                .filter(Boolean)
                .join(', '),
          );
        }
      }
    }

    expect(
      offenders,
      `a headline set in the display face is content, not metadata:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
