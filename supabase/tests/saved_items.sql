-- ---------------------------------------------------------------------------
-- A save needs a readable pull.
--
-- `saved_items_own` (20260829124730) was `for all using (auth.uid() = user_id)`, which
-- never looked at `pull_id` or `summary_id`. 20260910010000 splits it and adds the two
-- halves. Asserted, and each is a way that migration could be wrong:
--
--   * reader B cannot save reader A's private imported pull, by uuid
--   * nor A's private summary, by uuid
--   * nor a pull that does not exist, whichever guard says so
--   * a refused save writes nothing
--   * reader B CAN save a public pull and a public summary, and A CAN save their own
--     private import -- law 3 says stashing is unlimited and free, and the guard
--     refuses the stranger, never the save
--   * reader B cannot MOVE a save onto A's private pull or summary afterwards,
--     including by swapping which of the two columns is set -- `saved_items_one_target`
--     means a move between kinds is one statement, and the trigger has to see it
--   * the split kept every capability the `for all` policy had: B still reads, files,
--     annotates, archives and deletes their own saves, and still sees none of A's
--   * a save whose pull has since stopped being readable can still be re-filed into a
--     stash, annotated, archived, kept where it is and deleted -- and still not moved
--     onto something unreadable. This is why the update half is a trigger and not a
--     policy leg: a reader must be able to tidy up after a summary is withdrawn.
--
-- Every assertion runs as a real reader under RLS. The fixture, and the one step that
-- withdraws a summary from under a save, are the owner's acts. The whole file rolls back.
--
-- What FAILS without 20260910010000: section 1's insert legs, section 4's move checks,
-- section 5's "still refused from an unreadable start", and section 7's trigger revoke.
-- Sections 2, 3 and 6, and the nonexistent-target check (which accepts the foreign key's
-- 23503 as readily as 42501), pass against the old `for all` policy too -- it carried the
-- owner leg on every command, so section 6 is a regression guard on what the split must
-- not cost rather than evidence for the guard. That is exactly why section 6 exists: the
-- split retypes that leg into five places, and a mutant dropping it from any one of them
-- passed every assertion in this file before those probes were written.
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
  priv_pull      uuid;
  shared_pull    uuid;
  public_pull    uuid;
  public_pull_2  uuid;
  public_summary uuid;
  stash_b     uuid;
  save_b      uuid;
  save_shared uuid;
  save_keep   uuid;
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
     'si-a-' || left(reader_a::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
    (reader_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'si-b-' || left(reader_b::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  insert into public.works (id, kind, title, slug, rights_status)
  values (priv_work, 'book', 'Reader A''s Highlights', 'si-test-private', 'user_owned');

  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title, published_at)
  values (priv_summary, priv_work, 1, 'published', 'private', reader_a,
          'Reader A''s Highlights', now());

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (priv_summary, 1, 'A private highlight', 'Only A can read this.', 5)
  returning id into strict priv_pull;

  insert into public.works (id, kind, title, slug, rights_status)
  values (shared_work, 'book', 'Reader A''s Shared Notes', 'si-test-shared', 'user_owned');

  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title, published_at)
  values (shared_summary, shared_work, 1, 'published', 'public', reader_a,
          'Reader A''s Shared Notes', now());

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (shared_summary, 1, 'A shared idea', 'Anyone can read this, for now.', 5)
  returning id into strict shared_pull;

  select p.id, p.summary_id into public_pull, public_summary
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
  -- 1. B cannot see it, and cannot keep it either
  -- -------------------------------------------------------------------------
  perform pg_temp.become(reader_b);

  select count(*) into n from public.pulls where id = priv_pull;
  if n <> 0 then
    raise exception 'fixture: reader B can read A''s private pull, so this file proves nothing';
  end if;

  code := null;
  begin
    insert into public.saved_items (user_id, pull_id) values (reader_b, priv_pull);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B saved reader A''s private pull (got %). saved_items_insert_own has no '
      'pull_id leg.', coalesce(code, 'no error');
  end if;

  code := null;
  begin
    insert into public.saved_items (user_id, summary_id) values (reader_b, priv_summary);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B saved reader A''s private summary (got %). The insert guard checks '
      'pull_id and not summary_id.', coalesce(code, 'no error');
  end if;

  -- A pull that does not exist. The RLS check and the foreign key both refuse it; which
  -- one speaks first is not this file's claim, only that neither lets it through.
  code := null;
  begin
    insert into public.saved_items (user_id, pull_id)
    values (reader_b, extensions.gen_random_uuid());
  exception when others then
    code := sqlstate;
  end;
  if code is null or code not in ('42501', '23503') then
    raise exception 'a save of a nonexistent pull was accepted (got %)',
      coalesce(code, 'no error');
  end if;

  select count(*) into n from public.saved_items where user_id = reader_b;
  if n <> 0 then
    raise exception 'a refused save was written anyway (% rows)', n;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. The guard refuses the stranger, not the save
  -- -------------------------------------------------------------------------
  insert into public.saved_items (user_id, pull_id) values (reader_b, public_pull)
  returning id into strict save_b;

  insert into public.saved_items (user_id, summary_id) values (reader_b, public_summary);

  insert into public.saved_items (user_id, pull_id) values (reader_b, shared_pull)
  returning id into strict save_shared;

  insert into public.saved_items (user_id, pull_id) values (reader_b, public_pull_2)
  returning id into strict save_keep;

  select count(*) into n from public.saved_items where user_id = reader_b;
  if n <> 4 then
    raise exception 'reader B expected 4 saves of their own, has %', n;
  end if;

  perform pg_temp.become(reader_a);

  insert into public.saved_items (user_id, pull_id)    values (reader_a, priv_pull);
  insert into public.saved_items (user_id, summary_id) values (reader_a, priv_summary);

  select count(*) into n from public.saved_items where user_id = reader_a;
  if n <> 2 then
    raise exception 'reader A could not keep their own private import (has %)', n;
  end if;

  -- -------------------------------------------------------------------------
  -- 3. The split kept every capability the `for all` policy had
  -- -------------------------------------------------------------------------
  select count(*) into n from public.saved_items;
  if n <> 2 then
    raise exception
      'reader A sees % saves, not just their own 2. The split lost the owner scope '
      'on SELECT.', n;
  end if;

  perform pg_temp.become(reader_b);

  select count(*) into n from public.saved_items;
  if n <> 4 then
    raise exception 'reader B sees % saves rather than their own 4', n;
  end if;

  insert into public.stashes (user_id, name) values (reader_b, 'Later')
  returning id into strict stash_b;

  update public.saved_items
     set stash_id = stash_b, note = 'Worth a second look', read_later = true
   where id = save_b;

  select count(*) into n from public.saved_items
  where id = save_b and stash_id = stash_b and read_later;
  if n <> 1 then
    raise exception 'reader B could not file their own save after the split';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. The update half: a save cannot be moved onto what its owner cannot read
  -- -------------------------------------------------------------------------
  code := null;
  begin
    update public.saved_items set pull_id = priv_pull where id = save_b;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved a save onto reader A''s private pull (got %). The update half '
      'does not repeat the insert guard.', coalesce(code, 'no error');
  end if;

  -- `saved_items_one_target` means changing which kind of thing is saved is a single
  -- statement clearing one column and setting the other. The trigger has to see that
  -- as a move, not as a clear.
  code := null;
  begin
    update public.saved_items set pull_id = null, summary_id = priv_summary
     where id = save_b;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B swapped a save onto reader A''s private summary (got %). The trigger '
      'checks pull_id and not summary_id.', coalesce(code, 'no error');
  end if;

  select count(*) into n from public.saved_items
  where id = save_b and pull_id = public_pull and summary_id is null;
  if n <> 1 then
    raise exception 'reader B''s save is no longer on the pull it was made against';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. A save outlives the readability of what it holds
  -- -------------------------------------------------------------------------
  perform pg_temp.as_owner();
  update public.summaries set visibility = 'private' where id = shared_summary;

  perform pg_temp.become(reader_b);

  select count(*) into n from public.pulls where id = shared_pull;
  if n <> 0 then
    raise exception 'fixture: reader B can still read the withdrawn pull, so section 5 proves nothing';
  end if;

  -- The organising edits a policy leg would have refused. This is the whole reason the
  -- update half is a trigger: `updateSavedItem` in the client sends exactly this shape.
  code := null;
  begin
    update public.saved_items
       set stash_id = stash_b, note = 'Withdrawn, but mine', archived = true
     where id = save_shared;
  exception when others then
    code := sqlstate;
  end;
  if code is not null then
    raise exception
      'reader B could not re-file a save whose pull was withdrawn (got %). The '
      'readability check is judging the row as it will be, not the move.', code;
  end if;

  -- Setting the column to what it already holds is not a move.
  code := null;
  begin
    update public.saved_items set pull_id = shared_pull where id = save_shared;
  exception when others then
    code := sqlstate;
  end;
  if code is not null then
    raise exception
      'reader B could not save a row that stays on its withdrawn pull (got %). The '
      'trigger is not comparing old and new.', code;
  end if;

  select count(*) into n from public.saved_items
  where id = save_shared and pull_id = shared_pull and archived
    and note = 'Withdrawn, but mine';
  if n <> 1 then
    raise exception 'reader B''s save on the withdrawn pull did not keep its edits';
  end if;

  -- Still not onto something unreadable, from an unreadable start.
  code := null;
  begin
    update public.saved_items set pull_id = priv_pull where id = save_shared;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved a save from a withdrawn pull onto A''s private one (got %)',
      coalesce(code, 'no error');
  end if;

  -- Nor onto the withdrawn summary, from a readable start.
  code := null;
  begin
    update public.saved_items set pull_id = null, summary_id = shared_summary
     where id = save_keep;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved a save onto a summary that has been withdrawn (got %)',
      coalesce(code, 'no error');
  end if;

  -- And a reader may always unsave, whatever became of what they had kept.
  delete from public.saved_items where id = save_shared;
  select count(*) into n from public.saved_items where user_id = reader_b;
  if n <> 3 then
    raise exception
      'reader B could not unsave a withdrawn pull (% rows left)', n;
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
    insert into public.saved_items (user_id, pull_id) values (reader_a, public_pull_2);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B wrote a save into reader A''s account (got %). The INSERT policy '
      'lost its owner leg in the split.', coalesce(code, 'no error');
  end if;

  -- Counted as the OWNER, not as reader B. Under B's own SELECT policy A's rows are
  -- invisible, so `count(*) where user_id = reader_a` is 0 whether or not the write
  -- landed -- which would make both of these pass for the wrong reason.
  update public.saved_items set note = 'amended by a stranger';
  perform pg_temp.as_owner();
  select count(*) into n from public.saved_items where user_id = reader_a and note = 'amended by a stranger';
  if n <> 0 then
    raise exception
      'reader B amended % of reader A''s saved_items rows through the update policy', n;
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
  -- reader B and giving their rows away. This probe must also run BEFORE the delete
  -- below, or B owns nothing by the time it fires and it passes on an empty set.
  select count(*) into n from public.saved_items;
  if n = 0 then
    raise exception
      'fixture: reader B owns no saved_items rows here, so the handover probe would pass '
      'against an empty set and prove nothing';
  end if;
  code := null;
  begin
    update public.saved_items set user_id = reader_a;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B handed their own saved_items rows to reader A (got %). The UPDATE policy '
      'lost its owner leg from `with check`.', coalesce(code, 'no error');
  end if;

  delete from public.saved_items;
  perform pg_temp.as_owner();
  select count(*) into n from public.saved_items where user_id = reader_a;
  if n <> 2 then
    raise exception
      'reader B deleted reader A''s saved_items rows through the delete policy '
      '(2 expected, % left)', n;
  end if;
  perform pg_temp.become(reader_b);

  -- The trigger function's own EXECUTE revoke, which nothing else asserts. It is NOT
  -- what makes section 7 work -- that probe never names this function, and it is
  -- refused identically with EXECUTE granted (measured) -- so this stands on its own:
  -- a trigger function reachable as an RPC endpoint is a door nobody meant to open.
  if has_function_privilege('authenticated', 'public.saved_items_keep_readable()', 'execute') then
    raise exception
      'authenticated holds EXECUTE on saved_items_keep_readable; the revoke in '
      '20260910010000 was undone';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Nobody may put a trigger beside the guard
  --
  -- `before update of <cols>` fires on the SET list and BEFORE triggers run in name
  -- order, so a trigger sorting after `saved_items_keep_readable` could set the column the
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
    execute 'create trigger zz_beside_the_guard before update on public.saved_items '
            'for each row execute function pg_temp.zz_beside_the_guard()';
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'a reader created a trigger on public.saved_items (got %). TRIGGER is still '
      'granted, so the guard can be walked around by one that sorts after it.',
      coalesce(code, 'no error');
  end if;

  raise notice 'saved_items.sql: a save needs a readable pull or summary on the way in, '
    'cannot be moved onto one its owner cannot read by either column, and stays filable, '
    'annotatable and deletable after what it holds is withdrawn';
end $$;

rollback;
