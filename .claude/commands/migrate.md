---
description: Scaffold, apply and verify a new database migration. Usage: /migrate <short_name>
---

Create the migration `supabase/migrations/<next_number>_$ARGUMENTS.sql`.

Follow `.claude/skills/migration/SKILL.md` exactly. In particular: RLS goes in the same
file as the table, every foreign key gets an index, and the file is append-only once
pushed.

Then:

1. `pnpm db:reset` — replay from zero to catch ordering bugs.
2. `pnpm db:lint` — the invariants CI check 4 enforces.
3. `pnpm db:types` — regenerate types and commit them, or `typecheck` will fail.
4. Run Supabase advisors for security and performance. A security finding is a blocker.
