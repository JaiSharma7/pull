# Contributing to Supabase and backend code

Backend contributions are welcome. They are developed and reviewed against the local
Supabase stack; contributor access to a hosted project is neither required nor expected.
The seven laws in [`CLAUDE.md`](../CLAUDE.md) remain the authority when this guide and
an implementation appear to disagree.

## Use the repository's local stack

Docker is required. From the repository root:

```bash
pnpm install
pnpm db:start
pnpm db:reset
```

The Supabase CLI is pinned in the workspace. Use `pnpm db:*` or
`pnpm exec supabase ...`; do not add or rely on your own global Supabase CLI. Do not
commit CLI state from `supabase/.temp/`, `supabase/.branches/`, or `supabase/.env`.
Those paths are local and ignored.

The web app's development defaults point at `127.0.0.1:54321`. Do not link this checkout
to a hosted project or copy hosted credentials into local configuration. The dev server
also refuses a non-loopback Supabase URL unless its explicit escape hatch is set; that
escape hatch is for maintainers handling an exceptional case, not routine contribution
work.

## Migrations are append-only

Create a new migration in `supabase/migrations/`; never edit, reorder, rename, or delete
a migration that has shipped. A clean `pnpm db:reset` must recreate the intended state
from zero without dashboard changes or manual SQL.

Discuss a change before implementation if it drops or rewrites data, changes authentication
or authorization boundaries, needs backfill or rollout coordination, exposes a new network
surface, or cannot be proved safely on the local stack.

## RLS and role-realistic tests

Every public table must enable row-level security and have at least one policy in the same
migration that creates it. Do not weaken a policy to make a test pass. Avoid overlapping
permissive `SELECT` policies: PostgreSQL combines them with `OR`, which can silently
broaden access.

A successful owner or superuser query does not prove application behavior. Test through
the roles that actually use the path:

- follow the per-file `pg_temp` role-helper pattern in existing tests such as
  `supabase/tests/identity_privacy.sql` and `supabase/tests/questions.sql` to establish
  reader and visitor contexts;
- prove both the allowed case and the cross-user or unauthenticated denial;
- run `scripts/smoke-read-path.sql` when the reader-facing RPC path changes.

`SECURITY DEFINER` functions must pin a safe `search_path`. Explain any definer,
service-role, authentication, or cross-user behavior in the pull request so reviewers can
verify the trust boundary instead of inferring it.

Every foreign key needs a usable non-partial index. The database lint suite checks this,
RLS coverage, policy overlap, duplicate indexes, and definer search paths.

## Generated types and enum parity

After a schema change, regenerate types from the reset local database:

```bash
pnpm db:types
```

Never hand-edit `packages/db/src/database.types.ts`. Commit its generated diff when the
database shape changes. Database enums mirrored in `packages/schemas` or application
code must change in the same pull request; confirm both directions of the parity rather
than updating only the compiler-visible side.

## Validation sequence

For a backend change, run this sequence from the repository root:

```bash
pnpm db:start
pnpm db:reset
pnpm db:lint
pnpm db:test
pnpm db:types
git diff -- packages/db/src/database.types.ts
pnpm check
```

`db:start` is needed once per running stack. The type diff should contain only the
schema change you intended; commit it when non-empty. CI repeats migrations from zero and
does not receive repository secrets on fork pull requests.

## Edge Functions and BAML

Develop Edge Functions against the local stack and use mocks or explicit local-only
configuration for external providers. Provider keys, service-role credentials, generation
dispatch tokens, and other secrets remain server-side. Never put them in the browser,
tracked environment files, a pull request, or a fork CI workflow.

BAML source lives in `packages/prompts/baml_src/`, its generated SDK lives in
`packages/prompts/baml_sdk/`, and the Edge Function export is
`supabase/functions/_shared/generated/prompts.ts`. Edit the source, not generated output, then
run the repository commands:

```bash
pnpm baml:fmt
pnpm baml:check
pnpm baml:generate
pnpm baml:export
```

`baml:generate` refreshes the TypeScript SDK; `baml:export` refreshes the generated
Edge Function module. Commit the generated changes produced by both commands when the
BAML source changes.

`pnpm baml:test` can call configured model providers and incur cost, so it is not a
routine contributor or fork-CI requirement. See [`docs/baml.md`](./baml.md) for the
generation and export workflow.

## Access boundary

| Role               | Supabase access                                                          |
| ------------------ | ------------------------------------------------------------------------ |
| Contributor        | Local Supabase stack only                                                |
| Reviewer           | Local Supabase stack only                                                |
| Backend maintainer | Potentially hosted project access, only when the responsibility needs it |
| Project admin      | Production secrets and administrative access                             |

Maintainers perform deployment and any exceptional hosted validation. A backend
maintainer may receive scoped hosted access only when an ongoing responsibility requires
it. Production secrets and administrative access stay with project administrators unless
explicitly delegated. See [`GOVERNANCE.md`](../GOVERNANCE.md).
