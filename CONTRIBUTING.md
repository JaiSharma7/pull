# Contributing

## Setup

```bash
pnpm install
pnpm db:start     # local Supabase (Docker required)
pnpm db:reset     # migrations + public-domain seed
pnpm dev
```

### On Windows, work inside WSL

Put the repo **and** the Node toolchain inside the WSL filesystem. A Windows
`pnpm` driving a repo at `\\wsl.localhost\...` fails in two ways that look like
project bugs and are not:

- `pnpm install` dies with `EPERM` renaming its store symlink, because the store
  lives on the Windows side and the project does not.
- `pnpm <script>` spawns `cmd.exe`, which refuses UNC working directories and
  silently runs from `C:\Windows` instead.

Interop also puts `/mnt/c/.../npm` ahead of the native toolchain on `PATH`, so a
Windows `pnpm` shim gets picked even inside WSL and then fails looking for a
`node` that is not there. Install Node in WSL and make sure it wins:

```bash
export PATH="$HOME/.local/node/bin:$PATH"   # ahead of the /mnt/c entries
```

`.gitattributes` pins `eol=lf`, so line endings are already handled — clone with
Git for Windows and `pnpm format:check` still passes.

## Verifying the read path

```bash
docker exec -i supabase_db_what-a-pull \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/smoke-read-path.sql
```

Creates a reader through the real signup trigger, calls `get_feed` and
`get_due_reviews` **as that reader** under RLS, then rolls back. Running those as
the owning role would prove nothing: RLS is both the likeliest thing to be wrong
and invisible to a superuser query.

## Before you push

```bash
pnpm check        # format:check + lint + typecheck + test
pnpm db:lint      # if you touched supabase/
```

CI runs four required checks — `lint`, `typecheck`, `test`, `db`. The `db` check
replays every migration from zero and asserts that RLS is enabled with a policy on
every public table, that every foreign key has an index, and that every
`SECURITY DEFINER` function pins its `search_path`.

## The seven laws

Read `CLAUDE.md`. In short: never look like Deepstash; no LLM in the read path; the
five free features stay free; analysis not reproduction; RLS in the migration that
creates the table; migrations are append-only; and the browser gets the publishable
key and nothing else.

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
