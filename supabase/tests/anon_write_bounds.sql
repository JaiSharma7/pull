-- The one door a visitor may write through, and the bounds on it.
--
-- `rights_requests_insert_any` is `for insert with check (true)` and has to stay that
-- way: a rights holder must be able to send a DMCA notice without first making an
-- account with the service they are complaining about. It is also the only
-- unauthenticated write in the schema, which makes it the only place a stranger can
-- consume storage -- and the project ref is committed in `apps/web/.env.production`,
-- so "a stranger" means anyone who reads the repository.
--
-- Asserted as `anon` rather than as the owner, because the whole question is what the
-- role behind the publishable key can do. An owner-role insert bypasses nothing here
-- (the checks are constraints, not policies) but it would bypass the *policy* that
-- makes the path reachable at all, and then this file would be proving a different
-- thing than it claims to.
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_is_visitor() returns void
language plpgsql as $fn$
begin
  if current_user <> 'anon' then
    raise exception 'these assertions must run as anon, not as %.', current_user;
  end if;
end $fn$;

do $$
declare
  ok        boolean;
  i         int;
  refused   boolean := false;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform pg_temp.assert_is_visitor();

  -- ------------------------------------------- 1. a real notice still gets through
  --
  -- Asserted first and deliberately: a bound that also blocks legitimate use is a
  -- worse bug than the one it fixes, and this path is a legal obligation.
  insert into public.rights_requests (claimant_name, claimant_email, notice_body)
  values ('A Rights Holder', 'agent@example.test',
          'I am the copyright owner of the work described above and believe in good '
          'faith that its use here is not authorised.');

  -- -------------------------------------------------- 2. an unbounded body is not
  begin
    insert into public.rights_requests (claimant_name, claimant_email, notice_body)
    values ('Filler', 'filler@example.test', repeat('x', 8001));
    raise exception 'an 8001-character notice body was accepted; the length cap is not in force.';
  exception when check_violation then
    null;  -- expected
  end;

  -- A name and an address have ceilings for the same reason.
  begin
    insert into public.rights_requests (claimant_name, claimant_email, notice_body)
    values (repeat('n', 201), 'filler@example.test', 'body');
    raise exception 'a 201-character claimant name was accepted.';
  exception when check_violation then
    null;
  end;

  -- Something that is not an address at all is refused, so the intake has a way to
  -- reply. This is a shape check, not validation -- a real address is not knowable here.
  begin
    insert into public.rights_requests (claimant_name, claimant_email, notice_body)
    values ('No Address', 'not-an-address', 'body');
    raise exception 'a claimant_email with no @ was accepted.';
  exception when check_violation then
    null;
  end;

  -- -------------------------------------------------- 3. nor an unbounded number
  --
  -- The ceiling is global (60/hour): PostgREST does not pass the client address down
  -- to Postgres, and `rate_limits` is keyed on a user_id that a visitor does not have,
  -- so there is nothing per-sender to key on. One notice is already in from step 1.
  for i in 2..60 loop
    insert into public.rights_requests (claimant_name, claimant_email, notice_body)
    values ('Filler ' || i, 'filler@example.test', 'body');
  end loop;

  begin
    insert into public.rights_requests (claimant_name, claimant_email, notice_body)
    values ('One Too Many', 'filler@example.test', 'body');
  exception when configuration_limit_exceeded then
    refused := true;
  end;

  if not refused then
    raise exception
      'the 61st notice in an hour was accepted; the global ceiling is not in force. '
      'Note the counting query must be security definer -- rights_requests_no_read is '
      '`using (false)`, so a count read through the policy is always zero.';
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'anon write bounds: ok';
end $$;

rollback;
