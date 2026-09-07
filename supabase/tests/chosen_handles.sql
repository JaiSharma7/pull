-- A username is chosen once, by its owner, and cannot be taken from anybody.
--
-- `claim_handle` (20260906090000) is the only route the app offers to a name, and it is
-- reachable by anyone holding a session -- so the assertions below are about the two
-- things a reader could otherwise do to somebody else: take a name that is already
-- held, or wear the `reader_` shape the database uses for a profile nobody has claimed.
--
-- Run as a real reader, never as the owner role, for the reason `identity_privacy.sql`
-- gives: RLS is invisible to `postgres`, so the same statements would prove nothing.
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_is_reader() returns void
language plpgsql as $fn$
begin
  if current_user <> 'authenticated' then
    raise exception
      'assertions must run as the reader, not as %. RLS is invisible to an '
      'owner-role query, so this file would be proving nothing.', current_user;
  end if;
end $fn$;

/**
 * Claim a name and report the SQLSTATE rather than the row.
 *
 * Every interesting outcome here is an exception, so a helper that turns one into a
 * value is what lets the assertions read as a table of cases instead of fifteen
 * nested blocks. '00000' means it went through.
 */
create or replace function pg_temp.claim_state(wanted text) returns text
language plpgsql as $fn$
begin
  perform public.claim_handle(wanted);
  return '00000';
exception when others then
  return sqlstate;
end $fn$;

do $$
declare
  alice   uuid := extensions.gen_random_uuid();
  bob     uuid := extensions.gen_random_uuid();
  oauth   uuid := extensions.gen_random_uuid();
  tenant  uuid := extensions.gen_random_uuid();
  signup  uuid;
  state   text;
  stored  text;
  chosen  timestamptz;
begin
  -- Through the real trigger, because a profile inserted by hand is a row this schema
  -- never actually creates.
  foreach signup in array array[alice, bob] loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values (signup, '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated',
            'handle' || left(signup::text, 8) || '@example.test', '',
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  end loop;

  -- Two readers who arrived through a provider rather than through an address. One
  -- sends a human name; the other's tenant sets the `name` claim to the user
  -- principal name, which is an email address.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values (oauth, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'oauth' || left(oauth::text, 8) || '@example.test', '',
          now(), now(), now(),
          '{"provider":"google","providers":["google"]}'::jsonb,
          '{"name":"Ada Lovelace"}'::jsonb),
         (tenant, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'tenant' || left(tenant::text, 8) || '@example.test', '',
          now(), now(), now(),
          '{"provider":"azure","providers":["azure"]}'::jsonb,
          '{"name":"someone@example.test"}'::jsonb);

  -- ------------------------------------- 1. a provider's name reaches the profile
  --
  -- Google sends `full_name` and `name`; Microsoft sends `name` alone. Reading only
  -- the first left every OAuth account with a null display name.
  select p.display_name into stored from public.profiles p where p.id = oauth;
  if stored is distinct from 'Ada Lovelace' then
    raise exception
      'an OAuth sign-up landed with display_name %; handle_new_user must read the '
      '"name" key too -- see 20260906090000.', coalesce(stored, '<null>');
  end if;

  -- ------------------------------------------- 2. and an address never does
  --
  -- Storing it would undo 20260901120000 through a different column: the handle would
  -- be clean and the display name would be the address.
  select p.display_name into stored from public.profiles p where p.id = tenant;
  if stored is not null then
    raise exception
      'a display name of % was stored from provider metadata. An address is not a '
      'name, whichever claim it arrives in.', stored;
  end if;

  -- --------------------------------------------- 3. a name a reader may have
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', alice, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  -- Mixed case and stray whitespace are how people type their own name, not mistakes.
  if public.claim_handle('  Ada_Lovelace ') <> 'ada_lovelace' then
    raise exception 'claim_handle did not normalise case and whitespace.';
  end if;

  select p.handle, p.handle_set_at into stored, chosen
    from public.profiles p where p.id = alice;
  if stored <> 'ada_lovelace' then
    raise exception 'the claimed name was not stored (got %).', stored;
  end if;
  if chosen is null then
    raise exception
      'handle_set_at is still null after a claim, so the app will ask this reader '
      'to choose a name they have already chosen.';
  end if;

  -- ------------------------------------------ 4. and the names nobody may have
  state := pg_temp.claim_state('no');                  -- too short
  if state <> '22023' then raise exception 'a 2-character name was accepted (%).', state; end if;

  state := pg_temp.claim_state('Ada Lovelace');        -- a space is not in the format
  if state <> '22023' then raise exception 'a name with a space was accepted (%).', state; end if;

  state := pg_temp.claim_state('reader_0123456789abcdef');
  if state <> '22023' then
    raise exception
      'a reader claimed the generated shape (%). That is how one profile passes '
      'itself off as another.', state;
  end if;

  state := pg_temp.claim_state('support');
  if state <> '22023' then raise exception 'a reserved name was accepted (%).', state; end if;

  -- ---------------------------------------- 5. a name is not taken from anybody
  perform set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'authenticated')::text, true);

  -- Bob may not have Alice's name, in any casing: the column is citext.
  state := pg_temp.claim_state('ADA_LOVELACE');
  if state <> '23505' then
    raise exception
      'bob took a name alice holds (%), or was told something other than "taken".', state;
  end if;

  select p.handle into stored from public.profiles p where p.id = bob;
  if stored ~ '^reader_' is not true then
    raise exception 'a refused claim still changed bob''s handle to %.', stored;
  end if;

  -- And a name nobody holds is his.
  if public.claim_handle('charles_babbage') <> 'charles_babbage' then
    raise exception 'a free name was refused.';
  end if;

  -- ------------------------------------------------ 6. and never anybody else's row
  --
  -- `claim_handle` is security invoker, so this is RLS doing the work rather than a
  -- uid check the function could get wrong. Alice's row must be untouched.
  select p.handle into stored from public.profiles p where p.id = alice;
  if stored is not null then
    raise exception
      'bob can read alice''s profile row (%). profiles_read_own is not holding.', stored;
  end if;

  perform set_config('role', 'postgres', true);
  select p.handle into stored from public.profiles p where p.id = alice;
  if stored <> 'ada_lovelace' then
    raise exception 'alice''s handle changed to % while bob was claiming his.', stored;
  end if;

  raise notice 'chosen handles: ok';
end $$;

rollback;
