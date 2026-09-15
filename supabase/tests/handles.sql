-- A username is claimed once, through the function, or not at all.
--
-- Four assertions, each of which fails against the schema as it stood before
-- 20260915020000:
--
--   * a PATCH on `handle` is refused -- the table's UPDATE privilege is gone and only
--     three columns came back, so the route that bypassed every rule in
--     `claim_handle` no longer exists. This is the assertion that caught the first
--     draft of the migration, which revoked the two columns from a role holding
--     table-level UPDATE and therefore changed nothing at all.
--   * the same for `handle_set_at`, which is what "chosen" is recorded in
--   * a first claim succeeds and a second is refused as 55000, rather than quietly
--     renaming the reader
--   * a guest is refused, and the rules the function has always owned -- reserved
--     names, the `reader_` prefix, the shape -- still hold
--   * a second reader asking for a name already held gets 23505, which a screen has to
--     be able to tell apart from the 55000 a second claim gets
--
-- And one that would fail if the migration stopped at the revoke: `display_name` is
-- still writable, because the profile screen edits it directly and has no reason to go
-- through an RPC.
--
-- Run as the reader, so RLS and the grants are actually in force. Read-only in
-- effect: everything rolls back.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_is_reader() returns void
language plpgsql as $fn$
begin
  if current_user <> 'authenticated' then
    raise exception
      'assertions must run as the reader, not as %. RLS and column grants are '
      'invisible to an owner-role query, so this file would be proving nothing.',
      current_user;
  end if;
end $fn$;

do $$
declare
  alice   uuid := extensions.gen_random_uuid();
  ghost   uuid := extensions.gen_random_uuid();
  other   uuid := extensions.gen_random_uuid();
  got     text;
  state   text;
  handle_now text;
begin
  -- Through the real trigger, as identity_privacy.sql does: a row inserted into
  -- `profiles` by hand is a row this schema never actually creates.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values (alice, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'handles' || left(alice::text, 8) || '@example.test', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
         (other, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'handles' || left(other::text, 8) || '@example.test', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  -- A guest: `is_guest()` reads `is_anonymous` on the row.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at, is_anonymous,
                          raw_app_meta_data, raw_user_meta_data)
  values (ghost, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', null, '',
          now(), now(), true,
          '{"provider":"anonymous","providers":["anonymous"]}'::jsonb, '{}'::jsonb);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', alice, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  -- ------------------------------------------------ 1. the PATCH route is gone
  begin
    update public.profiles set handle = 'admin' where id = alice;
    raise exception
      'a reader updated profiles.handle directly. The column grant that let a '
      'PATCH bypass every rule in claim_handle is supposed to be revoked.';
  exception when insufficient_privilege then
    null;
  end;

  begin
    update public.profiles set handle_set_at = now() where id = alice;
    raise exception
      'a reader updated profiles.handle_set_at directly, which is the column that '
      'records whether a name was chosen.';
  exception when insufficient_privilege then
    null;
  end;

  -- ---------------------------------- 2. and the rest of the profile is untouched
  update public.profiles set display_name = 'Alice' where id = alice;
  if (select p.display_name from public.profiles p where p.id = alice) is distinct from 'Alice' then
    raise exception
      'display_name is no longer writable. The revoke is followed by a grant of '
      'three columns precisely so the profile screen keeps editing them directly.';
  end if;

  -- ------------------------------------------------------ 3. the rules still hold
  begin
    perform public.claim_handle('admin');
    raise exception 'claim_handle accepted a reserved name.';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.claim_handle('reader_0123456789abcdef');
    raise exception 'claim_handle accepted a name wearing the generated prefix.';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.claim_handle('ab');
    raise exception 'claim_handle accepted a name under three characters.';
  exception when invalid_parameter_value then
    null;
  end;

  -- --------------------------------------------------------- 4. once, and once only
  got := public.claim_handle('  Alice_Reads  ');
  if got <> 'alice_reads' then
    raise exception
      'claim_handle returned %, not the normalised name. Case and surrounding '
      'whitespace are supposed to be taken off before anything else looks at it.', got;
  end if;

  select p.handle::text into strict handle_now from public.profiles p where p.id = alice;
  if handle_now <> 'alice_reads' then
    raise exception 'the claim returned a name it did not store (row holds %).', handle_now;
  end if;
  if (select p.handle_set_at from public.profiles p where p.id = alice) is null then
    raise exception 'a claimed handle left handle_set_at null, so nothing marks it as chosen.';
  end if;

  begin
    perform public.claim_handle('alice_again');
    raise exception
      'a second claim succeeded. A reader renamed themselves through the one '
      'function that is supposed to allow it exactly once.';
  exception when others then
    get stacked diagnostics state = returned_sqlstate;
    if state <> '55000' then
      raise exception
        'a second claim failed with % rather than 55000, which is the code that '
        'tells "you already have one" apart from "somebody else has that one".', state;
    end if;
  end;

  select p.handle::text into strict handle_now from public.profiles p where p.id = alice;
  if handle_now <> 'alice_reads' then
    raise exception
      'the refused second claim still changed the handle (row holds %).', handle_now;
  end if;

  -- ------------------------------------------- 5. and somebody else's name is theirs
  --
  -- The unique index fires and the function reports it as 23505, which a screen must
  -- be able to tell apart from the 55000 above: one is "that name is taken", the other
  -- is "you already have one".
  perform set_config('request.jwt.claims',
    json_build_object('sub', other, 'role', 'authenticated')::text, true);
  begin
    perform public.claim_handle('alice_reads');
    raise exception 'a second reader took a name another reader already holds.';
  exception when unique_violation then
    null;
  end;

  -- ---------------------------------------------------------------- 6. not a guest
  -- `is_guest()` reads the `is_anonymous` CLAIM, not the `auth.users` column -- a
  -- token without it is not a guest, whatever the row says. `guest_bounds.sql` builds
  -- the claims the same way, and writing them without it is how the first run of this
  -- file "proved" a guest was refused while actually testing a signed-in reader.
  perform set_config('request.jwt.claims',
    json_build_object('sub', ghost, 'role', 'authenticated', 'is_anonymous', true)::text,
    true);

  begin
    perform public.claim_handle('ghostwriter');
    raise exception 'a guest claimed a username. A guest session lasts a day.';
  exception when insufficient_privilege then
    null;
  end;

  raise notice 'handles.sql: a username is claimed once, through claim_handle and not through a PATCH, with the reserved names, the reader_ prefix, the shape and the guest refusal all still enforced, and the rest of the profile still writable';
end $$;

rollback;
