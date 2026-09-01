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

## Laws

1. No gradients on any surface. Flat ground plus paper grain.
2. No `box-shadow` for elevation. Separate with hairline rules. The single exception is
   a focus ring, where it is an accessibility affordance.
3. One accent colour. If something needs emphasis and oxblood is taken, use weight,
   size, or space.
4. `border-radius` ≤ 4px on cards. Candy rounding is precisely the look we avoid.
5. Colour is never the only signal.
6. No hardcoded hex outside `tokens.css`.
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
- `prefers-reduced-motion` respected — the card flip becomes a cross-fade.
- Large-text and high-contrast modes as first-class settings.
- Contrast ≥ 4.5:1 body, ≥ 3:1 large text and UI boundaries.

`eslint-plugin-jsx-a11y` runs as errors in CI. `/design-check` audits a diff against
this document.
