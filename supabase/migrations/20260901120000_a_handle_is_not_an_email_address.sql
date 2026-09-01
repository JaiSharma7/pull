-- A profile was a directory of everyone's email addresses.
--
-- `handle_new_user` derives the handle from `split_part(new.email, '@', 1)`, and
-- `profiles_read_all` is `for select using (true)`. Those two facts are individually
-- defensible and jointly a disclosure: `anon` holds a column grant on `profiles`, so
-- anyone who can reach PostgREST can page the whole table and read the local part of
-- every registered address. Someone who signs up as `jane.doe@gmail.com` becomes
-- `janedoe`, and the domain is usually guessable from there.
--
-- It has not mattered so far because the hosted project has one account and the repo
-- is private. Both of those change on the day the repository is published: the project
-- ref and the publishable key are committed on purpose -- law 7 is right that they are
-- not secrets -- and RLS is therefore the only thing standing in front of this table.
--
-- `docs/privacy.md` describes the handle as "Optional; needed only if you choose to be
-- visible to others". It is `not null`, it is generated without asking, and it was
-- world-readable. The policy is corrected here and the sentence is corrected there.
--
-- Nothing in `apps/web` reads `profiles` or `follows`. Both are round 4 tables -- the
-- community round -- sitting in a round 2 database with their doors open. When profiles
-- become public it will be because someone chose to publish one, and that is a policy
-- this migration makes room for rather than one it pre-empts.
--
-- ONE DATABASE-SIDE READER DOES EXIST, and it is worth naming rather than discovering.
-- `refresh_stale_knowledge_vectors` (20260901070000) is `security invoker` and drives
-- its work loop off `select pr.id from public.profiles pr`. Under a role that respects
-- RLS it would now see one row and silently become a no-op for everyone else.
--
-- It is safe today for a specific reason rather than by luck: it is granted to
-- `postgres` alone, `pg_cron` runs it as `postgres`, and both `postgres` and
-- `service_role` carry `rolbypassrls`. So the policy below does not reach it. What
-- would reach it is granting it to `authenticated` -- which nothing should do, and
-- which would now be a correctness bug as well as a privilege one. Recorded here
-- because a silent no-op in a background refresh is the kind of failure that shows up
-- months later as "the feed stopped personalising".

-- 1. Self-only reads. -------------------------------------------------------------

drop policy profiles_read_all on public.profiles;
create policy profiles_read_own on public.profiles
  for select using ((select auth.uid()) = id);

drop policy follows_read_all on public.follows;
-- Both sides, deliberately: a reader may see who they follow and who follows them.
-- Neither half discloses an edge between two other people.
create policy follows_read_own on public.follows
  for select using (
    (select auth.uid()) = follower_id or (select auth.uid()) = followee_id
  );

-- 2. A handle that says nothing about the address it was made from. ----------------
--
-- Supersedes 20260829222347, which is preserved for its two real fixes: the length
-- arithmetic that made sign-up fail outright for the second person with a long
-- address, and the insert-then-catch that replaced a racy check-then-insert. Both are
-- kept below. What changes is only where `base` comes from.
--
-- `reader_` plus 16 hex characters is 23, inside the `^[a-z0-9_]{3,30}$` check with
-- room for the collision suffix. 16 hex characters is 64 bits, so the retry loop
-- below is a formality rather than a hot path -- but it stays, because a formality
-- that has never fired is exactly the code that fails the first time it is needed.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  candidate text;
  attempt   int := 0;
  done      boolean := false;
begin
  loop
    candidate := 'reader_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
    begin
      insert into public.profiles (id, handle, display_name)
      values (new.id, candidate, nullif(new.raw_user_meta_data ->> 'full_name', ''))
      on conflict (id) do nothing;
      done := true;
    exception when unique_violation then
      attempt := attempt + 1;
    end;
    exit when done or attempt >= 5;
  end loop;

  if not done then
    -- Derived from the user's own id, so it cannot collide with anyone else's.
    candidate := left('reader_' || replace(new.id::text, '-', ''), 30);
    insert into public.profiles (id, handle, display_name)
    values (new.id, candidate, nullif(new.raw_user_meta_data ->> 'full_name', ''))
    on conflict (id) do nothing;
  end if;

  insert into public.preference_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- 3. Retire the handles already derived from an address. ---------------------------
--
-- The policy above stops the disclosure going forward; it does not unmake the rows
-- that already carry it. Anything not already in the generated shape is assumed to
-- have come from an email and is replaced.
--
-- Idempotent by construction: a second run matches nothing, because everything it
-- rewrote now matches the pattern it excludes. Safe because nothing reads `handle` --
-- not the app, not an RPC, not a policy. If that ever stops being true, this is the
-- migration that says a handle was never stable and was never meant to be.
--
-- `extensions.gen_random_uuid()` is qualified for consistency rather than necessity:
-- Postgres 13 moved it into `pg_catalog`, so a bare call resolves whatever the
-- search_path is. Every table default in this schema points at `extensions.`, and
-- matching them costs nothing. The place qualification is genuinely load-bearing is a
-- function with `set search_path = ''`, where nothing but `pg_catalog` is implicit.

update public.profiles
   set handle = 'reader_' || substr(replace(extensions.gen_random_uuid()::text, '-', ''), 1, 16),
       updated_at = now()
 where handle !~ '^reader_[0-9a-f]{16}$'
   and handle !~ '^reader_[0-9a-f]{23}$';

comment on column public.profiles.handle is
  'Generated, not chosen, and never derived from the email address -- see 20260901120000. '
  'Readable only by its owner: profiles_read_own. A public directory is a round 4 '
  'decision and needs a policy written for it, not the absence of one.';
