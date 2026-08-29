---
name: design-check
description: Audit a UI diff against The Archive design system. Use when reviewing or writing any component, style, or screen in What a Pull.
---

# Design check — The Archive

The product must never read as a Deepstash clone. Deepstash is pastel gradients,
candy-rounded cards and playful illustration; we are ink on paper.

## Tokens — the only permitted values

```
--bone     #F4F1EA   page ground (light)
--ink      #14120E   text, rules, dark ground
--oxblood  #8C2F26   THE accent — the only one
--warm     #6B6459   secondary text
--rule     rgba(20,18,14,0.12)

display  Fraunces        serif, variable, optical sizing
body     Inter           grotesk
meta     JetBrains Mono  uppercase, tracked, small
```

All three faces are OFL — required, since this repo is open source.

## Reject on sight

| Violation                                          | Why                                               |
| -------------------------------------------------- | ------------------------------------------------- |
| `linear-gradient` / `radial-gradient` on a surface | Deepstash's signature; we use flat ground + grain |
| `box-shadow` for elevation                         | We separate with hairline rules, not depth        |
| A second accent colour                             | One accent is the whole discipline                |
| `border-radius` above `4px` on a card              | Candy rounding is the look we are avoiding        |
| Colour used as the only signal                     | Fails contrast and colour-blind users             |
| A hardcoded hex outside `tokens.css`               | Tokens exist so the system stays one system       |

Shadows are permitted in exactly one place: a focus ring, where it is an accessibility
affordance rather than decoration.

## Required on every interactive element

- A visible focus state that is not only a colour change.
- Reachable and operable by keyboard alone, in a sensible tab order.
- An accessible name (visible text, `aria-label`, or a labelled control).
- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI boundaries.
- Motion behind `prefers-reduced-motion`.

`eslint-plugin-jsx-a11y` runs as **errors** in CI check 1. Do not silence a rule to pass;
fix the markup.

## How to audit a diff

1. `git diff --stat` for the changed UI files, then read the CSS.
2. `grep -rnE "gradient|box-shadow|#[0-9a-fA-F]{3,6}" <changed files>` — every hit needs
   a justification, and almost none have one.
3. Check the type ramp: display is Fraunces, body is Inter, metadata is mono. A heading
   set in the body face is a bug.
4. Tab through the screen. If you cannot reach a control, it is not done.
