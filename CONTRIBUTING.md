# Contributing

## Setup

```bash
pnpm install
pnpm db:start     # local Supabase (Docker required)
pnpm db:reset     # migrations + the seeded demo corpus
pnpm dev
```

`pnpm db:reset` gives you **6 works and 21 Pulls** — enough to see every mechanic
work, not enough to feel like a product. That is deliberate and it is the honest
size: the 101-source manifest in `scripts/corpus/public-domain.json` is turned into
content by the generation pipeline, which needs a model API key and an operator. See
[Adding content](#adding-content).

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

### Never point a dev server at production

`apps/web/.env.production` carries the hosted project's URL and publishable key, both
of which are public by construction (law 7). The app refuses to start a dev server
against a non-loopback project unless you set `VITE_ALLOW_REMOTE_SUPABASE=true`, and
the reason is not confidentiality — RLS keeps you inside your own account either way.
It is that every write a dev server makes is a write that account is _allowed_ to
make, landing in a real reader's library, with no undo.

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
pnpm db:test      # if you touched the read path or any policy
```

CI runs six required checks — `lint`, `typecheck`, `test`, `db`, `secrets`, `dco`.
The `db` check replays every migration from zero and asserts that RLS is enabled with
a policy on every public table, that every foreign key has a non-partial index, that
every `SECURITY DEFINER` function pins its `search_path`, and that no two permissive
policies overlap on SELECT.

No CI job here references a repository secret, and none should. `pull_request` from a
fork gets no secrets at all, so a check that needed one would either fail for every
outside contributor or have to run untrusted code with credentials in scope.

## How a change gets reviewed

**You do not need to run anything a maintainer runs.** Open a pull request with green
CI and a description that says _why_; a maintainer takes it from there.

`AGENTS.md` describes an agent-assisted review gate the maintainers use — Codex on the
first pass, then four specialist reviewers over non-overlapping slices. That is a
maintainer-side process, not a bar you are asked to clear, and nothing in it is
required of a contributor.

One concern per PR. The diff says what; the description has to say why.

## Contribution policy

### Sign your work (DCO)

Every commit needs a `Signed-off-by:` line matching its author:

```bash
git commit -s          # adds it for you
git rebase --signoff main   # adds it to commits you already made
```

This is the [Developer Certificate of Origin](https://developercertificate.org/): you
are stating that you wrote the change, or have the right to submit it, under this
project's [AGPL-3.0 licence](./LICENSE). CI enforces it on every commit in a PR.

Commits made before the policy existed are exempt — the check skips anything reachable
from the commit that introduced it. Rewriting published history to backfill sign-offs
would be worse than the gap it closes.

Commits authored by a bot are also skipped. A bot has no legal personality, so there is
nothing for it to certify; the certification that matters on a Dependabot PR happens when
a human reviews and merges it. Requiring a sign-off no bot can give would leave every
dependency update permanently red, which teaches reviewers to ignore a failing DCO.

### Sign the CLA (once)

Alongside the per-commit DCO, first-time contributors sign the [Contributor Licence
Agreement](./CLA.md) by adding their name to `CONTRIBUTORS.md` in the same pull request.

The two are not redundant. The DCO records **provenance**, per commit: you had the right
to send this. The CLA records a **licence grant**, once: the project may relicense your
contribution, including into a paid service offered alongside the free ones. You keep
your copyright, and you keep every right to your own work.

It is a short document and it states its trade-offs plainly, including the two things it
lets the project do that the AGPL alone would not. Read it before you sign it. If you
disagree with it, say so in the issue rather than the pull request — the terms are a
reasonable thing to argue about, and that argument does not belong in a code review.

### If you used an AI assistant, say so

The PR template has a checkbox. Tick it. Using one is entirely fine — this repository
is largely built that way and `AGENTS.md` does not pretend otherwise — and there is an
obvious asymmetry in asking contributors to disclose it, so here is the actual rule
rather than a posture:

**You must be able to explain your diff.** Every line, why it is there, and what
happens if it is wrong. That is the standard whether you typed it, generated it, or
copied it from somewhere else, and it is the only one that matters, because it is what
review depends on. A model that has read this repository can produce something
plausible for almost any file in it; what it cannot do is answer for the change in six
months when it breaks.

What this rules out is narrow and specific:

- **Bulk PRs.** Mass-generated typo fixes, "optimisations", refactors, or dependency
  churn across many files are closed unreviewed. One concern per PR is not a style
  preference here — a diff nobody can hold in their head is a diff nobody reviews.
- **Unread output.** A PR whose author cannot say why a line is there costs more to
  review than to write, and that cost lands on someone else.
- **Generated prose about the code, presented as fact.** The comments in this
  repository make specific claims — that a policy leaks, that an index is unreachable,
  that a number was measured. If you write a claim like that, it has to be true and
  you have to have checked. `docs/roadmap.md` is the tone: things that were verified,
  and things that were not, marked as which.

Findings from a scanner or a model are welcome as **issues** with a reproduction. They
are not welcome as a PR that changes code on the strength of a claim nobody confirmed.

## The seven laws

Read `CLAUDE.md`. In short: never look like Deepstash; no LLM in the read path; the
five free features stay free; analysis not reproduction; RLS on every table with a
policy, asserted by CI; migrations are append-only; and the browser gets the
publishable key and nothing else.

A PR that breaks one of these is rejected on that basis, however good the code is.

Law 5 has a **standing deviation** that is documented rather than hidden: the schema
enables RLS one migration after the tables are created (`docs/roadmap.md`). CI asserts
the end state, which is what is actually enforceable. New tables should enable RLS and
carry a policy in their own migration; you will not be rejected for the existing split.

## Adding content

Only **public domain** or **openly licensed** material may be committed to this
repository. Never commit copyrighted book text, screenplays, transcripts you do not
have rights to, or ripped media. See `docs/content-policy.md`.

The most useful contribution that needs no database is a source for the manifest:

```bash
# add an entry to scripts/corpus/public-domain.json, then
node scripts/seed-corpus.mjs --check
```

`--check` fetches every URL and compares the page title against the expected work. It
exists because the first draft of that file was written from memory and 28 of 61
entries were 404s. Entries must be unambiguously public domain — first published well
before 1929 — and short enough to finish inside `MAX_SOURCE_CHARS` (200,000), or the
pipeline summarises the opening third and labels it as the whole.

`SOURCE_HOST_ALLOWLIST` in the worker is limited to the three hosts the manifest uses.
A source on a fourth host needs that list widened, which is a decision with a threat
model attached — see `supabase/functions/_shared/source.ts`.

## Where things live

| Path                  | Contents                                          |
| --------------------- | ------------------------------------------------- |
| `apps/web`            | React app                                         |
| `packages/ui`         | The Archive design system                         |
| `packages/schemas`    | Shared enum mirrors of the database types         |
| `packages/ranking`    | TS mirror of the interleave planner               |
| `packages/db`         | Generated Supabase types (never hand-edited)      |
| `supabase/migrations` | Schema, append-only                               |
| `supabase/functions`  | Edge Functions (generation step-machine)          |
| `supabase/tests`      | Read-path and RLS behaviour, run as a real reader |
| `docs/`               | Product, design, architecture, policy             |
