# Product specification

## The loop

**Discover → Pull → Understand → Save → Recall → Go deeper**

rather than **scroll → like → forget → scroll**.

## The unit

A **Pull** is one idea, anchored to a real source, that can expand to several levels of
depth and be argued with.

```
Front                                Flip
─────                                ────
SOURCE CHIP                          Why this matters
Headline (Fraunces)                  Source trail: chapter → evidence → original
Body (Inter)                         Counterpoint · Example · Ask
Save · Explain · Listen · Share
```

## Breadth

Not just books. The schema for a source changes with its medium rather than forcing
everything through one generic book-summary shape:

| Medium            | Sections                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Book (nonfiction) | Overview · Core thesis · Key ideas · Examples · Criticism · Applications · Questions · Source |
| Film              | Overview · Themes · Ideas · Characters · Context · Craft · Counterpoints · Source             |
| Paper             | Question · Method · Findings · Limitations · Implications · Related                           |
| Podcast           | Claims · Speaker positions · Memorable ideas · Timestamps                                     |
| Essay             | Thesis · Evidence · Implications · Counterarguments                                           |

## Navigation

| Area         | Purpose                                                         |
| ------------ | --------------------------------------------------------------- |
| **For You**  | Personalised stream, with Cold Open and interleaved questions   |
| **Explore**  | Topics, media, creators, collections                            |
| **Search**   | Keyword + semantic                                              |
| **Review**   | The deliberate recall destination (the feed is the ambient one) |
| **Library**  | Saved Pulls, stashes, notes, history                            |
| **Studio**   | Generate or write _(round 2)_                                   |
| **My Feeds** | User-defined channels _(round 3)_                               |

## The six mechanics

Detailed in `.claude/skills/delta/SKILL.md`. In brief:

1. **The Delta** — the app models what you already know and refuses to re-teach it.
   Surfaces as a feed filter, as _"4 of 18 are new to you"_ on a source, and as **time
   saved** rather than time spent.
2. **Interleaved Recall** — questions arrive inside the feed at bounded, seeded-random
   moments. Max 3 per session, ≥4 cards apart, never in the first two. Dismissals lower
   the rate; the system backs off rather than nags.
3. **Conviction Ledger** — append-only stance history, so belief change is queryable.
4. **Idea Lineage** — ancestor/descendant edges between ideas across sources and centuries.
5. **Say It Back** — explain it yourself; the model grades the gap, not the prose.
6. **Half-Life** — decay instead of streaks. Sessions end on **Enough**.

## The Depth Dial

Five stops in the margin beside the idea, drawn as ticks that lengthen with depth:

```
—      Shortest    the headline, set at display size
——     Short       + the claim
———    Medium      + why it matters, and the example
————   Long        + the full argument
—————  Source      the work itself, in full
```

These are **not separate generations**. One canonical structured summary is rendered at
different depths — which is what makes depth free, and what keeps the dial inside law 2:
turning it fetches nothing and regenerates nothing. It is a lens, not a request.

**The labels are computed, never authored.** Each stop shows the reading time for the
words it reveals, at 210wpm, cumulative from the headline. A dial that said "8 min" over
300 words would be a lie told on the product's behalf, and time saved is the one number
the business model rests on. `packages/ui/src/depth.ts` is the whole of that arithmetic
and calls nothing.

**A short card gets a short dial.** The stops come from the text a Pull actually has —
most have `why_it_matters`, only some have `explanation` — so the control is not
identical everywhere. That is the honest cost of driving it from real content, and it is
preferred to the alternative: a fixed five-stop scale whose deeper stops open on nothing.

The card grows to fit the stop it is on. It never scrolls inside itself, and nothing in
`components.css` may give it a height or an overflow — a card that scrolled internally
would make asking for more detail cost reading area, which is backwards for the one
control whose entire purpose is more detail.

## Anti-goals

- **No streak guilt.** A streak that punishes a missed day optimises for anxiety.
- **No infinite feed by default.** The session is designed to end.
- **No engagement metrics as success metrics.** Time saved, ideas retained, and sources
  opened are the numbers that matter.
- **No paywall on the five.** Audio, offline, history, stashes and daily curation stay
  free permanently.
