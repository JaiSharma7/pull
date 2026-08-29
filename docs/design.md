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

## Card anatomy

```
┌─────────────────────────────────┐
│ ATOMIC HABITS · JAMES CLEAR     │  ← mono chip, warm grey
│ ─────────────────────────────── │  ← hairline rule
│                                 │
│ Your environment often          │  ← Fraunces display
│ beats your motivation.          │
│                                 │
│ The easier a behaviour is to    │  ← Inter body
│ begin, the less motivation it   │
│ requires each time.             │
│                                 │
│ ── ch.3 ──────── SAVE  ASK  ♪   │  ← source trail + actions
└─────────────────────────────────┘
```

The flip reveals _Why this matters_, the full source trail (chapter or timestamp →
evidence → the original), and Counterpoint · Example · Ask.

## Accessibility

Ships in round one, not "later". Apple's listing currently shows Deepstash declaring no
accessibility features at all; this is both free competitive ground and simply correct.

- Full keyboard navigation with a visible, non-colour-only focus state.
- Screen-reader labels on every control; the feed is a real list with real headings.
- `prefers-reduced-motion` respected — the card flip becomes a cross-fade.
- Large-text and high-contrast modes as first-class settings.
- Contrast ≥ 4.5:1 body, ≥ 3:1 large text and UI boundaries.

`eslint-plugin-jsx-a11y` runs as errors in CI. `/design-check` audits a diff against
this document.
