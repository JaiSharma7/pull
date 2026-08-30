# What a Pull

**Pull something worth keeping.**

An open-source knowledge feed. Short, source-anchored ideas from books, films,
documentaries, podcasts, papers, essays and talks — that you can question, argue with,
keep, and actually remember.

> **What other learning apps call premium, we call learning.**
> Unlimited saves. Offline reading. Audio. Full history. Daily curated knowledge. $0.

## Why this exists

Microlearning apps are good at the first thirty seconds and bad at everything after.
You scroll, you tap a card, you feel briefly smarter, and a week later you cannot say
what you read. The loop is **scroll → like → forget → scroll**.

What a Pull is built for a different loop:

**Discover → Pull → Understand → Save → Recall → Go deeper**

Every idea is anchored to a real source you can open. Every idea can be argued with.
And the app keeps a model of what you already know, so it stops re-teaching it.

## What makes it different

|                        |                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Delta**          | The app knows what you already know, and refuses to spend your time on it. Open a book: _"You already know 14 of these 18. Here are the 4 that are new."_ It reports **time saved**, not time spent. |
| **Interleaved Recall** | Questions arrive _inside_ the feed at unpredictable moments — bounded, seeded, and dismissible. A Review tab is a chore people skip; a question at the right moment gets answered.                   |
| **Conviction Ledger**  | Mark what you _believe_, not just what you saved. Months later: _"You agreed with this in March. Here's the strongest case against it."_                                                             |
| **Idea Lineage**       | Ideas have ancestors. Trace one backwards across sources and centuries — Stoicism → Ellis → CBT → modern habit design.                                                                               |
| **Say It Back**        | Explain an idea in your own words. The model grades the _gap_, not the prose, and keeps your explanation on the card.                                                                                |
| **Half-Life**          | No streak guilt. Ideas decay; the Library shows what is solid and what is fading. Sessions end on **Enough**.                                                                                        |

## Stack

React 19 · Vite 8 · TanStack Router + Query · PWA — over Supabase (Postgres 17,
pgvector, pgmq, Auth, Storage, Edge Functions). No LLM ever runs in the read path:
ranking, search and the Delta are SQL and vector maths, which is what makes the free
tier affordable.

## Quick start

```bash
pnpm install
pnpm db:start        # local Supabase stack (needs Docker)
pnpm db:reset        # apply migrations + seed the public-domain corpus
pnpm dev             # http://127.0.0.1:5173
```

The seed corpus is public-domain only, so the app is usable with **no API keys**.

## Contributing

Read `CLAUDE.md` for the seven laws that govern changes, `AGENTS.md` for the review
process, and `CONTRIBUTING.md` to get started. Docs live in [`docs/`](./docs).

## Licence

MIT. The code is open; the hosted service's generated content, community submissions
and user libraries are separate and are not part of this repository.
