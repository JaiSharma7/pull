import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
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
const WEB = join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'src');

/**
 * Every stylesheet the product ships, not just this package's.
 *
 * `cssFiles` was `readdirSync(packages/ui/src/styles)` and every assertion below
 * loops it — so `apps/web/src/styles/design-preview.css`, 467 lines of real rules
 * loaded by `routes/DesignPreview.tsx` on the reachable `/design-preview`, was
 * invisible to all of them. Verified by writing a pastel gradient, a 24px drop
 * shadow, an 18px radius, a hot-pink hex and `100vh` into it: 31 tests passed. A
 * law that reads one of the two directories it applies to is a law with a
 * documented way around it.
 *
 * Absolute paths, so a file is read by where it is; messages carry the basename,
 * which is what a contributor recognises.
 */
const STYLE_DIRS = [WEB, join(import.meta.dirname)].filter(existsSync);

/** Every file under `dir`, at any depth, whose name `keep` accepts. */
const filesUnder = (dir: string, keep: (name: string) => boolean): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, keep);
    return keep(entry.name) ? [full] : [];
  });

/*
 * RECURSIVELY, and from the package roots rather than from `styles/`.
 *
 * The previous version was `readdirSync` over two flat directories, which is neither
 * of the two things the assertions below need: a stylesheet one level down was never
 * opened, and neither was one beside the component that imports it. Both are one line
 * to write — `apps/web/src/routes/queue.css` next to a `import './queue.css'` in
 * `DesignPreview.tsx`, or `packages/ui/src/styles/queue/queue.css` pulled in by
 * `index.css`. Verified: a file with a pastel gradient, a 32px drop shadow, a 20px
 * radius, a hot-pink hex, a `text-shadow` and a `100vh` passed all 119 tests from
 * either location. `expect(STYLE_DIRS.length).toBe(2)` read as assurance and was
 * assurance about the wrong thing.
 */
const cssFiles = STYLE_DIRS.flatMap((dir) => filesUnder(dir, (f) => f.endsWith('.css')));

/**
 * The stylesheets that are not `.css` files, and the directory outside `src/`.
 *
 * `index.html` is the first stylesheet the browser parses and it already carries an
 * inline `<script>`; `apps/web/public/` is served verbatim and can be reached by a
 * `<link>`. Neither was under either walk. A `<style>` block in the head with a pastel
 * gradient, a 20px radius, a 32px drop shadow, a named colour and a `100vh` passed all
 * 121 tests and `prettier --check`.
 *
 * The `<style>` bodies are appended to `cssFiles`' content by `code()` rather than
 * scanned separately, so every law below reaches them without knowing they exist.
 */
const SHELL = [join(WEB, '..', 'index.html'), join(WEB, '..', 'public')].filter(existsSync);
const shellFiles = SHELL.flatMap((entry) =>
  entry.endsWith('.html')
    ? [entry]
    : filesUnder(entry, (f) => f.endsWith('.css') || f.endsWith('.html')),
);
/**
 * The one stylesheet allowed to hold colour, by PATH rather than by name.
 *
 * Four assertions exempt `tokens.css`, and each did it as
 * `label(name) !== 'tokens.css'` — a basename test, applied to a list that now spans
 * two directories. An `apps/web/src/styles/tokens.css` would therefore have been
 * exempt from all four the moment somebody created it, and nothing would have said
 * so. The palette is one file; the exemption should name that file.
 */
const TOKENS = join(STYLES, 'tokens.css');
/** The stylesheets every colour law applies to, which is all of them but the palette. */
const notTokens = cssFiles.filter((f) => f !== TOKENS);

/**
 * Everywhere a component can be written, for every walk that reads components.
 *
 * The inline-style walk was widened to the package root last round because a
 * `Toast.tsx` beside `components/` was unscanned; the colour-literal walk and the
 * display-face walk were left at `components/` and kept the hole. Sharing the roots
 * is what stops them drifting apart again — three copies of a path is three chances
 * to widen two of them.
 */
const COMPONENT_ROOTS = [WEB, join(import.meta.dirname)].filter(existsSync);

/** Bare names still resolve in this package, which is where the named files live. */
const read = (f: string) => readFileSync(f.includes('/') ? f : join(STYLES, f), 'utf8');
/** What to call a stylesheet in a failure message. */
const label = (f: string) => basename(f);

/**
 * Rules, with at-rule wrappers unwrapped.
 *
 * `([^{}]+)\{([^}]*)\}` cannot parse nesting: for the FIRST rule inside `@media`,
 * `@supports`, `@container` or `@layer`, the captured selector is the at-rule prelude
 * and the captured body is empty, so the rule is skipped entirely. Wrapping a broken
 * `.explore__parent-name` in `@supports (display: grid)` restored the display-face bug
 * the law was written for, with the law green.
 *
 * Removing the at-rule lines and keeping their contents is enough: the checks that use
 * this ask about a selector and its declarations, and an at-rule changes when a rule
 * applies rather than what it says.
 */
/**
 * A stylesheet with its forced-colours blocks removed.
 *
 * In `@media (forced-colors: active)` the SYSTEM palette is the palette: the platform
 * overrides `background` and `border-color`, and a drawn control that names a token
 * there disappears. `appearance.css` uses `CanvasText` for exactly that, with a comment
 * saying so. The keywords are a second accent everywhere else and the right answer
 * there, so the law carves out the block rather than the keyword.
 *
 * Braces are balanced by hand because the block contains rules.
 */
const withoutForcedColours = (css: string): string => {
  let out = '';
  let i = 0;
  for (;;) {
    const at = css.slice(i).search(/@media[^{]*forced-colors[^{]*\{/);
    if (at < 0) return out + css.slice(i);
    const from = i + at;
    out += css.slice(i, from);
    let depth = 0;
    let j = css.indexOf('{', from);
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
};

const rules = (f: string) =>
  code(f)
    .replace(/@(?:media|supports|container|layer)[^{]*\{/g, '')
    .matchAll(/([^{}]+)\{([^}]*)\}/g);

/**
 * Strip comments so prose about gradients doesn't trip the checks.
 *
 * An `.html` file is read for its `<style>` bodies only: the rest is markup, and a
 * `class="…"` is not a declaration. HTML comments go too.
 */
const code = (f: string) => {
  const raw = read(f);
  const body = f.endsWith('.html')
    ? [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).join('\n')
    : raw;
  return (
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      /*
       * PERCENT-DECODED, because the browser decodes a data URI before parsing it and
       * the checks below read the source. `%47` is `G`, so
       * `%3Clinear%47radient` renders `<linearGradient>` and passed the gradient law
       * with two pastel `stop-color` hexes inside it — in the one idiom `base.css`
       * already uses, and the one place the colour law deliberately cannot follow
       * because it strips data URIs whole.
       *
       * Byte by byte rather than `decodeURIComponent`, which throws on a stray `%`.
       */
      .replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
  );
};

describe('The Archive design laws', () => {
  it('has stylesheets to check', () => {
    expect(cssFiles.length).toBeGreaterThan(0);
    // The page shell is a stylesheet the walk above cannot see. See `shellFiles`.
    expect(shellFiles.length, 'apps/web/index.html is not being read').toBeGreaterThan(0);
    // Both directories, or the law is only half enforced. See `STYLE_DIRS`.
    expect(STYLE_DIRS.length, 'apps/web/src/styles is not being read').toBe(2);
  });

  it('uses no gradients anywhere — flat ground plus grain, never a gradient', () => {
    for (const f of [...cssFiles, ...shellFiles]) {
      // Case-insensitive, and the SVG spelling too: `linearGradient` has no hyphen, and
      // `base.css` already embeds a data-URI SVG for the paper grain — which is exactly
      // where a contributor would reach for a pastel one, and where the colour check
      // below cannot follow because it strips data URIs before looking.
      expect(code(f), `${label(f)} contains a gradient`).not.toMatch(
        /(linear|radial|conic)-gradient|linearGradient|radialGradient/i,
      );
    }
  });

  /**
   * The one shadow value the law permits, matched WHOLE.
   *
   * `.includes('--focus-ring')` was a substring test on the whole declaration, so any
   * shadow could wear the ring: `box-shadow: var(--focus-ring), 0 12px 32px var(--ink)`
   * is a real 32px drop shadow on a card, excused by what shares its declaration.
   * `var(--focus-ring-lift)` did it with a token whose NAME contains the string.
   * A composite is not a ring; the exemption is for the ring.
   */
  const ONLY_THE_RING = /^var\(--focus-ring\)$/;

  it('uses no shadow for elevation — separation is by hairline rule', () => {
    for (const f of [...cssFiles, ...shellFiles]) {
      // The focus ring is the sole exception: there a shadow is an
      // accessibility affordance, not decoration.
      //
      // `;` OR the end of the block, because the last declaration before `}` may have
      // no semicolon: `box-shadow: 0 12px 32px var(--ink)` written last was invisible
      // to a pattern that required one, and only `prettier --write` caught it. The
      // formatter is not the law.
      //
      // Case-insensitive, because CSS function and property names are, and prettier
      // lowercases property names but not function names: `Radial-Gradient(…)` and
      // `Drop-Shadow(…)` survive `format:check` intact.
      const shadows = [...code(f).matchAll(/box-shadow:\s*([^;}]+)/gi)].map((m) => m[1]!.trim());
      const decorative = shadows.filter((v) => !ONLY_THE_RING.test(v));
      expect(decorative, `${label(f)} uses box-shadow for elevation`).toEqual([]);

      // The other two ways to write one. `box-shadow` was the whole of this law, so a
      // `text-shadow: 0 1px 2px …` on a headline and a `filter: drop-shadow(…)` on
      // anything at all were both legal in a stylesheet while the inline-style walk
      // rejected them in a component — the same look, judged by where it was typed.
      // Neither has a sanctioned form: the focus ring is a box-shadow.
      expect(code(f), `${label(f)} uses text-shadow`).not.toMatch(/text-shadow:/i);
      expect(code(f), `${label(f)} uses a drop-shadow filter`).not.toMatch(/drop-shadow\s*\(/i);
      // The same shadow drawn as an SVG filter and referenced by id. `filter: url(#…)`
      // is not a shadow declaration and `feDropShadow` is not `drop-shadow(`, so both
      // halves were invisible to both walks.
      expect(code(f), `${label(f)} uses an feDropShadow`).not.toMatch(/feDropShadow/i);
    }
  });

  /**
   * Any way of writing a colour, not just `#rrggbb`.
   *
   * The hex check was the whole of this law, and hex is only one notation. A rule
   * written `rgba(20, 18, 14, .12)` or `oklch(…)` declares a colour the palette
   * has never heard of and sailed straight past it — and the failure is not
   * hypothetical elsewhere in the file, where a `border-radius: 50%` walked past a
   * check that matched only `px`.
   */
  /*
   * AND THE 148 NAMED ONES, which this said it covered and did not. `color: hotpink`
   * is a colour the palette has never heard of, in a stylesheet and in a style object,
   * and it passed both walks — as did `color(display-p3 …)`, because the alternation
   * had `color-mix(` and not `color(`.
   *
   * `transparent` and `currentColor` are deliberately absent: neither names a hue, so
   * neither can disagree with the theme.
   */
  const NAMED_COLOURS =
    'aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|' +
    'blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|' +
    'cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|' +
    'darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|' +
    'darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|' +
    'deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|' +
    'fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|' +
    'hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|' +
    'lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|' +
    'lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|' +
    'lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|' +
    'mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|' +
    'mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|' +
    'moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|' +
    'palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|' +
    'plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|' +
    'sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|' +
    'snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|' +
    'whitesmoke|yellow|yellowgreen';
  /**
   * The system keywords, checked in STYLESHEETS ONLY.
   *
   * `color: AccentColor` is literally a second accent — the operating system's — and
   * `Canvas`, `ButtonFace`, `Highlight` and `LinkText` are the same class. In CSS they
   * only ever appear in a value position, so they are unambiguous there.
   *
   * In TypeScript they are not: `field`, `mark`, `canvas`, `menu` and `highlight` are
   * ordinary identifiers and string values, and adding them to the component walk
   * flagged 22 innocent lines across `Interrupt.tsx` and others. A law that cries wolf
   * on `{ field: … }` is a law somebody turns off.
   */
  const SYSTEM_COLOUR =
    /(?<=:\s*|,\s*)(?:AccentColor|AccentColorText|ActiveText|ButtonBorder|ButtonFace|ButtonText|Canvas|CanvasText|Field|FieldText|GrayText|Highlight|HighlightText|LinkText|Mark|MarkText|SelectedItem|SelectedItemText|VisitedText)\b/g;

  const COLOUR_LITERAL = new RegExp(
    `#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\\(` +
      `|(?<=:\\s*|,\\s*|['"\`])(?:${NAMED_COLOURS})\\b`,
    'gi',
  );

  it('defines colour only in tokens.css', () => {
    for (const f of [...notTokens, ...shellFiles]) {
      // Data-URI SVGs carry their own encoded markup; strip them before looking
      // for colour, or the embedded paper-grain filter reads as a literal.
      const withoutDataUris = withoutForcedColours(code(f)).replace(/url\("data:[^"]*"\)/g, '');
      const found: string[] = [
        ...(withoutDataUris.match(COLOUR_LITERAL) ?? []),
        ...(withoutDataUris.match(SYSTEM_COLOUR) ?? []),
      ];
      expect(found, `${label(f)} hardcodes ${found.join(', ')} outside tokens.css`).toEqual([]);
    }
  });

  /**
   * The same law, in the place a stylesheet check cannot look.
   *
   * A colour can reach the page through `style={{ … }}` without touching a `.css`
   * file at all, and an inline literal is worse than a stylesheet one rather than
   * equivalent: it cannot be overridden by the theme blocks, so a panel painted
   * that way keeps its light-mode colours in dark mode and ignores the
   * high-contrast setting entirely. Named roles that swap are the whole mechanism
   * by which this product has two themes.
   *
   * `scripts/gen-icons.mjs` is deliberately out of scope: a favicon is a file on
   * disk with no page to inherit from, so it has to name its own two colours.
   */
  it('lets no gradient, shadow or radius into an inline style either', () => {
    // The gradient, box-shadow and radius checks read `styles/*.css`, and the
    // component walk below reads only for colour literals — so an inline
    // `style={{ borderRadius: '12px' }}` passed all four. Mutation-tested during
    // review: only the colour one failed. `renderBody` widens the surface, since it
    // is a supported path for an `apps/web` caller to put markup inside the card.
    //
    // Scanned by counting braces rather than by a regex, and that is the whole
    // second round of this check. `/style=\{\{([^}]*)\}\}/` cannot match a style
    // object that CONTAINS a brace — a template literal, or the
    // `} as CSSProperties}` idiom this repo uses — so it was blind to 8 of the 131
    // inline styles in the tree, including this component's own and `Meter.tsx`'s.
    // A drop-shadowed, gradient-filled, 16px-rounded headline shipped green.
    //
    // The rewrite was then mutation-tested over 27 style objects — every banned
    // thing in every spelling and both brace-carrying idioms, against everything
    // the law actually sanctions — and three of those mutations passed a check
    // that should have caught them. Each is recorded beside the line that closed
    // it. Widening a check is not the same as fixing it, and the difference is
    // only ever visible from a violation you wrote on purpose.
    // `packages/ui/src`, not `packages/ui/src/components`: a component anywhere
    // else in the package was unscanned, and a `Toast.tsx` at the package root with
    // a 20px radius, a drop shadow, a gradient and a hex passed all 31 tests.
    // `styles/` is skipped because the stylesheet checks above own it.
    const roots = COMPONENT_ROOTS;
    expect(roots.length, 'no component source found — this check would pass vacuously').toBe(2);

    /**
     * One declaration's own value, ending where the next declaration begins.
     *
     * The scope is the whole point. The exemption was first written against
     * everything following the offending property, so `style={{ borderRadius:
     * '16px', boxShadow: 'var(--focus-ring)' }}` excused the 16px corner on the
     * strength of the shadow's token three characters away. Mutation-tested: that
     * object passed before this helper existed and fails with it.
     *
     * Commas inside quotes and parentheses do not end a value — `0 0 0 2px
     * var(--accent), 0 0 0 4px var(--surface)` is one shadow, not two.
     *
     * AND IT ENDS AT ITS OBJECT, which it did not once the scan started from a whole
     * file rather than from an extracted `style={{ … }}`. A property with no trailing
     * comma — the last one before the brace, which is how most of them are written —
     * ran the scan past the closing brace and on through the rest of the module until
     * it met a comma or a semicolon. Anything sanctioned further down the file then
     * excused it: a real `boxShadow: '0 8px 24px rgba(0,0,0,.3)'` on `PullCard`
     * passed because a focus ring three declarations later was inside its "value".
     * Mutation-tested: that object passes with the unbounded scan and fails with this
     * one. A closer arriving at depth zero is the end of the value, because it is the
     * end of the thing the value was written inside.
     */
    const valueAfter = (inline: string, from: number): string => {
      let quote = '';
      let depth = 0;
      for (let i = from; i < inline.length; i += 1) {
        const ch = inline[i]!;
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        else if (ch === '(' || ch === '{' || ch === '[') depth += 1;
        else if (ch === ')' || ch === '}' || ch === ']') {
          if (depth === 0) return inline.slice(from, i);
          depth -= 1;
        } else if ((ch === ',' || ch === ';') && depth === 0) return inline.slice(from, i);
      }
      return inline.slice(from);
    };

    // Only two of the four have a sanctioned form, and they are the two the
    // stylesheet checks above already exempt by name: `--focus-ring` is the single
    // shadow `docs/design.md` law 2 carves out — flagging it would tell a
    // contributor to delete an accessibility affordance — and `--radius` /
    // `--radius-sm` are the block and control radii. A gradient has no token that
    // makes it legal, and a `drop-shadow()` filter is a shadow the focus ring
    // cannot be written as, so neither carries an exemption at all.
    //
    // A property is matched by every spelling it has rather than by the camelCase
    // one, and unanchored on purpose. `\bbox-?[Ss]hadow` read `boxShadow` and
    // `WebkitBoxShadow` and not `'box-shadow'`, which is a quoted key React
    // accepts in the same object — so the plainest spelling of the banned thing,
    // the one lifted straight out of a stylesheet, was the one it could not see.
    // The optional closing quote is what lets a quoted key reach its colon.
    //
    // AND BY EVERY PROPERTY IN THE FAMILY, not the one everybody writes.
    // `border-?radius` read `borderRadius` and `border-radius` and missed
    // `borderTopLeftRadius`, which is four declarations away from a fully rounded
    // card and is the spelling a contributor reaches for when rounding one corner.
    // `box-?shadow` missed `textShadow` entirely — a different property, the same
    // law, and the one that does not need a box to blur. Both were verified past the
    // check before this line, on `PullCard`.
    //
    // AND THREE WAYS OF WRITING IT, because a colon is only one of them. `declared`
    // required `name:`, so `node.style.boxShadow = '0 10px 30px var(--ink)'` and
    // `node.style.setProperty('border-radius', '20px')` were both invisible — the same
    // pixels, set imperatively, which is how a component reaches for a value it cannot
    // put in a style object. Verified: four such lines on `PullCard` passed the suite.
    // `setProperty` is covered by the quoted-key branch already, since its first
    // argument is a quoted name followed by a comma rather than a colon.
    const declared = (name: string) =>
      new RegExp(`${name}['"\`]?\\s*(?::|=(?!=)|['"\`]\\s*,)`, 'giu');
    const banned: [RegExp, string, RegExp | null][] = [
      // `--focus-ring` is sanctioned as a BOX shadow only. A text-shadow spelt with it
      // would be decoration wearing an accessibility affordance's clothes.
      [declared('box-?shadow'), 'a shadow', ONLY_THE_RING],
      [declared('text-?shadow'), 'a shadow', null],
      [/\b(?:linear|radial|conic)-gradient\b|linearGradient|radialGradient/giu, 'a gradient', null],
      [/\bdrop-shadow\s*\(/giu, 'a shadow', null],
      [declared('border[a-z-]*radius'), 'a radius', /^var\(--radius(?:-sm)?\)$/u],
      /*
       * AND THE TOKENS THEMSELVES. `declared` matches a property name; a CSS custom
       * property is a property name the law never claimed, so
       * `style={{ '--radius': '20px' } as CSSProperties}` and
       * `documentElement.style.setProperty('--focus-ring', '0 10px 30px …')` both set
       * the value every check in this file reads and neither was seen. The
       * `as CSSProperties` idiom is already live in `Feed.tsx` and `Auth.tsx`, so it is
       * the natural spelling rather than a contrivance.
       *
       * No sanctioned form: a component has no business redefining the palette.
       */
      [declared('--radius[a-z-]*'), 'a radius token', null],
      [declared('--focus-ring[a-z-]*'), 'a shadow token', null],
      [declared('--accent[a-z-]*'), 'an accent token', null],
      // 7. A drop shadow drawn as an SVG filter, which `drop-shadow(` does not spell.
      [/\bfeDropShadow\b/gu, 'a shadow', null],
    ];

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        // `.jsx` and `.js` too: the walk read `/\.tsx?$/`, so a single JavaScript file
        // under either root could name any colour, shadow, gradient or radius it liked.
        else if (/\.[jt]sx?$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
          const src = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            // Line comments too: a commented-out `borderRadius` inside a style
            // object was flagged, which is a false failure on a diff that removed
            // the very thing this checks for.
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
          /*
           * THE WHOLE FILE, not just what sits between `style={{` and its brace.
           *
           * `inlineStyles` finds an object literal written in place, and that is the
           * only shape it finds. A style object bound to a name and passed as
           * `style={cardStyle}` walked straight past — verified with a `borderRadius:
           * '18px'`, a `boxShadow` and a `linear-gradient` on `PullCard`'s own
           * `<article>`: 31 tests passed. So did the conditional form, which is
           * already live at `apps/web/src/routes/Preferences.tsx` as
           * `style={mode === 'onboarding' ? { … } : undefined}` — not `style={{` at all.
           *
           * These property names are CSS-in-JS and mean one thing in a component, so
           * the honest scan is the file. It costs the ability to say which attribute
           * carried it, which was never what the message was for: the law is about
           * what reaches the page, not about how it was spelled on the way.
           */
          for (const [pattern, what, sanctioned] of banned) {
            // Every occurrence, not the first. `.match` stopped at one, so a
            // sanctioned `boxShadow: 'var(--focus-ring)'` written ahead of a
            // decorative `WebkitBoxShadow` hid it — the same laundering as the
            // value-scoping above, one property along.
            for (const declaration of src.matchAll(pattern)) {
              const value = valueAfter(src, (declaration.index ?? 0) + declaration[0].length);
              // The WHOLE value, quotes stripped, not a search inside it. As a search,
              // `borderRadius: 'var(--radius) 28px 28px var(--radius)'` was excused by
              // the two corners that were tokens — and the identical value in a `.css`
              // file is caught by `ROUND_BY_NATURE` below, which made the inline path
              // the weaker of the two. design.md says an inline literal is the WORSE
              // of the two.
              if (sanctioned?.test(value.trim().replace(/^['"`]|['"`]$/g, ''))) continue;
              offenders.push(`${entry.name}: ${what} in a style`);
            }
          }
        }
      }
    };
    for (const r of roots) walk(r);

    expect(
      offenders,
      `law 1 has no gradients and no shadows, and a radius belongs to a token:\n  ` +
        `${offenders.join('\n  ')}\n` +
        `Put the rule in styles/*.css against a var(--token).`,
    ).toEqual([]);
  });

  it('lets no colour literal into component source either', () => {
    // `COMPONENT_ROOTS`, so this reads the whole package as the inline-style walk
    // does. It read `components/` alone, which left the same gap that walk closed
    // last round: a file beside `components/` could name any colour it liked.
    const roots = COMPONENT_ROOTS;
    expect(roots.length, 'no component source found — this check would pass vacuously').toBe(2);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        // Tests carry palette literals on purpose — this file most of all.
        else if (/\.[jt]sx?$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
          const src = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
          for (const hit of src.match(COLOUR_LITERAL) ?? []) {
            offenders.push(`${entry.name}: ${hit}`);
          }
        }
      }
    };
    for (const r of roots) walk(r);

    expect(
      offenders,
      `a colour written in a component cannot be swapped by the theme or reached by the ` +
        `high-contrast setting:\n  ${offenders.join('\n  ')}\n` +
        `Use a var(--token) and define it in tokens.css.`,
    ).toEqual([]);
  });

  /**
   * Two ceilings, not one — a block may be 3px, a control 2px.
   *
   * Tightened from a flat 4px by the design session. The split is the point: at
   * the sizes a control is actually drawn, 4px is proportionally much rounder
   * than the same 4px on a card, so one number applied to both reads as candy on
   * the small thing and barely registers on the large one. The tokens carry the
   * distinction, which is why the check can be this short — `--radius` is the
   * block radius and `--radius-sm` the control radius, and every rule in the
   * repository uses one of them rather than a literal.
   */
  const MAX_RADIUS = { '--radius': 3, '--radius-sm': 2 };

  /*
   * A LAW-BEARING TOKEN IS DEFINED IN `tokens.css` AND NOWHERE ELSE.
   *
   * Round 5 made the radius and ring checks read every definition — in `tokens.css`.
   * `base.css` imports `tokens.css` and `index.css` imports `base.css` before
   * `components.css`, so an equal-specificity `:root` in any later stylesheet wins
   * outright and was read by nothing. Four lines appended to `components.css` —
   * `:root { --focus-ring: 0 10px 30px var(--ink-soft); --radius: 22px }` plus one
   * `box-shadow: var(--focus-ring)` — put a 30px drop shadow on every focusable element
   * in the product and a 22px corner on every block, with 121 tests green. That is
   * verbatim what the ring test's comment says it exists to prevent.
   *
   * Reading them from everywhere would work and would say the wrong thing. One palette
   * is the rule; a second definition is the defect, wherever it wins from.
   */
  it('defines a law-bearing token only in tokens.css', () => {
    const offenders: string[] = [];
    for (const f of [...notTokens, ...shellFiles]) {
      for (const [, name] of code(f).matchAll(/(--(?:radius|focus-ring|accent)[\w-]*)\s*:/g)) {
        offenders.push(`${label(f)}: ${name}`);
      }
    }
    expect(
      offenders,
      `a token every law in this file reads is defined outside tokens.css:\n  ` +
        `${offenders.join('\n  ')}\n` +
        `The cascade decides which one wins, and the checks below read tokens.css. ` +
        `Put it in tokens.css or give it a name no law claims.`,
    ).toEqual([]);
  });

  it('keeps corner radii small — candy rounding is the look being avoided', () => {
    const tokens = read('tokens.css');
    for (const [name, ceiling] of Object.entries(MAX_RADIUS)) {
      /*
       * EVERY definition, not the first. `tokens.css` has a `:root`, a
       * `prefers-color-scheme` block, a `[data-theme]` block and a contrast block, and
       * `.match` stopped at the 3px in `:root` — so one line inside the existing dark
       * block (`--radius: 22px`) candy-rounded every card and control in the product
       * for a reader in dark mode, with 119 tests green.
       */
      const values = [...tokens.matchAll(new RegExp(`${name}:\\s*([\\d.]+)px`, 'g'))].map((m) =>
        Number(m[1]),
      );
      expect(values.length, `no ${name} found in tokens.css`).toBeGreaterThan(0);
      for (const value of values) {
        expect(value, `${name} is too round`).toBeLessThanOrEqual(ceiling);
      }
    }
    for (const f of [...notTokens, ...shellFiles]) {
      // Every corner property, not just the shorthand: `border-top-left-radius: 18px`
      // is the same candy corner written one property along, and it was unmeasured.
      const literals = [...code(f).matchAll(/border-[a-z-]*radius:\s*([\d.]+)px/g)].map((m) =>
        Number(m[1]),
      );
      for (const px of literals) {
        // The block ceiling, since a literal does not say which it is. A control
        // that needs 2px should say `var(--radius-sm)` and be judged above.
        expect(px, `${label(f)} sets a ${px}px radius literal`).toBeLessThanOrEqual(
          MAX_RADIUS['--radius'],
        );
      }
    }
  });

  /**
   * The control radius has to be the one every focusable thing actually gets.
   *
   * `base.css` gives the focus ring `--radius-sm`, and that ring is drawn around
   * every button, input and `[tabindex]` in the product — so that one declaration
   * is where the control ceiling is really enforced. Pinned because the two could
   * drift silently: tightening `--radius-sm` does nothing for controls if the
   * ring stops using it, and nothing else in this file reads base.css.
   */
  /**
   * And the exemption has to be worth granting.
   *
   * Every shadow check in this file — the stylesheet one and the inline one — lets
   * `--focus-ring` through unconditionally, and nothing looked at what the token
   * actually is. So redefining it in `tokens.css` to
   * `0 10px 30px rgba(0,0,0,.4), 0 0 0 2px var(--accent)` gives every focusable
   * element in the product a real drop shadow, with all 31 tests green: one line,
   * and the law is gone everywhere it is enforced.
   *
   * A ring is spread with no blur and no offset. Each layer must therefore read
   * `0 0 0 <spread>` — two zero offsets, a zero blur, then the ring's thickness.
   * That is what the token is today and what makes the exemption defensible.
   */
  it('keeps the focus ring a ring, since every shadow check exempts it', () => {
    /*
     * EVERY `--focus-ring…` token and every block it is defined in.
     *
     * `.match` read the `:root` definition and stopped, so one line inside the existing
     * dark block — `--focus-ring: 0 10px 30px rgb(0 0 0 / 55%)` — put a real drop
     * shadow on every focusable element in the product with the suite green. That is
     * verbatim the failure this test's own comment says it exists to prevent: "one
     * line, and the law is gone everywhere it is enforced."
     *
     * And the name is a prefix rather than a constant, because `--focus-ring-lift`
     * carries the exempted string as a substring and was neither checked here nor
     * refused by the shadow laws that read `.includes('--focus-ring')`. `ONLY_THE_RING`
     * closes the second half of that; this closes the first.
     */
    const definitions = [...read('tokens.css').matchAll(/(--focus-ring[\w-]*):\s*([^;]+);/g)].map(
      (m) => [m[1]!, m[2]!.trim()] as const,
    );
    expect(definitions.length, 'no --focus-ring token found in tokens.css').toBeGreaterThan(0);
    for (const [name, value] of definitions) {
      for (const layer of value.split(/,(?![^(]*\))/)) {
        const lengths = layer.trim().match(/(^|\s)-?[\d.]+(px|rem|em)?(?=\s|$)/gu) ?? [];
        expect(
          lengths.length,
          `"${layer.trim()}" is not a ring layer — expected offset, offset, blur, spread`,
        ).toBeGreaterThanOrEqual(3);
        const [x, y, blur] = lengths.map((n) => Number.parseFloat(n));
        expect(
          [x, y, blur],
          `${name} layer "${layer.trim()}" has an offset or a blur, which makes it ` +
            `a drop shadow. Every shadow check in this file exempts this token by name, so ` +
            `a blur here is a blur on every focusable element in the product.`,
        ).toEqual([0, 0, 0]);
      }
    }
  });

  it('draws the focus ring at the control radius, not the block radius', () => {
    const ring = read('base.css').match(/:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
    expect(ring, 'no :focus-visible rule found in base.css').not.toBe('');
    expect(ring, 'the focus ring no longer uses the control radius').toMatch(
      /border-radius:\s*var\(--radius-sm\)/,
    );
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

    for (const f of [...notTokens, ...shellFiles]) {
      for (const [, selector, body] of rules(f)) {
        const radius = body!.match(/border-[a-z-]*radius:\s*([^;]+)/)?.[1]?.trim();
        if (!radius) continue;
        // The px form is judged by the assertion above; anything else lands here.
        // A bare `0` is not a unit slip — it is the flattest a corner gets, and
        // the one value this law could never object to.
        if (/^0[a-z%]*$/i.test(radius)) continue;
        if (/^[\d.]+px$/.test(radius) || /^var\(--radius(-sm)?\)$/.test(radius)) continue;

        const sel = selector!.trim();
        if (sel.split(',').every((one) => ROUND_BY_NATURE.has(one.trim()))) continue;
        offenders.push(`${label(f)}: ${sel} sets border-radius: ${radius}`);
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
    // Any token in the accent family, not the two names this happened to know.
    // `--accent-cool: #1a73e8` in `tokens.css` — which the colour check exempts — plus
    // one `var(--accent-cool)` in a stylesheet gave the product a second accent with
    // every test green. Design law 3 is "one accent colour", not "two token names".
    // Anchored on a line start OR a `{` OR a `;`, because a declaration does not need
    // its own line. `:root { --accent-cool: #1a73e8; }` written on one line slipped a
    // second accent past `^\s*` — prettier would split it, and "the formatter caught
    // it" is not the same as "the law caught it".
    const accents = [...tokens.matchAll(/(?:^|[;{])\s*(--accent[\w-]*):\s*([^;]+);/gm)];
    // One --accent and one --accent-hover per theme block; every value must
    // resolve to the oxblood family, never a second hue.
    const values = new Set(accents.map((m) => `${m[1]!} ${m[2]!.trim()}`));
    for (const v of values) {
      expect(v, 'a second accent colour was introduced').toMatch(
        /var\(--oxblood(-soft)?\)|#(8c2f26|a8433a|c96a5f|dc8074)/i,
      );
    }

    /*
     * AND THE PALETTE ITSELF IS A NAMED LIST.
     *
     * The check above reads what `--accent…` is ASSIGNED. `--brand-blue: #1a73e8`
     * beside `--oxblood`, plus `--accent: var(--brand-blue)` in another stylesheet,
     * painted every accent in the product Google blue and satisfied it. `tokens.css`
     * is exempt from the colour law because it IS the palette, so the palette is the
     * one file a stray hue can hide in — and a hue nothing points at yet is a hue
     * waiting for a `var()`.
     *
     * A list rather than a rule, like `ROUND_BY_NATURE`: sixteen names hold a raw hex
     * and every one of them is an ink, a surface, a rule, a warm tint or the accent
     * family. A seventeenth has to be argued for here.
     */
    const PALETTE = new Set([
      '--accent',
      '--accent-hover',
      '--bone',
      '--bone-raised',
      '--ink',
      '--ink-soft',
      '--oxblood',
      '--oxblood-soft',
      '--surface',
      '--surface-raised',
      '--text',
      '--text-faint',
      '--text-muted',
      '--text-soft',
      '--warm',
      '--warm-faint',
    ]);
    const strays = [...tokens.matchAll(/(--[\w-]+):\s*#[0-9a-fA-F]{3,8}\s*;/g)]
      .map((m) => m[1]!)
      .filter((name) => !PALETTE.has(name));
    expect(
      [...new Set(strays)],
      `a colour token outside the palette:\n  ${[...new Set(strays)].join('\n  ')}\n` +
        `Every hue in tokens.css is an ink, a surface, a rule, a warm tint or the accent. ` +
        `A new one is a second accent as soon as anything points at it — add it to ` +
        `PALETTE here if it genuinely is not.`,
    ).toEqual([]);
  });

  /**
   * Two settings that both mean "bigger" must never subtract from each other.
   *
   * Focus and large text are independent switches that both raise the reading
   * scale, and they set three of the same custom properties. Equal specificity,
   * `[data-text='large']` written second — so it won outright, and on a 1280px
   * screen in focus mode turning large text ON cut the body from 22.88px to 19px.
   * A control whose entire promise is "bigger" made things smaller, and nothing
   * here noticed because every assertion in this file reads one block at a time.
   *
   * Pinned as a relationship rather than as a list of values: any property BOTH
   * blocks set has to be composed in the combined block, so adding `--step-3` to
   * large text later fails here until it is composed too. `max()` is required
   * specifically because it is the only composition that cannot take size away —
   * large text is a floor, focus is a fluid ceiling, and the larger of the two is
   * what honours both.
   */
  it('composes focus mode and large text instead of letting one cancel the other', () => {
    const tokens = read('tokens.css');
    const block = (selector: string) =>
      tokens.match(new RegExp(`${selector}\\s*\\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
    const props = (b: string) => new Set([...b.matchAll(/(--[\w-]+):/g)].map((m) => m[1]!));

    const focus = block(":root\\[data-focus='on'\\]");
    const large = block(":root\\[data-text='large'\\]");
    const both = block(":root\\[data-focus='on'\\]\\[data-text='large'\\]");
    expect(focus, 'no [data-focus=on] block').not.toBe('');
    expect(large, 'no [data-text=large] block').not.toBe('');

    const contested = [...props(focus)].filter((n) => props(large).has(n));
    expect(
      contested.length,
      'the two blocks no longer overlap — if that is deliberate, delete this test',
    ).toBeGreaterThan(0);

    expect(
      both,
      `${contested.join(', ')} are set by both focus mode and large text, and there is no ` +
        `combined block — so whichever is written last silently wins and one setting undoes ` +
        `the other.`,
    ).not.toBe('');

    const composed = props(both);
    for (const name of contested) {
      expect(
        composed.has(name),
        `${name} is set by both settings but not composed in the combined block, so turning ` +
          `one on can shrink what the other grew.`,
      ).toBe(true);
      const value = both.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1] ?? '';
      expect(
        value,
        `${name} composes to "${value}" — use max(), the only combination that cannot make ` +
          `either setting smaller than it is on its own.`,
      ).toMatch(/^max\(/);
      /*
       * And composed from the live values, not copies of them. `max()` of two stale
       * literals is still `max()`, and it passes the assertion above while the bug is
       * back: verified by changing large text's `--step-0` to 1.375rem, which
       * reproduces the original shrink at 375px with every test green. Referencing
       * the operands makes the combined block impossible to leave behind.
       */
      expect(
        value,
        `${name} composes from a literal — "${value}". Copy the two settings' values in ` +
          `here and this block is correct only until one of them is tuned, silently. ` +
          `Name each value once in its own block and compose the var()s.`,
      ).not.toMatch(/\d+(\.\d+)?(rem|px|em)/);
    }
  });

  /**
   * A reading control has to grow with the reading.
   *
   * Focus mode raises the reading steps and deliberately leaves `--step--1` alone,
   * so the chrome does not grow with the prose and reclaim the room the setting
   * just freed. That is right for a chip and wrong for the Depth Dial, which is set
   * in the same mono face but is the control the reader turns most: measured before
   * this was fixed, focus mode took body copy from 16.96px to 22.88px and left the
   * dial at 13px, so asking for bigger reading made the control relatively smaller.
   *
   * Pinned as a derivation rather than a pair of values, because that is what makes
   * it hold for every future mode as well — anything that moves `--step-0` moves the
   * dial with it, and nothing has to remember to.
   */
  it('sizes the depth dial from the reading step, so focus mode carries it', () => {
    const tokens = read('tokens.css');
    const defs = [...tokens.matchAll(/--step-dial:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(defs.length, '--step-dial should be defined exactly once, as a derivation').toBe(1);
    expect(
      defs[0],
      `--step-dial is "${defs[0]}" — a constant here refreezes the dial the moment a ` +
        `mode changes --step-0, which is the bug this replaced.`,
    ).toMatch(/var\(--step-0\)/);
    /*
     * And a floor at the furniture step, for the same fault pointing the other way.
     * Large text raises `--step--1` further than `--step-0`, so a bare ratio put the
     * dial at 15.2px beside a 16px chip — the control smaller than the metadata
     * around it.
     */
    expect(
      defs[0],
      `--step-dial is "${defs[0]}" — without a max(var(--step--1), …) floor, a mode ` +
        `that raises the metadata step further than the body step leaves the dial ` +
        `smaller than the chip beside it.`,
    ).toMatch(/max\(\s*var\(--step--1\)/);

    /*
     * Every rule that names the stop, not just the first. `.match` returned the
     * grouped `font-size: var(--step-dial)` declaration and stopped there — so a
     * later standalone rule could set `font-size: var(--step--1)`, refreeze the dial,
     * win the cascade on source order, and leave this assertion green.
     */
    const dialRules = [
      ...read('components.css').matchAll(/([^{}]*\.pull-card__stop-btn[^{}]*)\{([^}]*)\}/g),
    ];
    expect(dialRules.length, 'no .pull-card__stop-btn rule found').toBeGreaterThan(0);
    for (const [, selector, body] of dialRules) {
      expect(body, `${selector!.trim()} sizes the dial from the furniture step again`).not.toMatch(
        /font-size:\s*var\(--step--1\)/,
      );
    }
  });

  /**
   * A finger needs 44px; a cursor does not.
   *
   * Both platforms publish 44px as the floor, and the dial's stops were 31px — the
   * smallest controls in the product and the ones a reader taps most.
   *
   * The gate is asserted as well as the number, and specifically `any-pointer`. A
   * width query would miss a touch laptop and inflate a narrow desktop window; but so
   * does plain `pointer: coarse`, which describes only the PRIMARY input — a 2-in-1
   * with a trackpad reports `pointer: fine` and kept 31px targets under a finger.
   * `any-pointer: coarse` is true when any available input is coarse, which is the
   * question the rule means to ask.
   */
  it('gives the dial a real touch target where the pointer is coarse', () => {
    const css = read('components.css');
    const coarse = [...css.matchAll(/@media \(any-pointer: coarse\)\s*\{[\s\S]*?\n\}/g)]
      .map((m) => m[0])
      .filter((b) => b.includes('.pull-card__stop-btn'));
    expect(coarse.length, 'no (any-pointer: coarse) rule sizes the dial stops').toBe(1);

    const rem = Number(coarse[0]!.match(/min-height:\s*([\d.]+)rem/)?.[1]);
    expect(
      rem * 16,
      `the dial's touch target is ${rem * 16}px — below the 44px both platforms publish`,
    ).toBeGreaterThanOrEqual(44);
  });

  /**
   * The dial's stacked position is a rule, not an accident of source order.
   *
   * Worth pinning because it already went missing once: an edit removed the
   * `.pull-card__spread` rule entirely and the card still *looked* fine — the div
   * fell back to block layout and the children stacked in DOM order — so the dial
   * sat under the argument on every desktop with nothing failing. A layout that
   * degrades into something plausible is exactly the kind that needs an assertion
   * rather than an eye.
   */
  it('lifts the dial above the idea on anything wider than a phone', () => {
    const css = read('components.css');
    expect(css, 'no .pull-card__spread rule — the stack is falling back to block layout').toMatch(
      /\.pull-card__spread\s*\{[^}]*flex-direction:\s*column/,
    );

    const lift = css.match(/@media \(min-width: [\d.]+rem\)\s*\{\s*\.pull-card__dial\s*\{[^}]*\}/);
    expect(
      lift?.[0],
      'nothing lifts the dial above the reading column, so a reader at the deepest ' +
        'stop scrolls past the whole argument to reach the control that shortens it',
    ).toMatch(/order:\s*-1/);
  });

  it('respects prefers-reduced-motion', () => {
    const all = cssFiles.map(read).join('\n');
    expect(all).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('defines a visible focus ring and never removes focus outright', () => {
    const all = cssFiles.map(code).join('\n');
    expect(all).toMatch(/:focus-visible/);
    // `outline: none` is only acceptable where a focus ring replaces it.
    for (const f of [...cssFiles, ...shellFiles]) {
      const blocks = code(f).split('}');
      for (const b of blocks) {
        if (/outline:\s*(none|0)/.test(b)) {
          expect(b, `${label(f)} removes focus without providing a ring`).toMatch(/box-shadow/);
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
/**
 * A column width is a token, or it is drift.
 *
 * `--measure` is 34rem and is RE-DERIVED from `--step-0` under focus mode and large
 * text, so it follows the reader's type setting; `.measure` in `components.css` is how
 * a screen asks for it. A `maxWidth: '42rem'` written into a component is neither: it
 * is ~82 characters a line instead of ~66, and it stays 42rem when a reader turns on
 * large text — the one setting a reading column exists to respect. `docs/design.md`:
 * "The reading column stays at `--measure` at every screen size", and "a new fixed
 * `rem` dimension inside a layout rule is a smell".
 *
 * The law checked only that no stylesheet REDEFINES `--measure`, so an inline width in
 * a route was outside every assertion in this file.
 *
 * `KNOWN_WIDE` is the debt, named rather than exempted by pattern, and the list is the
 * point exactly as it is for `ROUND_BY_NATURE`. The first version of this paragraph said
 * all three are wide grid containers, and that was true of one: `App.tsx` renders
 * `MetacognitiveDashboard` and `OnboardingDemo` inside `<div className="shell__column">`,
 * which `components.css` pins at `max-width: var(--measure)` — so their 42rem is
 * `min(--measure, 42rem)` and never binds. They are DEAD, not wide. `Specimen.tsx`
 * returns before the shell and genuinely is wide.
 *
 * They stay listed because deleting a dead declaration belongs to the change that owns
 * the screen, and because a value that never binds is exactly what somebody would widen
 * without noticing. A fourth entry has to be argued for here, and "it is inside the
 * shell column so it does not matter" is an argument for deleting it instead.
 */
const KNOWN_WIDE = new Map([
  ['MetacognitiveDashboard.tsx', '42rem'],
  ['OnboardingDemo.tsx', '42rem'],
  ['Specimen.tsx', '48rem'],
]);

describe('The Archive measure law', () => {
  it('sets a column width from the token, or says why not', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.[jt]sx?$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
          const src = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
          /*
           * EVERY SPELLING, and a value that is not a literal.
           * `maxInlineSize` is the logical form of the same property and React passes it
           * straight through; `maxWidth: COLUMN` with `const COLUMN = '60rem'` hides the
           * literal one binding away. Both passed. A non-literal value is flagged rather
           * than resolved: this law cannot evaluate an identifier, and saying so is
           * better than pretending the identifier is a token.
           */
          for (const m of src.matchAll(
            /max-?(?:[Ww]idth|[Ii]nline[Ss]ize)['"`]?\s*:\s*([^,\n}]+)/g,
          )) {
            const raw = m[1]!.trim().replace(/^['"`]|['"`]$/g, '');
            if (raw.startsWith('var(') || /^\d+%$/.test(raw) || raw === 'none') continue;
            if (KNOWN_WIDE.get(entry.name) === raw) continue;
            offenders.push(`${entry.name}: max-width ${raw}`);
          }
        }
      }
    };
    for (const r of COMPONENT_ROOTS) walk(r);

    expect(
      offenders,
      `a column width written into a component does not follow the reader's type ` +
        `setting:\n  ${offenders.join('\n  ')}\n` +
        `Use className="measure" or var(--measure), or add the file to KNOWN_WIDE with ` +
        `a reason it is not a reading column.`,
    ).toEqual([]);
  });

  it('keeps KNOWN_WIDE honest', () => {
    // An entry whose file or value has moved on is an exemption nobody is checking.
    for (const [file, value] of KNOWN_WIDE) {
      const found = COMPONENT_ROOTS.flatMap((r) => filesUnder(r, (n) => n === file));
      expect(found.length, `KNOWN_WIDE names ${file}, which no longer exists`).toBeGreaterThan(0);
      /*
       * In a DECLARATION, not anywhere in the file. `toContain(value)` read the raw
       * source including comments, so `// (Was 42rem.)` beside a `maxInlineSize: '72rem'`
       * satisfied the exemption while the file was 72rem and the offender walk skipped
       * it on the same string. An exemption nobody checks is an exemption.
       */
      const src = found
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      const declared = [
        ...src.matchAll(/max-?(?:[Ww]idth|[Ii]nline[Ss]ize)['"`]?\s*:\s*['"`]([^'"`]+)['"`]/g),
      ].map((m) => m[1]!.trim());
      expect(
        declared,
        `KNOWN_WIDE says ${file} is ${value}, and no declaration in it says so`,
      ).toContain(value);
    }
  });
});

describe('The Archive viewport laws', () => {
  it('never uses vh — mobile chrome makes it taller than the visible area', () => {
    // `100vh` puts primary actions underneath the address bar on exactly the devices
    // where a mis-placed button is hardest to recover from. `dvh`/`svh` are the
    // measurements that describe what the reader can actually see.
    for (const f of [...cssFiles, ...shellFiles]) {
      // `lvh` is the LARGE viewport height, which is the one `100vh` already means and
      // the one that hides a button under mobile chrome. Matching `vh` alone let it
      // straight through, spelled differently.
      // `vmax` resolves to the large viewport height in portrait, which is the same
      // address-bar bug spelled a third way.
      const vh = [...code(f).matchAll(/\b\d*\.?\d+(?:l?vh|vmax)\b/gi)].map((m) => m[0]);
      expect(vh, `${label(f)} uses ${vh.join(', ')} — use dvh or svh`).toEqual([]);
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
    for (const f of [...notTokens, ...shellFiles]) {
      expect(code(f), `${label(f)} redefines --measure`).not.toMatch(/--measure:\s*[^;]+;/);
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

    /*
     * `(?!@media)` matters, and it is the same flaw `ownRule` above is written to
     * avoid — noted there for selectors and missed here for media blocks. A plain
     * `[\s\S]*?` walks straight out of one `@media` and into the next, so the moment
     * ANY min-width query was added to the stylesheet ahead of the rail's, this
     * matched from that unrelated query down to `.shell__rail { display: block }` and
     * reported its width as the rail's. Adding a 34rem query for the Depth Dial made
     * it read 34rem and fail a law that was not being broken.
     */
    const showsRailAt = [
      ...all.matchAll(
        /@media \(min-width: ([\d.]+)rem\)\s*\{(?:(?!@media)[\s\S])*?\.shell__rail\s*\{[^}]*display:\s*block/g,
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
  /*
   * THE PALETTE MOST DARK READERS ACTUALLY GET, which neither of the two above is.
   *
   * `[data-theme='dark']` is the explicit choice. The DEFAULT is "system", which stamps
   * no attribute at all — `CLAUDE.md` says so — so a reader whose OS is dark is served
   * `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { … } }`, and
   * the legibility floor and the high-contrast reach test read neither of them.
   * Changing only that block to `--text-muted: #4a453d` and `--text-faint: #3a352e`
   * gives 1.97:1 and 1.43:1 — effectively invisible text — with the suite green. That is
   * the same shape as the 2.72:1 `--text-faint` failure this block was written about,
   * one selector along, on the palette more readers see than either of the others.
   */
  const systemDarkBlock =
    tokens.match(
      /@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?:root:not\(\[data-theme='light'\]\)\s*\{[\s\S]*?\n {2}\}/,
    )?.[0] ?? '';

  /**
   * Every text token clears the floor, and there is no list of exceptions.
   *
   * There used to be one — `--text-faint` sat at 2.72:1 as "ornament", with a
   * second allow-list naming the selectors permitted to paint with it, and a
   * third check policing that list. All of it existed to hold one token below the
   * line, and the exemption was self-justifying: because faint was ornament it
   * did not need to clear 4.5:1, and because it did not clear 4.5:1 the
   * high-contrast setting had nothing to rescue — so a reader who asked for more
   * contrast got exactly the same 2.72:1 from every rule that had adopted it.
   *
   * The amended law is "no text role below 4.5:1 against its own ground, faint
   * included", so the token was raised and the machinery deleted. A `·` set in a
   * legible colour costs nothing; a word a reader cannot make out costs them the
   * word. If a future token genuinely is not text, it should not be named
   * `--text-*`.
   */
  it.each([
    ['light', () => lightBlock],
    ['dark', () => darkBlock],
    ['system dark', () => systemDarkBlock],
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
      for (const [label, ground] of [
        ['--surface', surface!],
        ['--surface-raised', raised!],
      ] as const) {
        const ratio = contrast(p.get(name)!, ground);
        expect(
          ratio,
          `${theme}: ${name} on ${label} is ${ratio.toFixed(2)}:1 — docs/design.md requires ` +
            `4.5:1 for every text role, faint included. There is no ornament exemption: ` +
            `move the token, or stop calling it text.`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
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

  /**
   * High contrast has to reach every text role a reader might struggle with.
   *
   * This assertion used to run the other way: it checked that a token exempt from
   * the floor was NOT remapped here, which made the exemption airtight in both
   * directions and protected nobody. With the exemption gone, the useful question
   * is the opposite one — a reader who turns this on is telling us the default
   * palette is not working for them, and a role the setting cannot reach is a
   * role that ignores them.
   *
   * The threshold is comfort rather than the 4.5:1 floor: a token already at 13:1
   * has nothing to gain from being remapped to `--text`, while everything in the
   * 4.5–7 band is exactly what someone enables this for.
   */
  const COMFORTABLE = 7;

  it.each([
    ['light', () => lightBlock],
    ['dark', () => darkBlock],
    ['system dark', () => systemDarkBlock],
  ])(
    'lets high contrast reach every %s text role that is not already comfortable',
    (theme, get) => {
      const high = tokens.match(/:root\[data-contrast='high'\]\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
      expect(high, 'no [data-contrast=high] block found').not.toBe('');
      const remapped = new Set([...high.matchAll(/(--[\w-]+):/g)].map((m) => m[1]!));

      const p = palette(get());
      const grounds = [p.get('--surface')!, p.get('--surface-raised')!];

      for (const name of [...p.keys()].filter((n) => n.startsWith('--text'))) {
        const worst = Math.min(...grounds.map((g) => contrast(p.get(name)!, g)));
        if (worst >= COMFORTABLE) continue;
        expect(
          remapped.has(name),
          `${theme}: ${name} sits at ${worst.toFixed(2)}:1 — inside the band a reader enables ` +
            `high contrast for — but [data-contrast='high'] does not remap it, so turning the ` +
            `setting on changes nothing for any rule that uses it.`,
        ).toBe(true);
      }
    },
  );

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
    // Same roots as every other component walk. A `className="btn …"` written in a
    // file beside `components/` was not collected, so the rule styling that class
    // was judged as though markup never paired it with a button.
    const roots = COMPONENT_ROOTS;
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
    for (const f of [...cssFiles, ...shellFiles]) {
      for (const [, selector, body] of rules(f)) {
        if (!/font-family:\s*var\(--font-display\)/.test(body!)) continue;
        // The bare class this rule styles, if markup ever pairs it with `btn`.
        const named = [...selector!.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
        if (!named.some((c) => withButton.has(c))) continue;

        const clearsTransform = /text-transform:\s*(?!uppercase)[\w-]+/.test(body!);
        const clearsTracking = /letter-spacing:\s*/.test(body!);
        if (!clearsTransform || !clearsTracking) {
          offenders.push(
            `${label(f)}: ${selector!.trim()} — ` +
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
