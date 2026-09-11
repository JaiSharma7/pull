-- ---------------------------------------------------------------------------
-- A read needs a readable pull.
--
-- `history_events_own` (20260829124730) was `for all using (auth.uid() = user_id)`,
-- which never looked at `pull_id`, `summary_id` or `work_id`. 20260909020000 left this
-- table out because it is written on every read and the subquery's cost is a decision
-- of its own; 20260910010000 makes that decision, with the measurement in its header.
-- Asserted here, and each is a way that migration could be wrong:
--
--   * reader B cannot record a read against reader A's private imported pull, by uuid
--   * nor against A's private summary, nor against A's private work -- three columns,
--     three legs, and the work leg is the one a `pulls`-only guard would miss
--   * nor against a pull that does not exist, whichever guard says so
--   * a refused event writes nothing
--   * `record_read` still records a public pull, and still records reader A's own
--     private import -- the guard refuses the stranger, not the read
--   * `record_read` on a pull B cannot read writes NO HISTORY EVENT and raises
--     nothing: its `insert ... select` already runs under the caller's RLS, so this
--     table was never the hole, and it must not become one. That is all this file
--     asserts and all it should be read as claiming -- `record_read` guards only its
--     first statement, and still writes `knowledge_states` and `feed_impressions`
--     against the same unreadable pull. Those tables are named in 20260910010000's
--     "does not fix"; they are not this file's subject
--   * ITS REPLAY IS STILL IDEMPOTENT -- one row, the larger dwell. `lib/offline.ts`
--     replays a queued read on exactly this promise. What keeps it true is that the
--     trigger compares old and new: `do update set dwell_ms` changes none of the three
--     columns, so nothing is a move. Naming those columns on the trigger additionally
--     spares the replay the call, which is a cost saving; removing the column list and
--     leaving the body alone keeps this file green, so this assertion is not evidence
--     for the column list and does not claim to be
--   * reader B cannot MOVE an event onto A's private pull, summary or work afterwards
--   * the split kept every capability the `for all` policy had: B still reads, amends
--     and deletes their own history, and still sees none of A's
--   * an event whose pull has since stopped being readable can still be amended, kept
--     where it is and deleted -- law 3 promises unlimited history, and a reader must
--     be able to forget something after its summary is withdrawn
--
-- Every assertion runs as a real reader under RLS. The fixture, and the one step that
-- withdraws a summary from under an event, are the owner's acts. The whole file rolls back.
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
  public_work    uuid;
  event_b      bigint;
  event_shared bigint;
  code  text;
  n     int;
  dwell int;
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
     'he-a-' || left(reader_a::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
    (reader_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'he-b-' || left(reader_b::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  insert into public.works (id, kind, title, slug, rights_status)
  values (priv_work, 'book', 'Reader A''s Highlights', 'he-test-private', 'user_owned');

  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title, published_at)
  values (priv_summary, priv_work, 1, 'published', 'private', reader_a,
          'Reader A''s Highlights', now());

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (priv_summary, 1, 'A private highlight', 'Only A can read this.', 5)
  returning id into strict priv_pull;

  insert into public.works (id, kind, title, slug, rights_status)
  values (shared_work, 'book', 'Reader A''s Shared Notes', 'he-test-shared', 'user_owned');

  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title, published_at)
  values (shared_summary, shared_work, 1, 'published', 'public', reader_a,
          'Reader A''s Shared Notes', now());

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (shared_summary, 1, 'A shared idea', 'Anyone can read this, for now.', 5)
  returning id into strict shared_pull;

  select p.id, p.summary_id, s.work_id into public_pull, public_summary, public_work
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
  -- 1. B cannot see it, and cannot claim to have read it either
  -- -------------------------------------------------------------------------
  perform pg_temp.become(reader_b);

  select count(*) into n from public.pulls where id = priv_pull;
  if n <> 0 then
    raise exception 'fixture: reader B can read A''s private pull, so this file proves nothing';
  end if;

  select count(*) into n from public.works where id = priv_work;
  if n <> 0 then
    raise exception 'fixture: reader B can read A''s private work, so the work leg proves nothing';
  end if;

  code := null;
  begin
    insert into public.history_events (user_id, kind, pull_id) values (reader_b, 'read', priv_pull);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B recorded a read of reader A''s private pull (got %). '
      'history_events_insert_own has no pull_id leg.', coalesce(code, 'no error');
  end if;

  code := null;
  begin
    insert into public.history_events (user_id, kind, summary_id)
    values (reader_b, 'read', priv_summary);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B recorded a read of reader A''s private summary (got %). The insert '
      'guard checks pull_id and not summary_id.', coalesce(code, 'no error');
  end if;

  -- The leg a pulls-only guard would miss. `works_read_readable` (20260905101000) hides
  -- an imported book from everyone but its importer, and an event naming it is the same
  -- false claim as one naming the pull.
  code := null;
  begin
    insert into public.history_events (user_id, kind, work_id) values (reader_b, 'read', priv_work);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B recorded a read of reader A''s private work (got %). The insert guard '
      'has no work_id leg.', coalesce(code, 'no error');
  end if;

  code := null;
  begin
    insert into public.history_events (user_id, kind, pull_id)
    values (reader_b, 'read', extensions.gen_random_uuid());
  exception when others then
    code := sqlstate;
  end;
  if code is null or code not in ('42501', '23503') then
    raise exception 'an event against a nonexistent pull was accepted (got %)',
      coalesce(code, 'no error');
  end if;

  select count(*) into n from public.history_events where user_id = reader_b;
  if n <> 0 then
    raise exception 'a refused history event was written anyway (% rows)', n;
  end if;

  -- `record_read` was never the hole: its `insert ... select` joins pulls and summaries
  -- under the caller's own RLS, so an unreadable pull yields no row. It must not become
  -- one either -- and it must not start raising, since the offline queue replays it.
  code := null;
  begin
    perform public.record_read(priv_pull, 30000, 0);
  exception when others then
    code := sqlstate;
  end;
  if code is not null then
    raise exception 'record_read raised % on a pull the caller cannot read; it used to write nothing', code;
  end if;

  select count(*) into n from public.history_events where user_id = reader_b;
  if n <> 0 then
    raise exception 'record_read wrote % event(s) for a pull the caller cannot read', n;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. The guard refuses the stranger, not the read
  -- -------------------------------------------------------------------------
  perform public.record_read(public_pull, 30000, 0);

  select h.id into strict event_b
  from public.history_events h where h.user_id = reader_b and h.pull_id = public_pull;

  select count(*) into n
  from public.history_events
  where id = event_b and summary_id = public_summary and work_id = public_work;
  if n <> 1 then
    raise exception 'record_read no longer records the summary and work behind a public pull';
  end if;

  perform public.record_read(shared_pull, 15000, 0);
  select h.id into strict event_shared
  from public.history_events h where h.user_id = reader_b and h.pull_id = shared_pull;

  -- A direct insert of a readable triple, which is what the policy actually guards.
  insert into public.history_events (user_id, kind, pull_id, summary_id, work_id, dwell_ms)
  values (reader_b, 'read', public_pull_2,
          (select p.summary_id from public.pulls p where p.id = public_pull_2),
          (select s.work_id from public.pulls p join public.summaries s on s.id = p.summary_id
            where p.id = public_pull_2),
          1000);

  select count(*) into n from public.history_events where user_id = reader_b;
  if n <> 3 then
    raise exception 'reader B expected 3 events of their own, has %', n;
  end if;

  -- The replay `lib/offline.ts` promises is idempotent: same pull, same day, one row,
  -- the larger dwell. The trigger must not fire on `do update set dwell_ms`.
  perform public.record_read(public_pull, 45000, 0);

  select count(*), max(dwell_ms) into n, dwell
  from public.history_events where user_id = reader_b and pull_id = public_pull;
  if n <> 1 then
    raise exception 'a replayed read wrote % rows for one pull and day', n;
  end if;
  if dwell <> 45000 then
    raise exception 'a replayed read did not raise dwell_ms (got %)', dwell;
  end if;

  perform pg_temp.become(reader_a);

  perform public.record_read(priv_pull, 30000, 0);
  select count(*) into n from public.history_events where user_id = reader_a and pull_id = priv_pull;
  if n <> 1 then
    raise exception 'reader A could not record a read of their own private import (% rows)', n;
  end if;

  -- -------------------------------------------------------------------------
  -- 3. The split kept every capability the `for all` policy had
  -- -------------------------------------------------------------------------
  select count(*) into n from public.history_events;
  if n <> 1 then
    raise exception
      'reader A sees % events, not just their own 1. The split lost the owner scope '
      'on SELECT.', n;
  end if;

  perform pg_temp.become(reader_b);

  select count(*) into n from public.history_events;
  if n <> 3 then
    raise exception 'reader B sees % events rather than their own 3', n;
  end if;

  -- -------------------------------------------------------------------------
  -- 4. The update half: an event cannot be moved onto what its owner cannot read
  -- -------------------------------------------------------------------------
  code := null;
  begin
    update public.history_events set pull_id = priv_pull where id = event_b;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved an event onto reader A''s private pull (got %). The update half '
      'does not repeat the insert guard.', coalesce(code, 'no error');
  end if;

  code := null;
  begin
    update public.history_events set summary_id = priv_summary where id = event_b;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved an event onto reader A''s private summary (got %)',
      coalesce(code, 'no error');
  end if;

  code := null;
  begin
    update public.history_events set work_id = priv_work where id = event_b;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved an event onto reader A''s private work (got %). The trigger has '
      'no work_id leg.', coalesce(code, 'no error');
  end if;

  select count(*) into n from public.history_events
  where id = event_b and pull_id = public_pull and summary_id = public_summary
    and work_id = public_work;
  if n <> 1 then
    raise exception 'reader B''s event no longer names what it was recorded against';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. History outlives the readability of what was read
  -- -------------------------------------------------------------------------
  perform pg_temp.as_owner();
  update public.summaries set visibility = 'private' where id = shared_summary;

  perform pg_temp.become(reader_b);

  select count(*) into n from public.pulls where id = shared_pull;
  if n <> 0 then
    raise exception 'fixture: reader B can still read the withdrawn pull, so section 5 proves nothing';
  end if;

  -- The amendment a policy leg would have refused.
  code := null;
  begin
    update public.history_events set dwell_ms = 60000 where id = event_shared;
  exception when others then
    code := sqlstate;
  end;
  if code is not null then
    raise exception
      'reader B could not amend an event whose pull was withdrawn (got %). The '
      'readability check is judging the row as it will be, not the move.', code;
  end if;

  -- Setting the column to what it already holds is not a move.
  code := null;
  begin
    update public.history_events set pull_id = shared_pull where id = event_shared;
  exception when others then
    code := sqlstate;
  end;
  if code is not null then
    raise exception
      'reader B could not save an event that stays on its withdrawn pull (got %). The '
      'trigger is not comparing old and new.', code;
  end if;

  select count(*) into n from public.history_events
  where id = event_shared and pull_id = shared_pull and dwell_ms = 60000;
  if n <> 1 then
    raise exception 'reader B''s event on the withdrawn pull did not keep its amendment';
  end if;

  -- Still not onto something unreadable, from an unreadable start.
  code := null;
  begin
    update public.history_events set work_id = priv_work where id = event_shared;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B moved an event from a withdrawn pull onto A''s private work (got %)',
      coalesce(code, 'no error');
  end if;

  -- And a reader may always forget something they read, whatever became of it. Law 3
  -- promises unlimited history; it does not promise history the reader cannot clear.
  delete from public.history_events where id = event_shared;
  select count(*) into n from public.history_events where user_id = reader_b;
  if n <> 2 then
    raise exception
      'reader B could not delete an event on a withdrawn pull (% rows left)', n;
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
    insert into public.history_events (user_id, kind, pull_id)
    values (reader_a, 'read', public_pull);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B wrote a read into reader A''s account (got %). The INSERT policy '
      'lost its owner leg in the split.', coalesce(code, 'no error');
  end if;

  -- Counted as the OWNER, not as reader B. Under B's own SELECT policy A's rows are
  -- invisible, so `count(*) where user_id = reader_a` is 0 whether or not the write
  -- landed -- which would make both of these pass for the wrong reason.
  update public.history_events set dwell_ms = 424242;
  perform pg_temp.as_owner();
  select count(*) into n from public.history_events where user_id = reader_a and dwell_ms = 424242;
  if n <> 0 then
    raise exception
      'reader B amended % of reader A''s history_events rows through the update policy', n;
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
  select count(*) into n from public.history_events;
  if n = 0 then
    raise exception
      'fixture: reader B owns no history_events rows here, so the handover probe would pass '
      'against an empty set and prove nothing';
  end if;
  code := null;
  begin
    update public.history_events set user_id = reader_a;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B handed their own history_events rows to reader A (got %). The UPDATE policy '
      'lost its owner leg from `with check`.', coalesce(code, 'no error');
  end if;

  delete from public.history_events;
  perform pg_temp.as_owner();
  select count(*) into n from public.history_events where user_id = reader_a;
  if n <> 1 then
    raise exception
      'reader B deleted reader A''s history_events rows through the delete policy '
      '(1 expected, % left)', n;
  end if;
  perform pg_temp.become(reader_b);

  -- The trigger function's own EXECUTE revoke, which nothing else asserts. It is NOT
  -- what makes section 7 work -- that probe never names this function, and it is
  -- refused identically with EXECUTE granted (measured) -- so this stands on its own:
  -- a trigger function reachable as an RPC endpoint is a door nobody meant to open.
  if has_function_privilege('authenticated', 'public.history_events_keep_readable()', 'execute') then
    raise exception
      'authenticated holds EXECUTE on history_events_keep_readable; the revoke in '
      '20260910010000 was undone';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Nobody may put a trigger beside the guard
  --
  -- `before update of <cols>` fires on the SET list and BEFORE triggers run in name
  -- order, so a trigger sorting after `history_events_keep_readable` could set the column the
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
    execute 'create trigger zz_beside_the_guard before update on public.history_events '
            'for each row execute function pg_temp.zz_beside_the_guard()';
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'a reader created a trigger on public.history_events (got %). TRIGGER is still '
      'granted, so the guard can be walked around by one that sorts after it.',
      coalesce(code, 'no error');
  end if;

  raise notice 'history_events.sql: a read needs a readable pull, summary and work on the '
    'way in, record_read still writes nothing for a pull the caller cannot read and still '
    'replays idempotently, an event cannot be moved onto anything unreadable by any of the '
    'three columns, and history stays amendable and deletable after what was read is withdrawn';
end $$;

rollback;
