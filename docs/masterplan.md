# What a Pull — masterplan

> **A note now that this is public.** What follows names competitors and says
> unflattering things about them. It is design and market judgement, offered as opinion
> and hedged where it is not checkable — not a claim about anyone's business, and not an
> invitation to pile on. It is here because law 1 in `CLAUDE.md` is literally "never look
> like Deepstash", and a rule of that shape is unusable without the reasoning behind it.
> Where a factual claim about another product appeared in these documents undated and
> unsourced, it has been removed rather than kept.

## The opportunity

Deepstash is a personalised microlearning feed: short visual idea cards drawn from books
and other long-form sources, organised around a five-minute daily habit. It works because
it borrows the interaction density of social media without making every swipe entirely
disposable.

Two gaps are visible in how it has evolved. Its recent releases have leaned hard into
structured book experiences, and reviewers have noted both a narrowing of media variety
and the absence of a real path from a micro-summary into the underlying work. Those are
anecdotal signals rather than survey data, but they point at the same two openings:
**broader media coverage** and **a genuine route from microlearning into depth**.

That is where What a Pull diverges rather than becoming "Deepstash with a different logo".

## The thesis

> **What a Pull turns the feed into a personal knowledge system.**

Not "TikTok, but educational". The defensible idea is that the app maintains a real model
of the reader — what they know, how sure they are, whether they agree, and whether it is
fading — and spends their attention accordingly.

The loop is **Discover → Pull → Understand → Save → Recall → Go deeper**, and the scope is
books, films, documentaries, podcasts, papers, essays, lectures, long-form video,
interviews, user documents and public-domain works.

## What we take, and what we do not

We adopt the useful **mechanics**: fast visual cards, topic personalisation, saveable
collections, source pages, daily rhythm. We take none of the **identity** — not the
illustrations, wording, palette, card design, layouts or database. What a Pull looks like
its own product from the first screen. See `design.md`.

## Positioning

Deepstash gates audio playback, offline downloads, unlimited history, unlimited stashing,
and curated idea feeds behind Pro. All five are **free forever** here.

> **What other learning apps call premium, we call learning.**
> Unlimited saves. Offline reading. Audio. Full history. Daily curated knowledge. $0.

Ad removal is deliberately _not_ on that list — the model is ad-supported, and promising
to remove the funding mechanism would be dishonest.

Each of the five is affordable because of an implementation choice rather than a subsidy:
audio is client-side Web Speech, offline is service worker + IndexedDB, and history and
stashes are rows in Postgres. Nothing on that list has a per-user marginal cost worth
metering.

## The six mechanics

|                        |                                                                        |
| ---------------------- | ---------------------------------------------------------------------- |
| **The Delta**          | Never spend a minute on what you already know. Reports **time saved**. |
| **Interleaved Recall** | Questions arrive inside the feed, bounded-random and dismissible.      |
| **Conviction Ledger**  | Track what you _believe_; surface the best case against it later.      |
| **Idea Lineage**       | Ancestors and descendants of an idea, across sources and centuries.    |
| **Say It Back**        | Explain it yourself; the model grades the gap, not the prose.          |
| **Half-Life**          | Decay instead of streaks. Sessions end on **Enough**.                  |

They are one system, not six features. Any single one is a sprint for a competitor to
copy; the composite — a calibrated model of a particular reader's mind — is not.

## Economics

The whole architecture follows from one number. A canonical summary costs roughly $0.056
to generate once and serves thousands of readers. Regenerating it per user costs about
$56 per thousand. So:

- Generation is canonical, cached and versioned.
- **No model ever runs in the read path.** Ranking, search, the Delta and the interleave
  planner are SQL and pgvector arithmetic.
- Illustration — often costing more than the text — is one hero image reused across
  10–25 cards, not one per card.

Details in `generation.md`.

## Risk

Copyright is the largest non-technical risk, and it is a design problem rather than a
disclaimer problem. What a Pull is built as an analysis product: ideas, arguments,
criticism and applications — never a chapter-by-chapter or scene-by-scene replacement for
the original. Every source carries a rights status, the launch corpus is public domain,
and the §512 machinery exists in the schema before the UGC features that need it.
See `content-policy.md`.

## Documents

| Document            | Contents                                          |
| ------------------- | ------------------------------------------------- |
| `product.md`        | Feature specification and the six mechanics       |
| `design.md`         | The Archive design system                         |
| `architecture.md`   | Supabase-native architecture and the step-machine |
| `data-model.md`     | Schema, relationships, RLS posture                |
| `generation.md`     | Pipeline, cost control, quotas                    |
| `content-policy.md` | Rights, copyright posture, §512                   |
| `roadmap.md`        | Build order across rounds                         |

Governing rules live in `CLAUDE.md` (the seven laws) and `AGENTS.md` (the review gate).
