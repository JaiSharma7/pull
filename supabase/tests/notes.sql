-- ---------------------------------------------------------------------------
-- A note needs a readable pull.
--
-- Asserted, and each is a way 20260909020000 could be wrong:
--
--   * reader B cannot insert a note against reader A's private imported pull, by uuid
--   * reader B cannot insert a note against A's private summary, by uuid
--   * reader B CAN note a public pull, and A CAN note their own private one -- the
--     guard refuses the stranger, not the note
--   * reader B cannot move a note they wrote onto A's private pull afterwards -- the
--     update half is load-bearing, as it was for questions
--   * a note that names no pull and no summary is still allowed
--   * a note against a pull that does not exist is refused, whichever guard says so
--
-- Everything runs as a real reader under RLS. The whole file rolls back.
-- ---------------------------------------------------------------------------

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

create or replace function pg_temp.become(p_uid uuid) returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
end $fn$;

create or replace function pg_temp.as_owner() returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $fn$;

do $$
declare
  reader_a uuid := extensions.gen_random_uuid();
  reader_b uuid := extensions.gen_random_uuid();
  priv_work    uuid := extensions.gen_random_uuid();
  priv_summary uuid := extensions.gen_random_uuid();
  priv_pull    uuid;
  public_pull  uuid;
  note_b       uuid;
  code         text;
  n            int;
begin
  insert into auth.users (id, email)
  values
    (reader_a, 'reader_a_notes@example.com'),
    (reader_b, 'reader_b_notes@example.com');

  -- A's private import: a user_owned work under a private summary A authored, which
  -- is the shape `commit_import` writes and `pulls_read_via_summary` hides from B.
  insert into public.works (id, kind, title, slug, rights_status)
  values (priv_work, 'book', 'Reader A''s Highlights', 'notes-test-private', 'user_owned');

  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title, published_at)
  values (priv_summary, priv_work, 1, 'published', 'private', reader_a,
          'Reader A''s Highlights', now());

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (priv_summary, 1, 'A private highlight', 'Only A can read this.', 5)
  returning id into priv_pull;

  select p.id into public_pull
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
   and s.visibility = 'public' and s.status = 'published'
  order by p.id
  limit 1;

  if public_pull is null then
    raise exception 'fixture: the seed has no public pull';
  end if;

  -- ---------------------------------------------------------------------------
  -- 1. B cannot see the pull, and cannot note it either
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_b);

  select count(*) into n from public.pulls where id = priv_pull;
  if n <> 0 then
    raise exception 'fixture: reader B can read A''s private pull, so this file proves nothing';
  end if;

  code := null;
  begin
    insert into public.notes (user_id, pull_id, body, visibility)
    values (reader_b, priv_pull, 'A note on something I was never shown', 'private');
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B wrote a note against reader A''s private pull (got %). notes_insert_own '
      'has no pull_id leg.', coalesce(code, 'no error');
  end if;

  code := null;
  begin
    insert into public.notes (user_id, summary_id, body, visibility)
    values (reader_b, priv_summary, 'A note on a summary I cannot read', 'private');
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B wrote a note against reader A''s private summary (got %)',
      coalesce(code, 'no error');
  end if;

  -- A pull that does not exist. The RLS check and the foreign key both refuse it; which
  -- one speaks first is not this file's claim, only that neither lets it through.
  code := null;
  begin
    insert into public.notes (user_id, pull_id, body, visibility)
    values (reader_b, extensions.gen_random_uuid(), 'A note on nothing', 'private');
  exception when others then
    code := sqlstate;
  end;
  if code not in ('42501', '23503') then
    raise exception 'a note against a nonexistent pull was accepted (got %)', coalesce(code, 'no error');
  end if;

  select count(*) into n from public.notes where user_id = reader_b;
  if n <> 0 then
    raise exception 'a refused note was written anyway (% rows)', n;
  end if;

  -- ---------------------------------------------------------------------------
  -- 2. The guard refuses the stranger, not the note
  -- ---------------------------------------------------------------------------
  insert into public.notes (user_id, pull_id, body, visibility)
  values (reader_b, public_pull, 'A note on a public idea', 'private')
  returning id into note_b;

  insert into public.notes (user_id, body, visibility)
  values (reader_b, 'A note about nothing in particular', 'private');

  select count(*) into n from public.notes where user_id = reader_b;
  if n <> 2 then
    raise exception 'reader B expected 2 notes of their own, has %', n;
  end if;

  perform pg_temp.become(reader_a);

  insert into public.notes (user_id, pull_id, body, visibility)
  values (reader_a, priv_pull, 'My own note on my own highlight', 'private');

  insert into public.notes (user_id, summary_id, body, visibility)
  values (reader_a, priv_summary, 'My own note on my own import', 'private');

  select count(*) into n from public.notes where user_id = reader_a;
  if n <> 2 then
    raise exception 'reader A expected 2 notes of their own, has %', n;
  end if;

  -- ---------------------------------------------------------------------------
  -- 3. The update half: a note cannot be moved onto what its owner cannot read
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_b);

  code := null;
  begin
    update public.notes set pull_id = priv_pull where id = note_b;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved a note onto reader A''s private pull (got %). The update policy '
      'does not repeat the insert guard.', coalesce(code, 'no error');
  end if;

  select count(*) into n from public.notes where id = note_b and pull_id = public_pull;
  if n <> 1 then
    raise exception 'reader B''s note is no longer on the public pull it was written against';
  end if;

  -- And an ordinary edit still works.
  update public.notes set body = 'A note on a public idea, revised' where id = note_b;
  select count(*) into n from public.notes where id = note_b and body like '%revised';
  if n <> 1 then
    raise exception 'reader B could not edit their own note';
  end if;

  raise notice 'notes.sql: a note needs a readable pull, on the way in and on the way through';
end $$;

rollback;
