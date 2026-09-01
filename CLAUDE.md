# What a Pull — project instructions

An open-source knowledge feed. Discover an idea, understand it, keep it, and actually
remember it — across books, films, documentaries, podcasts, papers, essays and talks.

> **What other learning apps call premium, we call learning.**

## The seven laws

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

5. **Privacy law — RLS enabled and a policy present on every table in `public`.**
   A table without a policy is a data breach waiting for traffic. CI check 4 enforces
   exactly this — the end state, on a database replayed from zero — and also that every
   foreign key has a non-partial index, that every `SECURITY DEFINER` function pins its
   `search_path`, and that no two permissive policies overlap on SELECT. Do not add an
   exemption to get a build green.

   New tables should enable RLS and carry their policy **in their own migration**, and
   the existing schema does not: tables land in `20260829124548_learning.sql` and its
   siblings, policies in `20260829124730_rls.sql`. Since migrations are append-only that
   split cannot be retrofitted, so it is a standing deviation rather than a rule nobody
   follows. The law is written as what CI can actually assert, because a law stated
   more strongly than it is enforced is one contributors get rejected for while `main`
   breaks it.

6. **Migration law — append-only.**
   Never edit a migration that has been pushed. Add a new one that supersedes it.
   Editing history silently diverges every environment that already applied it.

7. **Secrets law — the browser gets the publishable key and nothing else.**
   Anything in a `VITE_*` variable is compiled into the bundle every visitor downloads.
   Treat it as printed on the homepage. Exactly one credential belongs there: the
   Supabase **publishable** key (`sb_publishable_…`), which is designed for the browser
   and which RLS — not secrecy — is what actually protects.

   Everything else is server-only and must never appear in `apps/web/`, in a `VITE_*`
   variable, in client-reachable code, or in any committed file:

   | Credential                            | Lives only in                                                                       |
   | ------------------------------------- | ----------------------------------------------------------------------------------- |
   | `sb_secret_…` / `service_role`        | Edge Function env (`SUPABASE_SERVICE_ROLE_KEY`), injected by the platform           |
   | `GOOGLE_AI_API_KEY`, any provider key | Edge Function secrets, or Vault read by the worker through a `security definer` RPC |
   | Storage S3 access/secret pair         | Server-side callers only                                                            |
   | The generation dispatch token         | Vault                                                                               |

   A key that reaches a commit is **rotated**, not quietly removed from the diff — git
   history keeps it, and so does every clone.

   **Local-stack keys are never production credentials.** `supabase start` prints a
   publishable and a secret key for `127.0.0.1:54321`. The publishable one is committed
   in `apps/web/.env.development`, so `pnpm dev` works on a fresh clone with no setup;
   the secret one is never committed anywhere. Neither may appear in `.env.production`,
   in a hosting provider's environment, or in any deployed configuration. A credential
   that works against both a laptop and production is one nobody can reason about, and
   the blast radius of confusing them runs in the wrong direction.

   The local stack signs its tokens with a **published default secret**, so anyone who
   can reach it can mint an admin token for it. That is harmless on loopback and a total
   compromise anywhere else: never bind the local stack to a public address, and never
   reuse its JWT secret in a hosted project.

## Stack

| Layer    | Choice                                                       |
| -------- | ------------------------------------------------------------ |
| Frontend | React 19 · Vite 8 · PWA — no router or data-fetching library |
| Backend  | Supabase — Postgres 17, PostgREST, Auth, Edge Functions      |
| Vectors  | `pgvector` 0.8 with HNSW, 1536 dimensions                    |
| Queue    | `pgmq`, ticked by `pg_cron` over `pg_net`                    |
| Monorepo | pnpm workspaces + Turborepo                                  |

Routing is `history.pushState` and a `popstate` listener in `apps/web/src/App.tsx`, over
path helpers in `apps/web/src/lib/routes.ts` that are pure and unit-tested. Reading is tab
state on purpose — a Pull is not a page — so a real address belongs only to what someone
could send: `/explore`, `/search`, `/appearance`, `/source/:id`, `/pull/:id`, `/topic/:slug`,
`/privacy` and `/terms`. `DESTINATIONS` in `App.tsx` is the authority for the first three;
the sections beside them stay tab state because each is keyed to a reader, which is also why
a signed-out visitor is shown destinations and not sections. Data is fetched by `supabase-js`
in the component that needs it; the offline copy lives in IndexedDB via `lib/offline.ts`, not
in a query cache.

Hosted project `pull`, ref `zjvfwhjwaytyogdxeddo`, region `ca-central-1`.

## Commands

```bash
pnpm check          # format:check + lint + typecheck + test — run before every push
pnpm dev            # web app on 127.0.0.1:5173
pnpm db:start       # local Supabase stack
pnpm db:reset       # replay every migration from zero, then seed
pnpm db:types       # regenerate packages/db/src/database.types.ts — never hand-edit
pnpm db:lint        # the schema invariants CI check 4 runs
pnpm db:test        # read-path behaviour, as a real reader under RLS
```

## Conventions

- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- **`packages/schemas` mirrors the database enums, and the mirror is compile-time
  enforced.** `packages/db/src/enum-parity.ts` asserts both directions against the
  generated types, so a migration that adds an enum member fails typecheck until the
  mirror follows. Database enums and their TypeScript mirrors change in the same commit.

  It says `as const` arrays rather than Zod schemas because that is what is there. Zod
  was named here, in the README and in `CONTRIBUTING.md` as "the source of truth for
  shapes", and was imported by nothing in the repository while being a declared
  dependency of two packages — the same failure commit `4507a7f` removed two other
  packages for.

- **`packages/ranking` mirrors the interleave planner in pure TypeScript** so its
  placement rules can be tested over thousands of sessions without a database. SQL stays
  authoritative. If you change one, change both.

  Two limits, because the claim used to be larger than the code. It mirrors
  `plan_interleave` and `seeded_unit` and **not** `get_feed`'s scorer, the Delta or
  `search_catalogue` — those live only in SQL. And the parity test runs against a
  committed JSON fixture captured by hand, not against the database, so a change to the
  SQL planner passes CI unless someone regenerates the fixture. Closing that is in
  `docs/contributing-map.md`.

- **Generated files are never hand-edited** — `packages/db/src/database.types.ts` comes
  from `pnpm db:types`, and CI fails if it is stale.

## Definition of done

Format, lint, typecheck and tests pass; `pnpm db:lint` and `pnpm db:test` are clean; Supabase advisors report
no security findings; the diff obeys the seven laws. Then the review gate in `AGENTS.md`.
