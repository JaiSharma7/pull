-- ---------------------------------------------------------------------------
-- A highlight needs a readable pull.
--
-- `highlights_own` (20260829124730) was `for all using (auth.uid() = user_id)`, which
-- never looked at `pull_id`. 20260910010000 splits it and adds the two halves. Asserted,
-- and each is a way that migration could be wrong:
--
--   * reader B cannot underline reader A's private imported pull, by uuid
--   * nor a pull that does not exist, whichever guard says so
--   * a refused highlight writes nothing
--   * reader B CAN underline a public pull, and A CAN underline their own private
--     import -- the guard refuses the stranger, not the highlight
--   * reader B cannot MOVE a highlight onto A's private pull afterwards; an insert
--     guard alone is one statement from useless
--   * the split kept every capability the `for all` policy had: B still reads, edits
--     and deletes their own highlights, and still sees none of A's
--   * a highlight whose pull has since stopped being readable can still be edited,
--     kept where it is, moved onto something readable, and deleted -- and still not
--     moved onto something unreadable. This is why the update half is a trigger and
--     not a policy leg.
--
-- Every assertion runs as a real reader under RLS. The fixture, and the one step that
-- withdraws a summary from under a highlight, are the owner's acts. The whole file rolls back.
--
-- What FAILS without 20260910010000: section 1's insert legs, section 4's move checks,
-- section 5's "still refused from an unreadable start", and section 7's trigger revoke.
-- Sections 2, 3 and 6, and the nonexistent-target check (which accepts the foreign key's
-- 23503 as readily as 42501), pass against the old `for all` policy too -- it carried the
-- owner leg on every command, so section 6 is a regression guard on what the split must
-- not cost rather than evidence for the guard. That is exactly why section 6 exists: the
-- split retypes that leg into five places, and a mutant dropping it from any one of the
-- four WRITE ones passed every assertion in this file before those probes were written.
-- The fifth, `select/using`, has been covered by section 3 since this file was written.
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
  priv_work      uuid := extensions.gen_random_uuid();
  priv_summary   uuid := extensions.gen_random_uuid();
  shared_work    uuid := extensions.gen_random_uuid();
  shared_summary uuid := extensions.gen_random_uuid();
  priv_pull     uuid;
  shared_pull   uuid;
  public_pull   uuid;
  public_pull_2 uuid;
  mark_b        uuid;
  mark_shared   uuid;
  mark_shared_2 uuid;
  code        text;
  n           int;
begin
  if (select count(*) from public.pulls) > 500 then
    raise exception
      'refusing to run: found % pulls, which is not a seed corpus.',
      (select count(*) from public.pulls);
  end if;

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values
    (reader_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'hl-a-' || left(reader_a::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
    (reader_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'hl-b-' || left(reader_b::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  -- A's private import: a user_owned work under a private summary A authored, which is
  -- the shape `commit_import` writes and `pulls_read_via_summary` hides from B.
  insert into public.works (id, kind, title, slug, rights_status)
  values (priv_work, 'book', 'Reader A''s Highlights', 'hl-test-private', 'user_owned');

  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title, published_at)
  values (priv_summary, priv_work, 1, 'published', 'private', reader_a,
          'Reader A''s Highlights', now());

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (priv_summary, 1, 'A private highlight', 'Only A can read this.', 5)
  returning id into strict priv_pull;

  -- A's shared summary: public now, withdrawn in section 5, with a highlight of B's
  -- made while it could be read.
  insert into public.works (id, kind, title, slug, rights_status)
  values (shared_work, 'book', 'Reader A''s Shared Notes', 'hl-test-shared', 'user_owned');

  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title, published_at)
  values (shared_summary, shared_work, 1, 'published', 'public', reader_a,
          'Reader A''s Shared Notes', now());

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (shared_summary, 1, 'A shared idea', 'Anyone can read this, for now.', 5)
  returning id into strict shared_pull;

  select p.id into public_pull
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
   and s.visibility = 'public' and s.status = 'published'
  where s.id <> shared_summary
  order by p.id
  limit 1;

  select p.id into public_pull_2
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
   and s.visibility = 'public' and s.status = 'published'
  where s.id <> shared_summary and p.id <> public_pull
  order by p.id
  limit 1;

  if public_pull is null or public_pull_2 is null then
    raise exception 'fixture: the seed has fewer than two public pulls';
  end if;

  -- -------------------------------------------------------------------------
  -- 1. B cannot see the pull, and cannot underline it either
  -- -------------------------------------------------------------------------
  perform pg_temp.become(reader_b);

  select count(*) into n from public.pulls where id = priv_pull;
  if n <> 0 then
    raise exception 'fixture: reader B can read A''s private pull, so this file proves nothing';
  end if;

  code := null;
  begin
    insert into public.highlights (user_id, pull_id, start_offset, end_offset, text)
    values (reader_b, priv_pull, 0, 10, 'Only A can');
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B underlined reader A''s private pull (got %). highlights_insert_own '
      'has no pull_id leg.', coalesce(code, 'no error');
  end if;

  -- A pull that does not exist. The RLS check and the foreign key both refuse it; which
  -- one speaks first is not this file's claim, only that neither lets it through.
  code := null;
  begin
    insert into public.highlights (user_id, pull_id, start_offset, end_offset, text)
    values (reader_b, extensions.gen_random_uuid(), 0, 10, 'Nothing at all');
  exception when others then
    code := sqlstate;
  end;
  if code is null or code not in ('42501', '23503') then
    raise exception 'a highlight on a nonexistent pull was accepted (got %)',
      coalesce(code, 'no error');
  end if;

  select count(*) into n from public.highlights where user_id = reader_b;
  if n <> 0 then
    raise exception 'a refused highlight was written anyway (% rows)', n;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. The guard refuses the stranger, not the highlight
  -- -------------------------------------------------------------------------
  insert into public.highlights (user_id, pull_id, start_offset, end_offset, text)
  values (reader_b, public_pull, 0, 12, 'A public idea')
  returning id into strict mark_b;

  insert into public.highlights (user_id, pull_id, start_offset, end_offset, text)
  values (reader_b, shared_pull, 0, 13, 'A shared idea')
  returning id into strict mark_shared;

  -- A second mark on the same pull, kept where it is so section 5 can delete a
  -- highlight that still sits on a pull its owner can no longer read.
  insert into public.highlights (user_id, pull_id, start_offset, end_offset, text)
  values (reader_b, shared_pull, 20, 30, 'for now.')
  returning id into strict mark_shared_2;

  select count(*) into n from public.highlights where user_id = reader_b;
  if n <> 3 then
    raise exception 'reader B expected 3 highlights of their own, has %', n;
  end if;

  perform pg_temp.become(reader_a);

  insert into public.highlights (user_id, pull_id, start_offset, end_offset, text)
  values (reader_a, priv_pull, 0, 4, 'Only');

  select count(*) into n from public.highlights where user_id = reader_a;
  if n <> 1 then
    raise exception 'reader A could not underline their own private import (has %)', n;
  end if;

  -- -------------------------------------------------------------------------
  -- 3. The split kept every capability the `for all` policy had
  -- -------------------------------------------------------------------------
  select count(*) into n from public.highlights;
  if n <> 1 then
    raise exception
      'reader A sees % highlights, not just their own 1. The split lost the owner '
      'scope on SELECT.', n;
  end if;

  perform pg_temp.become(reader_b);

  select count(*) into n from public.highlights;
  if n <> 3 then
    raise exception 'reader B sees % highlights rather than their own 3', n;
  end if;

  update public.highlights set text = 'A public idea, revised' where id = mark_b;
  select count(*) into n from public.highlights where id = mark_b and text like '%revised';
  if n <> 1 then
    raise exception 'reader B could not edit their own highlight after the split';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. The update half: a highlight cannot be moved onto what its owner cannot read
  -- -------------------------------------------------------------------------
  code := null;
  begin
    update public.highlights set pull_id = priv_pull where id = mark_b;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved a highlight onto reader A''s private pull (got %). The update '
      'half does not repeat the insert guard.', coalesce(code, 'no error');
  end if;

  select count(*) into n from public.highlights where id = mark_b and pull_id = public_pull;
  if n <> 1 then
    raise exception 'reader B''s highlight is no longer on the pull it was made on';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. A highlight outlives the readability of the pull it was made on
  -- -------------------------------------------------------------------------
  perform pg_temp.as_owner();
  update public.summaries set visibility = 'private' where id = shared_summary;

  perform pg_temp.become(reader_b);

  select count(*) into n from public.pulls where id = shared_pull;
  if n <> 0 then
    raise exception 'fixture: reader B can still read the withdrawn pull, so section 5 proves nothing';
  end if;

  -- The edit a policy leg would have refused.
  code := null;
  begin
    update public.highlights set text = 'A shared idea, revised' where id = mark_shared;
  exception when others then
    code := sqlstate;
  end;
  if code is not null then
    raise exception
      'reader B could not edit a highlight whose pull was withdrawn (got %). The '
      'readability check is judging the row as it will be, not the move.', code;
  end if;

  -- Setting the column to what it already holds is not a move.
  code := null;
  begin
    update public.highlights set pull_id = shared_pull where id = mark_shared;
  exception when others then
    code := sqlstate;
  end;
  if code is not null then
    raise exception
      'reader B could not save a highlight that stays on its withdrawn pull (got %). '
      'The trigger is not comparing old and new.', code;
  end if;

  -- Still not onto something unreadable, from an unreadable start.
  code := null;
  begin
    update public.highlights set pull_id = priv_pull where id = mark_shared;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved a highlight from a withdrawn pull onto A''s private one (got %)',
      coalesce(code, 'no error');
  end if;

  -- Onto something readable is allowed.
  update public.highlights set pull_id = public_pull_2 where id = mark_shared;

  select count(*) into n from public.highlights
  where id = mark_shared and pull_id = public_pull_2 and text like '%revised';
  if n <> 1 then
    raise exception 'reader B could not move a highlight off a withdrawn pull onto a public one';
  end if;

  -- And a reader may always take their own mark back, whatever became of its pull:
  -- mark_shared_2 is still sitting on the withdrawn one.
  delete from public.highlights where id = mark_shared_2;
  select count(*) into n from public.highlights where user_id = reader_b;
  if n <> 2 then
    raise exception
      'reader B could not delete a highlight on a withdrawn pull (% rows left)', n;
  end if;

  -- -------------------------------------------------------------------------
  -- 6. The split kept the owner leg on the WRITE halves, not just SELECT
  --
  -- Section 3 proves the owner scope survived on SELECT. These three prove it on
  -- INSERT, UPDATE and DELETE, which nothing here used to check -- and the gap was
  -- not theoretical: dropping `(select auth.uid()) = user_id` from the INSERT policy
  -- alone, the most plausible slip when hand-expanding one `for all` into four,
  -- passed every assertion in this file while letting a reader write rows into a
  -- stranger's account.
  --
  -- The UPDATE and DELETE probes carry NO `where`, deliberately. A `where id = ...`
  -- is filtered by the SELECT policy first, so it passes even against a write policy
  -- of `using (true)`; unqualified, each reaches every row its policy admits.
  -- -------------------------------------------------------------------------
  code := null;
  begin
    insert into public.highlights (user_id, pull_id, start_offset, end_offset, text)
    values (reader_a, public_pull, 0, 6, 'theirs');
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B wrote a highlight into reader A''s account (got %). The INSERT policy '
      'lost its owner leg in the split.', coalesce(code, 'no error');
  end if;

  -- Counted as the OWNER, not as reader B. Under B's own SELECT policy A's rows are
  -- invisible, so `count(*) where user_id = reader_a` is 0 whether or not the write
  -- landed -- which would make both of these pass for the wrong reason.
  update public.highlights set text = 'amended by a stranger';
  perform pg_temp.as_owner();
  select count(*) into n from public.highlights where user_id = reader_a and text = 'amended by a stranger';
  if n <> 0 then
    raise exception
      'reader B amended % of reader A''s highlights rows through the update policy', n;
  end if;
  perform pg_temp.become(reader_b);


  -- The fifth place the owner leg is retyped, and the one nothing probed until now.
  -- The split expands one `for all` into select/using, insert/with-check, update/using,
  -- update/WITH-CHECK and delete/using. Dropping it from the update `with check` alone
  -- leaves `using` intact -- so a reader still reaches only their own rows, and can hand
  -- them to anyone. Measured: that mutant passed every assertion in this file.
  --
  -- Unqualified again, and here it is the whole point. `update ... where id = ...` reads
  -- a column, so Postgres adds the SELECT policy as a check and refuses the handover even
  -- under the mutant; unqualified, nothing is read and only `with check` stands between
  -- reader B and giving their rows away. It runs BEFORE the delete below, where B still
  -- owns rows: against an empty set the update touches nothing and raises nothing, so
  -- the probe would fail loudly with "got no error" rather than pass -- the count guard
  -- is there to say which of the two went wrong, not to stop a false pass.
  select count(*) into n from public.highlights;
  if n = 0 then
    raise exception
      'fixture: reader B owns no highlights rows here, so the handover probe would pass '
      'against an empty set and prove nothing';
  end if;
  code := null;
  begin
    update public.highlights set user_id = reader_a;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B handed their own highlights rows to reader A (got %). The UPDATE policy '
      'lost its owner leg from `with check`.', coalesce(code, 'no error');
  end if;

  delete from public.highlights;
  perform pg_temp.as_owner();
  select count(*) into n from public.highlights where user_id = reader_a;
  if n <> 1 then
    raise exception
      'reader B deleted reader A''s highlights rows through the delete policy '
      '(1 expected, % left)', n;
  end if;
  perform pg_temp.become(reader_b);

  -- The trigger function's own EXECUTE revoke, which nothing else asserts. It is NOT
  -- what makes section 7 work -- that probe never names this function, and it is
  -- refused identically with EXECUTE granted (measured) -- so this stands on its own:
  -- a trigger function reachable as an RPC endpoint is a door nobody meant to open.
  if has_function_privilege('authenticated', 'public.highlights_keep_readable()', 'execute') then
    raise exception
      'authenticated holds EXECUTE on highlights_keep_readable; the revoke in '
      '20260910010000 was undone';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Nobody may put a trigger beside the guard
  --
  -- `before update of <cols>` fires on the SET list and BEFORE triggers run in name
  -- order, so a trigger sorting after `highlights_keep_readable` could set the column the
  -- guard watches on a statement that never names it -- the guard has already run, or
  -- never fired, and the row lands on a pull the reader cannot read. Reproduced before
  -- 20260910010000 revoked TRIGGER from anon and authenticated on this table.
  --
  -- The function is the reader's own, in pg_temp, which they may always create and
  -- execute. Pointing at a `public` trigger function instead would prove nothing:
  -- Postgres checks EXECUTE at CREATE TRIGGER time, and this table's guard has that
  -- revoked (in 20260910010000 -- 20260829124835 covers set_updated_at and its
  -- neighbours, not these), so the refusal would be the function's, not the table's.
  -- -------------------------------------------------------------------------
  code := null;
  begin
    execute 'create function pg_temp.zz_beside_the_guard() returns trigger '
            'language plpgsql as $q$ begin return new; end $q$';
  exception when others then
    code := sqlstate;
  end;
  if code is not null then
    raise exception
      'fixture: the reader could not create their own pg_temp function (got %), so '
      'the next assertion would pass for the wrong reason', code;
  end if;

  code := null;
  begin
    execute 'create trigger zz_beside_the_guard before update on public.highlights '
            'for each row execute function pg_temp.zz_beside_the_guard()';
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'a reader created a trigger on public.highlights (got %). TRIGGER is still '
      'granted, so the guard can be walked around by one that sorts after it.',
      coalesce(code, 'no error');
  end if;

  raise notice 'highlights.sql: a highlight needs a readable pull on the way in, cannot be '
    'moved onto one its owner cannot read, and outlives the readability of the pull it '
    'was made on';
end $$;

rollback;
