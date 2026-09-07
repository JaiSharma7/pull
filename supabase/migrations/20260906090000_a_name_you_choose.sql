-- A username someone chose, rather than one the database made up for them.
--
-- `handle` has been generated since 20260901120000 -- `reader_` plus sixteen hex
-- characters -- for a good reason that has not changed: a handle derived from an email
-- address is a disclosure waiting for a public directory, and that migration is the
-- one that stopped it. Nothing here weakens it. What it adds is the other half: a
-- reader may now *choose* a name, which is the thing a shared Pull needs if it is ever
-- to say who sent it.
--
-- Three pieces, and the split matters:
--
--   * `handle_set_at` -- null means generated, a timestamp means chosen. Without it
--     "has this reader picked a name?" is a regex against the generated shape, and a
--     regex is a guess: `reader_0123456789abcdef` is a name a person can legitimately
--     type, and guessing wrong means prompting somebody forever for something they
--     already did.
--
--   * `claim_handle(text)` -- one route in, so normalisation (case, whitespace) and
--     the reserved names live in one place and the failures come back as sentences a
--     reader can act on rather than as `duplicate key value violates unique
--     constraint "profiles_handle_key"`.
--
--   * a check constraint -- a *chosen* handle may not wear the generated shape, so
--     nobody can claim `reader_…` and pass themselves off as somebody else's row.
--     Stated on the table rather than in the function because a constraint binds every
--     route, and `profiles_write_own` means a direct PATCH through PostgREST is one.
--
-- What that last point does NOT stop, said plainly rather than discovered later: a
-- reader can still PATCH `handle` directly on their own row without going through
-- `claim_handle`, because RLS allows them to write their own profile and Postgres has
-- no way to revoke a column that a table-level grant already covers. The blast radius
-- is a name they picked with no `handle_set_at` set -- so this app keeps asking them
-- to choose one, which punishes only the person who did it. Uniqueness, the format
-- check, and the constraint below all still hold, and those are the parts that could
-- affect anybody else.
--
-- `handle_new_user` is redefined here too, for the other half of the round: sign-in
-- with Google and Microsoft. Their display name arrives under a different metadata key
-- than the email route's, and a new account with a null `display_name` is a small,
-- permanent shame nobody goes back to fix.

-- 1. Chosen, or merely generated. --------------------------------------------------

alter table public.profiles add column handle_set_at timestamptz;

comment on column public.profiles.handle_set_at is
  'When the reader chose this handle. Null means it is the generated one from '
  'handle_new_user and the reader has never been asked -- see 20260906090000.';

-- Passes over every existing row without a scan-and-fail: they all carry a generated
-- handle and a null `handle_set_at`, so the left branch is true for all of them.
alter table public.profiles
  add constraint profiles_chosen_handle_not_generated
  check (handle_set_at is null or handle !~ '^reader_');

-- 2. Claiming one. ------------------------------------------------------------------
--
-- `security invoker`, deliberately. The update it makes is one `profiles_write_own`
-- already allows, so there is nothing to elevate for -- and running as the caller means
-- RLS is still the thing deciding which row is touched. A `security definer` version
-- would have to re-implement that decision correctly, forever, and would be a much
-- more interesting function to find a bug in. `search_path` is pinned regardless,
-- because a function that resolves `auth.uid()` through a caller-controlled path
-- resolves whatever the caller wants.
--
-- Guests are refused. A guest session costs nothing to mint and is deleted a day after
-- it goes quiet (20260901220000), but the handle namespace is global and permanent-ish:
-- a script with a pool of addresses could sit on every good name for a day at a time.
-- A guest also has nothing to gain -- there is no way back into that session, so a name
-- attached to it can never be shown to anyone twice.
create or replace function public.claim_handle(new_handle text)
returns text
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  -- Lowercased and trimmed here rather than refused, because `Jai_Sharma` is not a
  -- mistake a reader made -- it is how people type their own name, and `citext` means
  -- it is the same name either way.
  wanted text := lower(btrim(coalesce(new_handle, '')));
  uid    uuid := (select auth.uid());
  /*
   * Names that must not belong to a person, because the product may one day need to
   * speak in its own voice and a reader called `support` would be able to answer.
   * Short on purpose: every entry is a name taken away from somebody who wanted it.
   */
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

  -- The same rule as `profiles_handle_format`, checked here so the answer is a
  -- sentence rather than a constraint name.
  if wanted !~ '^[a-z0-9_]{3,30}$' then
    raise exception
      'A username is 3 to 30 characters, using letters, numbers and underscores only.'
      using errcode = '22023';
  end if;

  -- `reader_` is what the database calls somebody who has not chosen. Claiming that
  -- shape is claiming to be a row nobody picked, which is only ever done on purpose.
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
    -- Re-raised as a sentence. The constraint's own message names an internal index and
    -- would be shown to a reader who typed a name somebody else already has.
    raise exception 'That username is already taken.' using errcode = '23505';
  end;

  if not found then
    -- RLS refused, or there is no profile row. Both are the app's problem rather than
    -- the reader's, and both are unreachable for a signed-in reader with a profile.
    raise exception 'Could not find your profile to update.' using errcode = 'P0002';
  end if;

  return wanted;
end;
$$;

comment on function public.claim_handle(text) is
  'Claim a username for the calling reader. Normalises case and whitespace, refuses '
  'reserved and generated-shape names, and reports a taken name as 23505 with a '
  'readable message. Guests are refused -- see 20260906090000.';

-- A new function is granted to PUBLIC by default, which is the gap
-- 20260829124835_function_hardening exists to close and which every new function
-- reopens unless it says otherwise.
revoke all on function public.claim_handle(text) from anon, authenticated, public;
grant execute on function public.claim_handle(text) to authenticated;

-- 3. A display name that survives a provider that spells it differently. ------------
--
-- Supersedes 20260901120000's definition. Everything that migration established is
-- preserved verbatim -- the generated handle, the retry loop, the id-derived fallback,
-- the preference row -- because all of it is still right. The only change is where
-- `display_name` comes from.
--
-- The email route sends `full_name` (it sends nothing at all, in fact -- the field is
-- never collected, so it is null and always has been). Google sends `full_name` and
-- `name`; Microsoft sends `name`. Reading only the first meant every OAuth account
-- landed with a null display name.
--
-- AN ADDRESS IS NOT A NAME, and this is where that could quietly stop being true. Some
-- tenants set the `name` claim to the user principal name, which is an email address --
-- so a straight read of it would put an address in `display_name` and undo the point of
-- 20260901120000 through a different column. Anything with an `@` in it is therefore
-- dropped rather than stored, and the reader is asked instead.
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
  name      text;
begin
  name := nullif(btrim(coalesce(
            new.raw_user_meta_data ->> 'full_name',
            new.raw_user_meta_data ->> 'name',
            '')), '');
  if name is not null and position('@' in name) > 0 then
    name := null;
  end if;

  loop
    candidate := 'reader_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
    begin
      insert into public.profiles (id, handle, display_name)
      values (new.id, candidate, name)
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
    values (new.id, candidate, name)
    on conflict (id) do nothing;
  end if;

  insert into public.preference_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

comment on column public.profiles.display_name is
  'The name the reader is shown by, taken from an OAuth provider at sign-up when it '
  'offers one and never from an email address -- see 20260906090000.';
