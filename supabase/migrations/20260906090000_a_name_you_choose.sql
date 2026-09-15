-- -----------------------------------------------------------------------------
-- A name you choose.
--
-- `handle_new_user` mints `reader_` plus hex for every new account
-- (20260901120000). This is the other half: a reader may take a name of their
-- own, through a function that owns the rules.
--
-- WHAT IT DOES NOT DO, said here because the first draft of this header said
-- "once" and the function below says no such thing (Codex, #122):
--
--   * It does not make the claim ONE-TIME. The update matches on `id = uid`
--     alone, so a reader may rename as often as they like, `handle_set_at`
--     moving with each one.
--   * It is not the ONLY way in. `authenticated` holds UPDATE on every column
--     of `profiles`, including `handle` and `handle_set_at`, and
--     `profiles_write_own` permits a reader's own row -- so a PostgREST PATCH
--     sets a handle without passing any rule in here. What still holds at the
--     table is the shape (`profiles_handle_format`, 20260829124425) and the
--     constraint below, which stops a CHOSEN handle wearing the generated
--     `reader_` prefix. Reserved names and the guest refusal live only in this
--     function, and only for callers who use it.
--
-- Both are true of the deployed database as this file was written, and this file
-- is a record of that database rather than a proposal to change it (see below).
-- Closing either is a new migration: narrowing the column grants and the policy,
-- and guarding the update on `handle_set_at is null` if a claim should be
-- one-time. Nothing calls `claim_handle` yet, so there is no screen that assumes
-- either rule today.
--
-- RECONSTRUCTED, and that is why this file arrives after the migrations either
-- side of it were written. The hosted project has carried this version in
-- `supabase_migrations.schema_migrations` since 2026-09-06 with no statements
-- recorded against it -- so it was applied out of band rather than by
-- `supabase db push`, and the file it came from never reached the repository.
-- Production has the column, the constraint and the function; a laptop that runs
-- `pnpm db:reset` has none of them, and `pnpm db:types` on the two databases
-- produces two different files. This closes that: every statement below is
-- transcribed from what the hosted project actually holds
-- (`pg_get_functiondef`, `pg_get_constraintdef`, `information_schema.columns`),
-- so replaying it from zero reproduces the deployed schema rather than
-- inventing a second version of it.
--
-- Written with `if exists` / `or replace` throughout for the same reason: it has
-- to be a no-op against the database it was read from, and a create against one
-- that has never seen it. That is not a licence to edit it later -- law 6 still
-- applies from here, and the next change to a username is a new file.
--
-- The rules, and where each one lives:
--
--   * The SHAPE is the check constraint `profiles_handle_format` from
--     20260829124425 -- 3 to 30 characters of `[a-z0-9_]`. The function repeats
--     it so the refusal is a sentence rather than a constraint violation.
--   * `reader_` is OURS. A reader may not take a name that would pass for a
--     generated one, and `profiles_chosen_handle_not_generated` holds that at
--     the table: a row with `handle_set_at` set cannot carry a `reader_` name,
--     whatever writes it.
--   * RESERVED names are refused outright -- by this function, not by the table.
--   * A GUEST may not hold one, again here rather than at the table. `is_guest()`
--     is 20260901190000's; a guest session lasts a day and a username outlives it.
--
-- `handle_set_at` is what separates "chosen" from "issued". It is the only new
-- column, it is null on every row a trigger wrote, and nothing reads it yet
-- except the constraint.
--
-- SECURITY INVOKER, deliberately. The update below runs under the caller's own
-- RLS (`profiles_write_own`), so the function cannot write another reader's row
-- even if it is called with one -- the `where id = uid` and the policy both say
-- the same thing, and neither is load-bearing alone.
-- -----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists handle_set_at timestamptz;

comment on column public.profiles.handle_set_at is
  'When the reader chose this handle. Null means it is the generated one from '
  'handle_new_user and the reader has never been asked -- see 20260906090000.';

alter table public.profiles
  drop constraint if exists profiles_chosen_handle_not_generated;

alter table public.profiles
  add constraint profiles_chosen_handle_not_generated
    check (handle_set_at is null or handle !~ '^reader_');

create or replace function public.claim_handle(new_handle text)
returns text
language plpgsql
set search_path = 'public', 'extensions'
as $$
declare
  wanted text := lower(btrim(coalesce(new_handle, '')));
  uid    uuid := (select auth.uid());
  reserved constant text[] := array[
    'admin', 'administrator', 'moderator', 'mod', 'staff', 'team', 'official',
    'support', 'help', 'security', 'abuse', 'root', 'system', 'api',
    'whatapull', 'pull', 'anonymous', 'guest', 'null', 'undefined'
  ];
begin
  if uid is null then
    raise exception 'Sign in before choosing a username.' using errcode = '42501';
  end if;

  if public.is_guest() then
    raise exception 'A guest session cannot hold a username. Sign in to keep one.'
      using errcode = '42501';
  end if;

  if wanted !~ '^[a-z0-9_]{3,30}$' then
    raise exception
      'A username is 3 to 30 characters, using letters, numbers and underscores only.'
      using errcode = '22023';
  end if;

  if wanted like 'reader\_%' then
    raise exception 'Usernames cannot begin with "reader_" -- that prefix is ours.'
      using errcode = '22023';
  end if;

  if wanted = any (reserved) then
    raise exception 'That username is reserved.' using errcode = '22023';
  end if;

  begin
    update public.profiles
       set handle = wanted, handle_set_at = now()
     where id = uid;
  exception when unique_violation then
    raise exception 'That username is already taken.' using errcode = '23505';
  end;

  if not found then
    raise exception 'Could not find your profile to update.' using errcode = 'P0002';
  end if;

  return wanted;
end;
$$;

comment on function public.claim_handle(text) is
  'Claim a username for the calling reader. Normalises case and whitespace, '
  'refuses reserved and generated-shape names, and reports a taken name as 23505 '
  'with a readable message. Guests are refused -- see 20260906090000.';

revoke all on function public.claim_handle(text) from public, anon;
grant execute on function public.claim_handle(text) to authenticated;
