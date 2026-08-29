---
name: steward
description: Repo-specific policy for handling PR CI failures and review comments in What a Pull. Read automatically when PR activity arrives.
---

# Stewarding a What a Pull pull request

Read when a CI failure, review comment, or PR state notice arrives.

## The gate this repo runs

Codex first, `/code-review` second, merge last. Full sequence in `AGENTS.md`. Do not
merge with an unaddressed Codex comment, and do not treat a silent Codex as a pass.

## Before any push

```bash
pnpm check       # format:check + lint + typecheck + test
pnpm db:lint     # schema invariants, if the diff touches supabase/
```

Reproduce the reported failure locally _first_, then fix it, then show the same check
passing. A push that turns CI red costs a cycle and the reviewers' trust.

## Which check failed, and what it means

| Check       | Usual cause                                                         | Fix                                                           |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| `lint`      | formatting drift, or a new a11y violation in JSX                    | `pnpm format`, then fix the rule properly — do not disable it |
| `typecheck` | schema changed, generated types stale                               | `pnpm db:types` and commit the result                         |
| `test`      | a mechanic changed behaviour                                        | fix the code, not the assertion                               |
| `db`        | new table without RLS or a policy; unindexed FK; migration ordering | add the policy or index in a **new** migration                |

## Never

- **Never skip, disable, or quarantine a test** to get green. A failing test is a
  finding. If it is genuinely wrong, fix the test and say why in the PR.
- **Never hand-edit `packages/db/src/database.types.ts`.** Regenerate with `pnpm db:types`.
- **Never edit a migration that has been pushed.** Add a new one. Editing history
  silently diverges every environment that already applied it.
- **Never weaken `supabase/tests/lint.sql`** to make check 4 pass. It is the only thing
  standing between an added table and an unprotected one.
- **Never rewrite history on a branch you did not create** — no rebase, amend, or
  force-push. A merge commit keeps other people's checkouts valid.
- **Never call "flake" a root cause.** Re-run a job only to confirm a failure that is
  clearly not this PR's, or one that died before any test body ran — at most once.

## Review comments

Small and local (a rename, a nit, an added test, a one-function refactor) → implement and
push. Larger asks on a PR you did not open → reply with a proposal and let the author
decide. A review bot's finding is a bug report: verify it, then fix it — "design-level"
is not an excuse to skip one.

Resolve the threads you actually addressed, and answer the ones you did not.

## The laws still apply under time pressure

A fix that adds a gradient, calls a model in the read path, gates a free-tier feature, or
drops an RLS policy is not a fix. See `CLAUDE.md`.
