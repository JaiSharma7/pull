-- Feedback is a reader's own, it is bounded, and it cannot be rewritten after sending.
--
-- Run as the reader, so RLS and the grants are actually in force. An owner-role query
-- cannot see a policy, so a file without `assert_is_reader()` proves less than it looks
-- like it does. Read-only in effect: everything rolls back.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_is_reader() returns void
language plpgsql as $fn$
begin
  if current_user <> 'authenticated' then
    raise exception
      'assertions must run as the reader, not as %. RLS and grants are invisible to an '
      'owner-role query, so this file would be proving nothing.',
      current_user;
  end if;
end $fn$;

do $$
declare
  alice uuid := extensions.gen_random_uuid();
  bob   uuid := extensions.gen_random_uuid();
  ghost uuid := extensions.gen_random_uuid();
  seen  int;
  state text;
  mine  uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values (alice, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'fb' || left(alice::text, 8) || '@example.test', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
         (bob, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'fb' || left(bob::text, 8) || '@example.test', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at, is_anonymous,
                          raw_app_meta_data, raw_user_meta_data)
  values (ghost, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', null, '',
          now(), now(), true,
          '{"provider":"anonymous","providers":["anonymous"]}'::jsonb, '{}'::jsonb);

  -- Bob's message, written as owner BEFORE dropping to the reader role, so that what
  -- alice cannot see below is a row that genuinely exists rather than one the insert
  -- quietly refused.
  insert into public.feedback (user_id, subject, message)
  values (bob, 'bug', 'Bob found something broken.');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', alice, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  -- ------------------------------------------------------ 1. a reader may send
  insert into public.feedback (user_id, subject, message, path)
  values (alice, 'idea', 'A way to say what is wrong.', '/settings?section=feedback')
  returning id into mine;

  if mine is null then
    raise exception 'a reader could not send feedback at all.';
  end if;

  -- ------------------------------------------- 2. and only ever as themselves
  begin
    insert into public.feedback (user_id, subject, message)
    values (bob, 'bug', 'Signed as Bob, sent by Alice.');
    raise exception
      'a reader filed feedback under another reader''s id. feedback_insert_own is '
      'supposed to check auth.uid() against user_id.';
  exception when insufficient_privilege then
    null;
  end;

  -- ------------------------------------------------ 3. and reads only their own
  select count(*) into seen from public.feedback;
  if seen <> 1 then
    raise exception
      'a reader can see % feedback rows; they may see exactly their own (1). Bob''s '
      'row exists and must not be among them.', seen;
  end if;

  -- ------------------------------ 4. a sent message cannot be rewritten or withdrawn
  --
  -- No update and no delete policy exists, so both match no rows rather than raising.
  -- Asserting the row is UNCHANGED is the point: a silent no-op and a successful edit
  -- look identical from the client, and only one of them is correct.
  update public.feedback set message = 'Rewritten after the fact.' where id = mine;
  if (select f.message from public.feedback f where f.id = mine)
     is distinct from 'A way to say what is wrong.' then
    raise exception 'a reader edited feedback after sending it.';
  end if;

  delete from public.feedback where id = mine;
  if not exists (select 1 from public.feedback f where f.id = mine) then
    raise exception 'a reader deleted feedback after sending it.';
  end if;

  -- --------------------------------------------------------- 5. the bounds hold
  begin
    insert into public.feedback (user_id, subject, message)
    values (alice, 'bug', '');
    raise exception 'an empty message was accepted.';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.feedback (user_id, subject, message)
    values (alice, 'bug', repeat('x', 4001));
    raise exception 'a message over the 4000-character cap was accepted.';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.feedback (user_id, subject, message)
    values (alice, 'not_a_subject', 'Unknown subject.');
    raise exception 'an unknown subject was accepted; the enum is supposed to close the set.';
  exception when invalid_text_representation then
    null;
  end;

  -- ------------------------------------------------- 6. ten an hour, then refused
  --
  -- One is already sent, so nine more reach the ceiling and the eleventh is refused.
  for i in 1..9 loop
    insert into public.feedback (user_id, subject, message)
    values (alice, 'other', 'Message ' || i);
  end loop;

  begin
    insert into public.feedback (user_id, subject, message)
    values (alice, 'other', 'One too many.');
    raise exception 'the eleventh message in an hour was accepted; the rate limit did not fire.';
  exception when others then
    get stacked diagnostics state = returned_sqlstate;
    if state <> '53400' then
      raise exception
        'the rate limit refused with % rather than 53400, which is the code that tells '
        '"slow down" apart from "that was invalid".', state;
    end if;
  end;

  -- ------------------------ 7. and the limit is per reader, not a global ceiling
  --
  -- Bob is at one message, not eleven. A global ceiling would refuse him here, and
  -- would mean one reader could silence everybody else.
  perform set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'authenticated')::text, true);
  insert into public.feedback (user_id, subject, message)
  values (bob, 'content', 'Bob is not rate limited by Alice.');

  -- --------------------------------------------------------- 8. a guest may send
  --
  -- Deliberate, and the opposite of `claim_handle`. A guest is the reader most likely
  -- to hit something broken -- they are new -- and least able to write in about it,
  -- having given no address. Refusing them would lose exactly the feedback worth most.
  perform set_config('request.jwt.claims',
    json_build_object('sub', ghost, 'role', 'authenticated', 'is_anonymous', true)::text,
    true);
  insert into public.feedback (user_id, subject, message)
  values (ghost, 'bug', 'Sent by a guest.');

  raise notice 'feedback.sql: a reader sends as themselves and reads only their own, cannot rewrite or withdraw what they sent, is bounded by length, subject and ten an hour, and a guest may send';
end $$;

rollback;
