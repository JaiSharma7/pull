# Contributing

## Setup

```bash
pnpm install
pnpm db:start     # local Supabase (Docker required)
pnpm db:reset     # migrations + public-domain seed
pnpm dev
```

## Before you push

```bash
pnpm check        # format:check + lint + typecheck + test
pnpm db:lint      # if you touched supabase/
```

CI runs four required checks — `lint`, `typecheck`, `test`, `db`. The `db` check
replays every migration from zero and asserts that RLS is enabled with a policy on
every public table, that every foreign key has an index, and that every
`SECURITY DEFINER` function pins its `search_path`.

## The six laws

Read `CLAUDE.md`. In short: never look like Deepstash; no LLM in the read path; the
five free features stay free; analysis not reproduction; RLS in the migration that
creates the table; migrations are append-only.

A PR that breaks one of these is rejected on that basis, however good the code is.

## Adding content

Only **public domain** or **openly licensed** material may be committed to this
repository. Never commit copyrighted book text, screenplays, transcripts you do not
have rights to, or ripped media. See `docs/content-policy.md`.

## Pull requests

One concern per PR, with a description explaining _why_. Reviews run through the gate
in `AGENTS.md`. Conventional commit messages (`feat:`, `fix:`, `docs:`, …).

## Where things live

| Path                  | Contents                                     |
| --------------------- | -------------------------------------------- |
| `apps/web`            | React app                                    |
| `packages/ui`         | The Archive design system                    |
| `packages/schemas`    | Zod shapes — the source of truth             |
| `packages/ranking`    | TS mirror of the SQL read path               |
| `packages/db`         | Generated Supabase types (never hand-edited) |
| `supabase/migrations` | Schema, append-only                          |
| `supabase/functions`  | Edge Functions (generation step-machine)     |
| `docs/`               | Product, design, architecture, policy        |
