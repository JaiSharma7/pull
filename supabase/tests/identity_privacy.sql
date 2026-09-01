-- A profile belongs to its owner, exercised as a real reader and as a visitor.
--
-- These assertions exist because the failure they describe was live and looked fine.
-- `handle_new_user` derived the handle from the email local part, `profiles_read_all`
-- was `for select using (true)`, and `anon` holds a column grant on the table -- so
-- anyone who could reach PostgREST could page it and recover the local part of every
-- registered address. Every individual piece was defensible; the combination was a
-- disclosure, and nothing in the schema or the test suite could see the combination.
--
-- So the assertions are deliberately about the combination:
--
--   * a signed-in reader sees exactly one profile -- their own
--   * a second reader is invisible to the first, in both directions
--   * `anon` sees no profiles at all
--   * a generated handle does not contain the local part of the address it came from
--   * the same four, for `follows`, whose edges name two people rather than one
--
-- The handle assertion is the one that would have caught the original bug, and it is
-- written against the value rather than against the function body on purpose: a later
-- migration is free to change how a handle is generated, and is not free to go back
-- to generating it from an email.
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

create or replace function pg_temp.assert_is_visitor() returns void
language plpgsql as $fn$
begin
  if current_user <> 'anon' then
    raise exception
      'the visitor assertions must run as anon, not as %.', current_user;
  end if;
end $fn$;

do $$
declare
  alice        uuid := extensions.gen_random_uuid();
  bob          uuid := extensions.gen_random_uuid();
  carol        uuid := extensions.gen_random_uuid();
  signup_id    uuid;
  local_part   text;
  carol_local  text;
  carol_handle text;
  seen      int;
  handle    text;
begin
  -- Sign both readers up through the real trigger. Inserting into `profiles`
  -- directly would test a row this schema never actually creates.
  foreach signup_id in array array[alice, bob] loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values (signup_id, '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated',
            'privacy' || left(signup_id::text, 8) || '@example.test', '',
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  end loop;

  -- A third reader whose address local part is hex-shaped, so the assertion below has
  -- something it could actually match against.
  carol_local := substr(replace(carol::text, '-', ''), 1, 12);
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values (carol, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          carol_local || '@example.test', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  select p.handle into strict carol_handle from public.profiles p where p.id = carol;

  insert into public.follows (follower_id, followee_id) values (alice, bob);

  -- ------------------------------------------- 1. a handle is not an address
  --
  -- Checked as the owner, because the point is what was *stored*, not what is
  -- visible. A handle that still embedded the address would be a disclosure the
  -- moment any future migration makes profiles public again.
  select p.handle into strict handle from public.profiles p where p.id = alice;
  local_part := split_part(
    (select u.email from auth.users u where u.id = alice), '@', 1);

  if handle is null or length(handle) < 3 then
    raise exception 'signup produced no usable handle (got %)', coalesce(handle, '<null>');
  end if;
  -- Asserted against a local part that is *hex-shaped*, so this can actually fail.
  --
  -- The first version of this test signed alice up as `privacy<8 hex>@example.test`
  -- and asserted the handle does not contain that local part. It cannot: a generated
  -- handle is `reader_` plus hex, and the literal `privacy` prefix makes containment
  -- impossible however handles are derived. The assertion passed for a reason that had
  -- nothing to do with the bug it names.
  --
  -- `carol`'s local part is 12 hex characters, which is exactly the shape a generated
  -- handle is made of -- so if `handle_new_user` ever goes back to deriving from the
  -- address, this fires.
  if position(carol_local in carol_handle) > 0 then
    raise exception
      'the generated handle % contains the email local part %. A handle must not be '
      'derived from an address -- see 20260901120000.',
      carol_handle, carol_local;
  end if;
  if position(local_part in handle) > 0 then
    raise exception
      'the generated handle % still contains the email local part %.', handle, local_part;
  end if;
  if handle !~ '^reader_[0-9a-f]+$' then
    raise exception
      'handle % is not in the generated shape. If handle generation changed '
      'deliberately, update this assertion -- but it must still not come from '
      'the address.', handle;
  end if;

  -- --------------------------------------------- 2. a reader sees only herself
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', alice, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  -- Three profiles exist; alice may see one. Stated as a count over the whole table
  -- rather than as "cannot see bob", because the count also catches a policy that
  -- leaks a row nobody thought to name.
  select count(*) into seen from public.profiles;
  if seen <> 1 then
    raise exception
      'a signed-in reader can see % of 3 profiles; they may see exactly their own.', seen;
  end if;

  -- Alice follows Bob, so she may see that edge -- and only edges she is part of.
  select count(*) into seen from public.follows;
  if seen <> 1 then
    raise exception 'alice sees % follow edges; she is party to exactly 1.', seen;
  end if;

  -- ------------------------------------------ 3. and the other reader likewise
  perform set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'authenticated')::text, true);

  select count(*) into seen from public.profiles p where p.id = alice;
  if seen <> 0 then
    raise exception 'the disclosure is symmetric: bob can see alice''s profile.';
  end if;

  -- Bob is followed by Alice. The followee half of the policy is deliberate --
  -- "who follows me" is mine to know -- so this asserts 1, not 0.
  select count(*) into seen from public.follows;
  if seen <> 1 then
    raise exception
      'bob sees % follow edges; he is the followee of exactly 1.', seen;
  end if;

  -- ---------------------------------------------- 4. a visitor sees no profiles
  --
  -- The case that mattered most: `anon` is the role behind the publishable key,
  -- which is committed and public by construction.
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims',
    json_build_object('role', 'anon')::text, true);
  perform pg_temp.assert_is_visitor();

  select count(*) into seen from public.profiles;
  if seen <> 0 then
    raise exception
      'anon can read % profiles. The publishable key is in every bundle, so this '
      'is the whole internet.', seen;
  end if;

  select count(*) into seen from public.follows;
  if seen <> 0 then
    raise exception 'anon can read % follow edges.', seen;
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'identity privacy: ok';
end $$;

rollback;
