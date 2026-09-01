-- The account functions, exercised as two readers who must not be able to touch
-- each other.
--
-- Everything in 20260901140000 and 20260901150000 is `security definer`, which means
-- every one of them runs with the privileges of the owner and derives the caller from
-- `auth.uid()` rather than from an argument. That is the correct design and it is also
-- the design where a single missing predicate hands one reader another reader's
-- sessions -- so these assertions are about the predicate, not about the happy path.
--
-- Written as pairs: for each function, the thing the owner may do, and the same thing
-- attempted against somebody else. A test that only proves the first is the test that
-- lets the second ship.
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_is_reader() returns void
language plpgsql as $fn$
begin
  if current_user <> 'authenticated' then
    raise exception
      'assertions must run as the reader, not as %. RLS and auth.uid() are '
      'invisible to an owner-role query.', current_user;
  end if;
end $fn$;

/** Become a reader, on a specific session, the way GoTrue presents one. */
create or replace function pg_temp.become(p_user uuid, p_session uuid) returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated',
                      'session_id', p_session)::text, true);
end $fn$;

/*
 * Back to the owning role for setup that a reader is correctly unable to perform.
 *
 * `auth.sessions` is not writable by `authenticated` at all, and `generation_jobs`
 * has a SELECT policy and no INSERT one -- the only way a reader creates a job is
 * `enqueue_generation_job`, which is the whole point of that function. So the fixtures
 * below are staged as the owner and then *asserted* as the reader, which is the only
 * honest arrangement: staging as the reader would fail, and asserting as the owner
 * would prove nothing.
 */
create or replace function pg_temp.as_owner() returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
end $fn$;

do $$
declare
  alice     uuid := extensions.gen_random_uuid();
  bob       uuid := extensions.gen_random_uuid();
  a_sess    uuid := extensions.gen_random_uuid();
  a_sess2   uuid := extensions.gen_random_uuid();
  b_sess    uuid := extensions.gen_random_uuid();
  signup_id uuid;
  job_id    uuid;
  seen      int;
  killed    boolean;
  n         int;
  codes     text[];
  age       int;
begin
  foreach signup_id in array array[alice, bob] loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values (signup_id, '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated',
            'acct' || left(signup_id::text, 8) || '@example.test', '',
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  end loop;

  insert into auth.sessions (id, user_id, created_at, updated_at, aal, user_agent)
  values (a_sess,  alice, now(), now(), 'aal1', 'Test/1.0'),
         (a_sess2, alice, now() - interval '3 days', now(), 'aal1', 'Test/2.0'),
         (b_sess,  bob,   now(), now(), 'aal1', 'Test/3.0');

  -- ------------------------------------------------- 1. my_sessions is mine only
  perform pg_temp.become(alice, a_sess);
  perform pg_temp.assert_is_reader();

  select count(*) into seen from public.my_sessions();
  if seen <> 2 then
    raise exception 'alice sees % sessions; she has exactly 2.', seen;
  end if;
  select count(*) into seen from public.my_sessions() s where s.id = b_sess;
  if seen <> 0 then
    raise exception 'my_sessions handed alice a session belonging to bob.';
  end if;
  select count(*) into seen from public.my_sessions() s where s.is_current;
  if seen <> 1 then
    raise exception 'exactly one session must be marked current; % were.', seen;
  end if;

  -- --------------------------------------- 2. revoke_session cannot cross accounts
  killed := public.revoke_session(b_sess);
  if killed then
    raise exception 'alice revoked bob''s session.';
  end if;

  -- Reading auth.sessions needs the owner: `authenticated` holds USAGE on schema
  -- `auth` and EXECUTE on auth.uid()/auth.jwt(), and no table privileges at all. That
  -- is the point -- it is why `my_sessions` is `security definer` -- and it means the
  -- *verification* of a definer function cannot be done through the definer function
  -- being verified. Assert as the owner, then go back to being alice.
  perform pg_temp.as_owner();
  if not exists (select 1 from auth.sessions where id = b_sess) then
    raise exception 'bob''s session row was deleted by alice.';
  end if;
  perform pg_temp.become(alice, a_sess);

  killed := public.revoke_session(a_sess2);
  if not killed then
    raise exception 'alice could not revoke her own session.';
  end if;

  -- ------------------------------- 3. revoke_other_sessions keeps the one asking
  perform pg_temp.as_owner();
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (extensions.gen_random_uuid(), alice, now(), now(), 'aal1');
  perform pg_temp.become(alice, a_sess);

  n := public.revoke_other_sessions();
  if n <> 1 then
    raise exception 'revoke_other_sessions removed % sessions; expected 1.', n;
  end if;

  perform pg_temp.as_owner();
  if not exists (select 1 from auth.sessions where id = a_sess) then
    raise exception
      'revoke_other_sessions ended the calling session. That is signOut(global), '
      'and it drops the reader at a sign-in screen for securing their account.';
  end if;
  if not exists (select 1 from auth.sessions where id = b_sess) then
    raise exception 'revoke_other_sessions reached into another account.';
  end if;
  perform pg_temp.become(alice, a_sess);

  -- ------------------------------------------------- 4. recovery codes are single-use
  codes := public.generate_mfa_recovery_codes();
  if array_length(codes, 1) <> 10 then
    raise exception 'expected 10 recovery codes, got %.',
      coalesce(array_length(codes, 1), 0);
  end if;
  select count(*) into seen from public.mfa_recovery_codes;
  if seen <> 10 then
    raise exception 'alice sees % of her own recovery codes; expected 10.', seen;
  end if;

  if not public.redeem_mfa_recovery_code(codes[1]) then
    raise exception 'a freshly issued recovery code was refused.';
  end if;
  if public.redeem_mfa_recovery_code(codes[1]) then
    raise exception 'a recovery code was accepted twice.';
  end if;
  -- Punctuation and case must not decide whether a code works.
  if not public.redeem_mfa_recovery_code(upper(replace(codes[2], '-', ''))) then
    raise exception 'a code typed without its dash, in capitals, was refused.';
  end if;
  if public.redeem_mfa_recovery_code('not-a-code') then
    raise exception 'a nonsense recovery code was accepted.';
  end if;

  -- Regenerating cancels the old set, which is what "show new codes" has to mean.
  perform public.generate_mfa_recovery_codes();
  if public.redeem_mfa_recovery_code(codes[3]) then
    raise exception 'a code from the previous set still worked after regenerating.';
  end if;

  -- Bob can see none of them.
  perform pg_temp.become(bob, b_sess);
  select count(*) into seen from public.mfa_recovery_codes;
  if seen <> 0 then
    raise exception 'bob can read % of alice''s recovery code rows.', seen;
  end if;

  -- ----------------------------------------------- 5. deletion needs a recent sign-in
  perform pg_temp.become(alice, a_sess);
  age := public.session_age_seconds();
  if age is null or age > 60 then
    raise exception 'a session created just now reports an age of %.', age;
  end if;

  -- Age it past the window and the deletion must refuse.
  perform pg_temp.as_owner();
  update auth.sessions set created_at = now() - interval '2 hours' where id = a_sess;
  perform pg_temp.become(alice, a_sess);
  begin
    perform public.delete_my_account();
    raise exception 'an account was deleted from a two-hour-old session.';
  exception when invalid_authorization_specification then
    null;  -- expected
  end;

  -- ------------------------------- 6. deletion takes submitted material with it
  perform pg_temp.as_owner();
  update auth.sessions set created_at = now() where id = a_sess;
  -- Staged as the owner because a reader has no insert on generation_jobs: the RPC is
  -- the only path in, which is exactly why the row can outlive the account.
  insert into public.generation_jobs (requester_id, target, status)
  values (alice, '{"text":"something the reader pasted in"}'::jsonb, 'queued')
  returning id into job_id;
  perform pg_temp.become(alice, a_sess);

  -- This one the reader can do herself: stashes_insert_own.
  insert into public.stashes (user_id, name) values (alice, 'Test stash');

  perform public.delete_my_account();

  perform pg_temp.as_owner();
  if exists (select 1 from auth.users where id = alice) then
    raise exception 'delete_my_account left the auth.users row in place.';
  end if;
  if exists (select 1 from public.generation_jobs where id = job_id) then
    raise exception
      'a submitted generation job survived deletion. requester_id is ON DELETE SET '
      'NULL, so the row is anonymised rather than removed unless the function '
      'deletes it explicitly -- that is the gap docs/privacy.md used to admit to.';
  end if;
  if exists (select 1 from public.stashes where user_id = alice) then
    raise exception 'a stash survived deletion.';
  end if;
  if not exists (select 1 from auth.users where id = bob) then
    raise exception 'deleting alice removed bob.';
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'account security: ok';
end $$;

rollback;
