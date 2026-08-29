---
name: delta
description: How the knowledge model works in What a Pull — the Delta, Half-Life decay, and Interleaved Recall. Read before changing anything that touches knowledge_states, user_knowledge_vectors, or the interleave planner.
---

# The knowledge model

Six mechanics share one substrate: a per-user model of **what you know, how sure you are,
whether you agree, and whether it is fading.** Changing one table affects all of them.

## Tables

| Table                    | Holds                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `knowledge_states`       | one row per user × pull — `strength`, `stability`, `difficulty`, `reps`, `lapses`, `next_due_at` |
| `user_knowledge_vectors` | one row per user — a `vector(1536)` centroid over what they know                                 |
| `convictions`            | append-only stance history; a new row supersedes, never overwrites                               |
| `explanations`           | Say It Back submissions and their graded gaps                                                    |
| `interrupt_events`       | what was asked, when, and how the user responded                                                 |

## The Delta

`strength` decays over time. A pull is "known" when the user's centroid is close to its
embedding **and** `strength > 0.7`. Known pulls are dropped from the feed before ranking
and counted into `skipped_known_count`, which the UI renders as _time saved_.

Two failure modes to avoid:

- **Over-filtering.** A centroid over hundreds of ideas drifts toward the mean and starts
  matching everything. Guard with the `strength` term, not similarity alone.
- **Cold start.** A new user has no vector. The filter must be a no-op, not an empty feed.

## Half-Life

FSRS-shaped: `retrievability = exp(-elapsed_days / stability)`. A successful recall raises
`stability`; a lapse lowers it and raises `difficulty`. Decay is computed on read from
`last_seen_at`, never written by a scheduled job — a cron that touches every row does not
scale, and a stale row is indistinguishable from a fresh one when the formula is pure.

## Interleaved Recall — the randomness

Questions appear _inside_ the feed at unpredictable moments. The randomness is **bounded
and seeded**, and both halves matter: unbounded randomness feels like harassment,
unseeded randomness cannot be tested.

```
budget      ≤ 3 per session, ≥ 4 content cards apart, never in the first 2
pressure    p = clamp(0.08 + 0.04 * due_pressure, 0, 0.35)
draw        PRNG seeded on hash(user_id, utc_date, session_seed, page, slot)
type        recall 45 · say_it_back 20 · conviction 15 · counterpull 12 · delta_probe 8
```

Dismissals feed back into `due_pressure`: a user who keeps skipping gets asked less. The
system backs off rather than nags.

**The planner is implemented twice** — in SQL (authoritative) and in
`packages/ranking` (testable, and used client-side to prefetch). A parity test keeps them
identical. Change one without the other and the test fails, which is the point.

## Before you change any of this

Run `pnpm test --filter @wap/ranking`. The suite asserts the budget is never exceeded,
the minimum gap holds, no interrupt lands in the first two cards, the observed rate stays
inside the configured band over 10,000 simulated sessions, and the same seed always
produces the same plan.
