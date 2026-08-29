---
description: Inspect the knowledge model for a user. Usage: /delta <user_id or email>
---

Load `.claude/skills/delta/SKILL.md`, then report for $ARGUMENTS:

- Size and age of their `user_knowledge_vectors` centroid.
- `knowledge_states`: how many known, how many fading, how many due now.
- What the Delta filter would currently drop from their feed, and the resulting
  `skipped_known_count`.
- Their conviction history, including any stance that has changed.
- Interrupt history: rate, types, and dismissal rate — a rising dismissal rate should be
  lowering their pressure term, so check that it is.

Flag the two known failure modes: a drifting centroid that over-filters, and a cold-start
user whose filter should be a no-op rather than an empty feed.
