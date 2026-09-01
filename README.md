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

Every idea is anchored to a real source you can open — a byline and a link to the
original, on every source page. Every idea can be argued with. And the app keeps a
model of what you already know, so it stops re-teaching it.

## What makes it different

Built, and working today:

|                        |                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The Delta**          | The app knows what you already know, and refuses to spend your time on it. Open a source: _"You already know 14 of these 18. Here are the 4 that are new."_ It reports **time saved**, not time spent. |
| **Interleaved Recall** | Questions arrive _inside_ the feed at unpredictable moments — bounded, seeded, and dismissible. A Review tab is a chore people skip; a question at the right moment gets answered.                     |
| **Half-Life**          | No streak guilt. Ideas decay; Review shows what is fading. Sessions end on **Enough**.                                                                                                                 |
| **Say It Back**        | Explain an idea in your own words, then compare it with the card and grade yourself. _Self-graded_ — the model-graded version is designed and not built (`explanations.gap_score` is never written).   |

Designed, with the data being collected and no screen yet. Named here because a
half-built feature is easier to trust when it says so:

|                       |                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conviction Ledger** | You can mark what you _believe_, not just what you saved, and `convictions` records it. Nothing reads it back yet — _"you agreed with this in March, here is the case against it"_ is round 3.                                                              |
| **Idea Lineage**      | `pull_relations` carries ancestor, descendant and opposing edges, and a source page shows one hop of them. Tracing a chain across centuries needs the relation-extraction step, which is unwritten — so today only the hand-seeded works have edges at all. |

## Stack

React 19 · Vite 8 · PWA — over Supabase (Postgres 17, pgvector, pgmq, Auth, Edge
Functions). No LLM ever runs in the read path: ranking, search and the Delta are SQL and
vector maths, which is what makes the free tier affordable. Measured, not asserted: 101
generated summaries have cost $1.50 in total, about $0.015 each, and every call writes to
`cost_ledger`.

There is no router and no data-fetching library. The handful of real URLs are matched
by pure helpers in `apps/web/src/lib/routes.ts` and driven by `history.pushState` in
`App.tsx`; requests go through `supabase-js` where they are needed, and what is kept
for offline reading is written to IndexedDB.

## Quick start

```bash
pnpm install
pnpm db:start        # local Supabase stack (needs Docker)
pnpm db:reset        # apply migrations, including the seeded demo corpus
pnpm dev             # http://127.0.0.1:5173
```

Everything committed here is public domain, so a fresh clone runs with **no API keys**.
What `db:reset` gives you is **6 works and 21 Pulls** — enough to watch every mechanic
work, including a deliberately planted near-duplicate so the Delta visibly fires. It is
not enough to feel like a product, and it is not meant to be.

The 101 sources in `scripts/corpus/public-domain.json` are titles and URLs; turning them
into content runs the generation pipeline, which needs a model API key and an operator.
See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Using the hosted service

The hosted app at whatapull.com is governed by two documents, and both are in this
repository rather than on a landing page nobody can diff:

- **[Privacy Policy](./docs/privacy.md)** — what is collected, which three processors
  ever see it, and why your reading history never reaches a language model.
- **[Terms of Service](./docs/terms.md)** — including the five capabilities that stay
  free permanently, and the DMCA process.

They render inside the app at `/privacy` and `/terms`, from these exact files, ahead of
the sign-in gate — terms you can only read after accepting them are not terms. Every
revision is a commit, so what changed and when is public history.

Running your own instance makes you the operator of your own service; those documents
describe ours, not yours.

## Contributing

Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) — setup, the contribution policy
(DCO sign-off, and what is expected if you used an AI assistant), and how a change gets
reviewed. [`docs/contributing-map.md`](./docs/contributing-map.md) lists work that is
genuinely self-contained. `CLAUDE.md` holds the seven laws that govern changes;
`AGENTS.md` describes the maintainer-side review gate. Security reports go to
[`SECURITY.md`](./SECURITY.md), never to a public issue. Docs live in [`docs/`](./docs).

## Licence

**[GNU AGPL v3](./LICENSE)** (`AGPL-3.0-only`). Copyright © 2026 Jai Sharma and the
What a Pull contributors — see [`NOTICE`](./NOTICE).

The code is open and stays open. You may read it, run it, modify it and share it. The
one condition that matters: if you run a modified version and let other people use it
over a network, you must offer _those users_ the complete source of what you are running,
under the same licence. That is an offer to the people using your instance — not a duty
to publish to the world, and running a modified copy privately for yourself triggers
nothing. It is the "Affero" part, and it is the whole reason this licence rather than
the GPL, which a hosted fork can sidestep entirely.

**What the relicense does not do.** It does not reach backwards. Every commit made
before it remains MIT, and because those commits are still public, anyone can fetch one
today and take MIT rights in it — not just people who already had a copy. A licence
granted cannot be withdrawn, and publishing it keeps granting it.

So the AGPL governs this version and everything after it. In practice that means the
protection arrives with new work rather than covering what is already out, which is the
normal and unavoidable shape of a relicense.

Contributions are additionally covered by the [Contributor Licence
Agreement](./CLA.md), which lets the project offer paid services alongside the free
ones without relicensing anyone's work by surprise. It is short, and it explains itself.

The hosted service's generated content, community submissions and user libraries are
separate, are governed by [the Terms](./docs/terms.md), and are not part of this
repository.

**The five stay free regardless.** Audio, offline, unlimited history, unlimited stashing
and curated Daily Pulls are free forever — that is law 3 in `CLAUDE.md`, and no licence
change touches it.
