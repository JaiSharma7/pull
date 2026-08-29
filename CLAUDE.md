# What a Pull — project instructions

An open-source knowledge feed. Discover an idea, understand it, keep it, and actually
remember it — across books, films, documentaries, podcasts, papers, essays and talks.

> **What other learning apps call premium, we call learning.**

## The six laws

These are not preferences. A change that breaks one is wrong even if it is elegant,
and reviewers should reject it on that basis alone.

1. **Design law — never look like Deepstash.**
   No gradients. No drop shadows. Exactly one accent colour (`oxblood #8C2F26`).
   Hairline rules, generous margins, paper grain. Typography is the ornament.
   The full brief is `docs/design.md`; `/design-check` audits a diff against it.

2. **Cost law — no LLM in the read path. Ever.**
   Ranking, search, the Delta and the interleave planner are SQL and pgvector maths.
   Models run at _generation_ time, once per canonical summary, and every call writes
   to `cost_ledger`. A feature that calls a model per impression is not shippable:
   one canonical generation costs ~$0.056 and serves thousands of readers, while
   per-user regeneration costs ~$56 per thousand. That ratio is the business model.

3. **Free law — the five stay free.**
   Audio, offline, unlimited history, unlimited stashing and curated Daily Pulls are
   free forever. Each is affordable by design, not by subsidy: audio is client-side
   Web Speech, offline is service worker + IndexedDB, the rest are rows in Postgres.
   A PR that gates one of them is rejected on principle.

4. **Rights law — analysis, not reproduction.**
   No copyrighted source text, screenplays, or ripped media in this repository, ever.
   We publish ideas, arguments, criticism and commentary — never a chapter-by-chapter
   replacement for the original. Every source carries a `rights_status`. See
   `docs/content-policy.md`.

5. **Privacy law — RLS on every table, in the migration that creates it.**
   A table without a policy is a data breach waiting for traffic. CI check 4 enforces
   this; do not add an exemption to get a build green.

6. **Migration law — append-only.**
   Never edit a migration that has been pushed. Add a new one that supersedes it.
   Editing history silently diverges every environment that already applied it.

## Stack

| Layer    | Choice                                                           |
| -------- | ---------------------------------------------------------------- |
| Frontend | React 19 · Vite 8 · TanStack Router + Query · Zod · PWA          |
| Backend  | Supabase — Postgres 17, PostgREST, Auth, Storage, Edge Functions |
| Vectors  | `pgvector` 0.8 with HNSW, 1536 dimensions                        |
| Queue    | `pgmq`, ticked by `pg_cron` over `pg_net`                        |
| Monorepo | pnpm workspaces + Turborepo                                      |

Hosted project `pull`, ref `zjvfwhjwaytyogdxeddo`, region `ca-central-1`.

## Commands

```bash
pnpm check          # format:check + lint + typecheck + test — run before every push
pnpm dev            # web app on 127.0.0.1:5173
pnpm db:start       # local Supabase stack
pnpm db:reset       # replay every migration from zero, then seed
pnpm db:types       # regenerate packages/db/src/database.types.ts — never hand-edit
pnpm db:lint        # the schema invariants CI check 4 runs
```

## Conventions

- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- **Zod schemas in `packages/schemas` are the source of truth for shapes.** Database
  enums and their TypeScript mirrors change in the same commit.
- **`packages/ranking` mirrors the SQL read path in pure TypeScript** so it can be
  unit-tested without a database. SQL stays authoritative; a parity test keeps them
  honest. If you change one, change both.
- **Generated files are never hand-edited** — `packages/db/src/database.types.ts` comes
  from `pnpm db:types`, and CI fails if it is stale.

## Definition of done

Format, lint, typecheck and tests pass; `pnpm db:lint` is clean; Supabase advisors report
no security findings; the diff obeys the six laws. Then the review gate in `AGENTS.md`.
