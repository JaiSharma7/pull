# The Archive — design system

## The brief

Deepstash is bright pastel gradients, candy-rounded cards, playful illustration, and a
soft rounded sans. **We are the opposite of that**: ink on paper, high-contrast serif
display, hairline rules, generous margins, one saturated accent.

The reference is a well-set periodical or a library reading room — not a mobile game.
This is not only differentiation; it is the right choice for a product whose core
activity is _reading something worth keeping_.

## Tokens

```css
--bone: #f4f1ea; /* page ground, light */
--ink: #14120e; /* text; also the dark-mode ground */
--oxblood: #8c2f26; /* THE accent — there is only one */
--warm: #6b6459; /* secondary text */
--rule: rgba(20, 18, 14, 0.12);
```

Dark mode is **ink-ground**: `--ink` becomes the surface and `--bone` the text. It is
not an inverted candy palette, and the accent does not change.

## Type

| Role     | Face                                              | Scale                     |
| -------- | ------------------------------------------------- | ------------------------- |
| Display  | **Fraunces** — variable serif with optical sizing | 42/44, tightened tracking |
| Body     | **Inter**                                         | 16/26                     |
| Metadata | **JetBrains Mono**                                | 12/16, uppercase, +0.08em |

All three are OFL-licensed, which an open-source project requires. Fraunces' optical
sizing axis is the reason it is here: it holds up at both 42px headline and 14px chip.

## The mark

A magician's top hat: bone on ink in the icon files, the reader's ink with an oxblood
band in the masthead. The product is named for the thing pulled out of it, so the hat is
the half you can draw — and it is drawn flat, with no gradient and no shadow, like
everything else here.

It stays small. The sentence is the brand, so beside the wordmark the hat sits at
roughly the word's cap height and no more; a big logo is what a product does when it has
nothing to say.

Three proportions carry the silhouette at 16px, which is where a favicon is actually
read: the lit crown (what the band leaves showing) is 1.35:1 tall, the brim is over
three times the crown's width, and the brim is a **swept crescent** rather than a bar —
one ellipse subtracted from the same ellipse lifted above it, which raises its tips
clear of the crown. Drawn as a flat rectangle it reads as a plinth, not a hat.

It is written twice and neither copy is decorative. `scripts/gen-icons.mjs` generates
`favicon.svg` and the PWA icons — this repo has no rasteriser, so the PNGs are encoded
from a pixel buffer — and `packages/ui/src/components/Mark.tsx` draws the same hat in
the top bar. `Mark.test.ts` compares the component against the _generated_ favicon, so
neither a divergent tweak nor a stale icon in `public/` gets through. Re-run
`node scripts/gen-icons.mjs` after any change to either, and look at the result at 16px
rather than reasoning about it.

## Laws

1. No gradients on any surface. Flat ground plus paper grain.
2. No `box-shadow` for elevation. Separate with hairline rules. The single exception is
   a focus ring, where it is an accessibility affordance.
3. One accent colour. If something needs emphasis and oxblood is taken, use weight,
   size, or space.
4. `border-radius` ≤ 3px on blocks, ≤ 2px on controls. Candy rounding is precisely the
   look we avoid, and one number for both is too loose: at the size a button is drawn,
   the same radius reads far rounder than it does on a card. `--radius` and
   `--radius-sm` carry the two; a rule should use one rather than a literal.
5. Colour is never the only signal.
6. No hardcoded colour outside `tokens.css` — in any notation, and in component source
   as well as stylesheets. An inline `style={{ color: '#…' }}` is worse than a
   stylesheet literal rather than equivalent: the theme blocks cannot override it, so
   the panel keeps its light-mode colours in the dark theme and ignores the
   high-contrast setting completely.
7. **The session has visible edges.** See below — this is the law that separates the
   product from a feed, so it constrains layout as hard as the others constrain colour.

## The viewport

### Law 7 — a session must show its bounds

Shorts and Reels are the anti-pattern, and they are engineered rather than careless.
They go full-bleed, hide every piece of chrome, and keep the next item already sliding
into frame. The reader is never shown how much is left, because there is no "left" — the
runway is infinite by construction, and that is the whole mechanism.

This product's claim is the opposite: _enough for today_. A bounded sitting that ends,
with a number attached to what it was worth. That claim is not made by copy, it is made
by layout. So:

- **Never full-bleed.** The reading column stays at `--measure` at every screen size.
  Extra width buys structure and peripheral context; it never buys a longer line.
- **The rails stay on screen** above 60rem. They _are_ the edges. What they show — what
  this session has done, what the Delta spared you — is the visible evidence that a
  session is a finite thing.
- **Never slide the next card into frame.** Advancing is the reader's act.
- **The end is a screen, not an absence.** `Enough` exists because a feed that merely
  runs out of content has told the reader nothing.

A useful test: if a screenshot of this app could be mistaken for a video feed with the
sound off, the layout is wrong.

### Navigation is a rail on a laptop and a bar on a phone

Above 63rem the rail carries every destination and is one of law 7's visible edges.
Below it there is no room for a rail, and what used to happen instead was that all
thirteen destinations wrapped across the masthead — four rows on a 393px viewport,
roughly a fifth of the screen spent before the first sentence, and spent at the far end
of the phone from the hand holding it.

So below 63rem they move to a bar across the bottom: four slots and a "More"
disclosure, which is what both mobile platforms settle on and for the same reason — five
is what a thumb can reach across at the 44px minimum. `splitNav` decides the split;
`DESTINATIONS` and `SECTIONS` in `App.tsx` decide the order, and the order is now
load-bearing, because the first four are what a phone shows.

**A bottom bar is the shape a video feed uses to dissolve its edges, so it has to earn
its place against law 7 rather than beside it.** What separates the two: this one is
opaque and separated by a hairline instead of floating over the content, it names places
rather than offering gestures, it marks the one you are on, and it is `position: sticky`
so it comes to rest after the colophon at the end of the document instead of hovering
over an infinite runway. Sticky is also what keeps the reading column honest — a fixed
bar would need bottom padding equal to its own height, which is exactly the fixed `rem`
dimension the section below warns about, and which is wrong the moment a label wraps or
a reader turns large type on.

The two navigations are one array rendered twice, never two lists. They used to filter
`DESTINATIONS` separately, which is how the masthead and the rail came to disagree about
what a reader may reach.

### Touch is not a narrow mouse

Two rules, both keyed on the input rather than on the width — a narrow desktop window is
still a mouse, and the laptop layout is not the one that needed changing.

- **`@media (pointer: coarse)`: every control clears 44px**, the floor in Apple's HIG and
  in WCAG 2.5.5. `.btn` took its height from type plus padding and landed at 39px, on
  every control on every screen. Where a control is a single glyph or a short word, the
  minimum applies to width too: a full-height target a thumb misses sideways is still a
  miss. Where a control has a separate `<label for>`, the label is the target and the
  label is what gets the minimum.
- **`@media (hover: hover)`: every `:hover` rule is guarded.** iOS has no pointer to move
  away, so Safari resolves `:hover` on tap and keeps it resolved until something else is
  tapped — leaving the last thing pressed looking permanently selected, in contradiction
  to the `aria-current` marker that actually means it. Where a rule pairs `:hover` with
  `:focus-visible`, only the hover half is guarded.

Neither is visible in a screenshot, which is why `pnpm record` measures for both on every
phone-shaped pass. See `docs/testing-accounts.md`.

### Dimensions adapt to the machine, continuously

A reader on a Surface Laptop, a MacBook and a 27-inch monitor should each get a layout
proportioned for what they actually have — not one of three fixed layouts chosen by
whichever breakpoint they happen to fall past.

Three things vary, and only one of them used to be considered.

```
                width           height        density
                ─────           ──────        ───────
16:9 laptop     1920            1080          scaling 100–125%
Surface 3:2     1504 @150%      1002          scaling 150–200%, so CSS px
                1128 @200%       752          differ by 33% on the SAME screen
MacBook 16:10   1512             982
27" monitor     2560            1440
```

- **Width** was handled, but in two jumps. The rails are now `clamp()`ed, so a 70rem
  window is proportioned for 70rem instead of for 60. The reading column is exempt on
  purpose: it is the one dimension that must not respond.
- **Height** was not considered at all. Every rule keyed on width alone, which silently
  assumes 16:9. A 3:2 Surface at 200% scaling has just 47rem of height, and that is
  where a card, its rails and the tally stop fitting together. Under 48rem the vertical
  rhythm tightens and display type drops a step — spacing gives, context never does.
- **Density** belongs to the reader, and is why the type scale is `clamp(rem + vw, …)`
  rather than pure `vw`. A pure viewport scale ignores an OS or browser font-size
  preference completely; keeping a `rem` term means a reader who has asked for larger
  text still gets it. This matters more here than in most products, because Windows
  laptops ship at 150% scaling by default and the reader usually did not choose it.

Consequences, and they are not optional:

- Type is a fluid scale, never fixed steps. A window dragged from 1000px to 1400px
  should change continuously rather than stay still and then jump.
- Use `dvh`/`svh`, never `vh`. Mobile browser chrome makes `vh` taller than the visible
  area, which puts primary actions underneath the address bar.
- Test at 375×667, **1128×752** (Surface at 200%), 1504×1002 (Surface at 150%) and
  1920×1080. The second is the tight one, and the one most likely to be skipped.
- A new fixed `rem` dimension inside a layout rule is a smell. Ask what it should be
  proportional to before writing it.

## Card anatomy

```
┌─────────────────────────────────┐
│ MEDITATIONS · MARCUS AURELIUS   │  ← mono chip, warm grey
│ ─────────────────────────────── │  ← hairline rule
│                                 │
│ What blocks the way             │  ← Fraunces display
│ becomes the way.                │
│                                 │
│ An obstruction is not only an   │  ← Inter body
│ interruption of the work. It is │
│ often the material it is made   │
│ of.                             │
│                                 │
│ ── bk.5 ──────── SAVE  ASK  ♪   │  ← source trail + actions
└─────────────────────────────────┘
```

The flip reveals _Why this matters_, the full source trail (chapter or timestamp →
evidence → the original), and Counterpoint · Example · Ask.

The example is a real seeded Pull rather than an invented one, and deliberately from a
public-domain work. This used to illustrate the card with an in-copyright bestseller,
which is a small thing and exactly the small thing law 4 is about: a repository whose
rule is that only public-domain material is committed should not reach for a title under
copyright the moment it needs a plausible example.

## Accessibility

Ships in round one, not "later", and the reason is the first line of this document: if
typography is the ornament, then legible type, real focus states and honest semantics are
the product rather than a compliance exercise laid over it.

Enforced rather than intended: `jsx-a11y` rules are lint **errors** in
`eslint.config.js`, so an unlabelled control fails CI in the same way a type error does.

- Full keyboard navigation with a visible, non-colour-only focus state.
- Screen-reader labels on every control; the feed is a real list with real headings.
- `prefers-reduced-motion` respected — the depth reveal and the dial lose their motion.
- Large-text and high-contrast modes as first-class settings.
- Contrast ≥ 4.5:1 for **every** text role against its own ground, faint included, and
  ≥ 3:1 for large text and UI boundaries. There is no ornament exemption: `--text-faint`
  held one for a while at 2.72:1, and because it was exempt from the floor the
  high-contrast setting had nothing to rescue — so the readers most affected got the
  same unreadable grey whatever they turned on.
- Every text role below ~7:1 is remapped under `[data-contrast='high']`, so turning the
  setting on changes something for every rule that could need it.

`eslint-plugin-jsx-a11y` runs as errors in CI. `/design-check` audits a diff against
this document.
