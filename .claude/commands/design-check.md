---
description: Audit the current diff's UI against The Archive design system.
---

Load `.claude/skills/design-check/SKILL.md` and audit every changed UI file in the
current diff against it.

Report violations grouped by severity, each with `file:line` and the fix. Pay particular
attention to gradients, `box-shadow` used for elevation, a second accent colour,
`border-radius` over 4px on a card, hardcoded hex values outside `tokens.css`, and any
interactive element that cannot be reached by keyboard.

If the diff is clean, say so plainly rather than inventing findings.
