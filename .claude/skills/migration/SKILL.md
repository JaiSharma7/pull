---
name: migration
description: How to write, apply and verify a database migration in What a Pull, including the RLS checklist.
---

# Writing a migration

## Rules

1. **Append-only.** Never edit a pushed migration. Add `NNNN_description.sql` after it.
2. **RLS in the same migration as the table.** Not a follow-up. Not "later".
3. **Index every foreign key** you create, in the same file.
4. **`SECURITY DEFINER` functions must pin `search_path`**, or a caller can shadow the
   objects they resolve.

## Checklist for every new table

```sql
alter table public.<t> enable row level security;

-- User-owned data: the owner, and only the owner.
create policy "<t>_owner_select" on public.<t>
  for select using (auth.uid() = user_id);
create policy "<t>_owner_write" on public.<t>
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Canonical content: world-readable only once published.
create policy "<t>_public_read" on public.<t>
  for select using (status = 'published');

create index on public.<t> (<each fk column>);
```

## Applying and verifying

```bash
pnpm db:reset      # replay everything from zero — catches ordering bugs
pnpm db:lint       # the invariants CI check 4 enforces
pnpm db:types      # regenerate types; commit the result or typecheck fails
```

Then run Supabase advisors for **security** and **performance**. A security advisory is a
build failure, not a note.

## Common traps

- A table with RLS enabled and no policy is unreadable by _everyone_, including its
  owner. Check 2 in `supabase/tests/lint.sql` catches this; it is easy to hit by
  enabling RLS and forgetting the policy.
- `auth.uid()` is `null` for anonymous requests, so `auth.uid() = user_id` is already
  false-safe — but `using (true)` on a user table is not, and never should ship.
- Adding a column to a table that a `SECURITY DEFINER` function selects with `*` changes
  that function's output shape silently. Name your columns.
- **Never reference a platform-provided object unconditionally.** The hosted project has
  objects a local stack does not — `rls_auto_enable` is one. A migration that assumes one
  exists cannot be replayed from zero, which breaks CI check 4 and every fresh checkout.
  Guard it: `if exists (select 1 from pg_proc ...) then execute '...' end if;`
