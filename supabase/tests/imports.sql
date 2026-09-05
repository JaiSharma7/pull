-- ---------------------------------------------------------------------------
-- Your highlights are yours to keep.
--
-- `Ingestion.tsx` parsed Kindle and Readwise exports and threw them away, because
-- a reader may not insert the works/summaries/pulls triple and must not be given
-- policies that would let them. 20260905110000 makes the batch a definer RPC and
-- the boundary the point of the file.
--
-- What is asserted, and each is a way the feature could betray a reader:
--
--   * a batch lands: three highlights, two books, private summaries, user_owned
--     works, and pulls a reader can actually read
--   * the same file again adds nothing and counts three duplicates, in one batch
--   * a second reader importing the same book shares the work row and nothing
--     else -- not the summary, not the pulls, not the items
--   * neither reader can see the other's work, pulls, imports, items or questions
--   * an imported pull never reaches the feed, which pools published AND public
--   * a guest is refused, on `auth.users` rather than the JWT claim
--   * 501 items in one call is refused
--   * `remember_pull` writes a question, schedules the idea and saves it; a replay
--     of the same mutation id writes nothing and returns the first id
--   * a question against a pull the reader cannot read is refused by the policy
--   * `get_due_reviews` prefers the reader's own question and says which it gave
--   * `grade_recall` files a grade against a reader's own question in
--     `user_question_id`, and a stranger's id never lands there
--   * every kept highlight is scheduled and saved, so it reaches Review and the
--     Library rather than sitting in a table nothing reads
--   * a grade cannot be filed against a question belonging to another pull, or to
--     another reader
--   * attributing an imported author does not publish the private work through
--     `work_contributors`, which was world-readable
--   * Undo removes the pulls and everything that cascades from them, keeps the
--     dedupe record so a re-import stays a no-op, and is idempotent -- and that
--     re-import creates no empty summary, so the book does not come back
--   * the 20,000 ceiling is charged per row stored, so a duplicate-only upload at
--     the ceiling is still accepted
--
-- Everything that can run as a real reader under RLS does. The whole file rolls back.
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

-- Two of the facts this file asserts are facts NO reader can observe -- that the work
-- row really is shared, and that the other reader's rows really do exist rather than
-- merely being absent. Those are checked from outside RLS, deliberately and narrowly,
-- and every other assertion runs as a real reader.
create or replace function pg_temp.as_owner() returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $fn$;

create or replace function pg_temp.become_guest(p_uid uuid) returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', true)::text,
    true);
  perform pg_temp.assert_is_reader();
end $fn$;

do $$
declare
  reader_a  uuid := extensions.gen_random_uuid();
  reader_b  uuid := extensions.gen_random_uuid();
  guest     uuid := extensions.gen_random_uuid();

  items_a   jsonb;
  bulk      jsonb;
  res       jsonb;
  res2      jsonb;

  import_1  uuid;
  import_2  uuid;

  work_med  uuid;
  work_wal  uuid;
  pull_a    uuid;
  pull_b    uuid;
  public_pull uuid;
  q_id      uuid;
  q_theirs  uuid;
  q_both    uuid;
  mid       uuid := extensions.gen_random_uuid();

  seed      bigint := 424242;
  feed      jsonb;
  due       jsonb;
  row_one   jsonb;

  n         int;
  refused   boolean;
  ks        public.knowledge_states;
  bulk_user uuid := extensions.gen_random_uuid();
  q_other   uuid;
begin
  if (select count(*) from public.pulls) > 500 then
    raise exception
      'refusing to run: found % pulls, which is not a seed corpus.',
      (select count(*) from public.pulls);
  end if;

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, is_anonymous,
                          raw_app_meta_data, raw_user_meta_data)
  values
    (reader_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'imp-a-' || left(reader_a::text, 8) || '@example.test', '', now(), now(), now(), false,
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
    (reader_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'imp-b-' || left(reader_b::text, 8) || '@example.test', '', now(), now(), now(), false,
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
    (guest, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     null, '', now(), now(), now(), true,
     '{"provider":"anonymous","providers":["anonymous"]}'::jsonb, '{}'::jsonb),
    (bulk_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'imp-bulk-' || left(bulk_user::text, 8) || '@example.test', '', now(), now(), now(), false,
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  items_a := jsonb_build_array(
    jsonb_build_object('title', 'Meditations', 'author', 'Marcus Aurelius',
      'text', 'You have power over your mind, not outside events.', 'locator', 'loc 431'),
    jsonb_build_object('title', 'Meditations', 'author', 'Marcus Aurelius',
      'text', 'Waste no more time arguing what a good person should be.', 'locator', 'loc 502'),
    jsonb_build_object('title', 'Walden', 'author', 'Henry David Thoreau',
      'text', 'I went to the woods because I wished to live deliberately.', 'locator', 'page 90')
  );

  -- ----------------------------------------------------------- 1. a batch lands
  perform pg_temp.become(reader_a);

  res := public.commit_import('kindle', repeat('a', 64), items_a);
  import_1 := (res ->> 'importId')::uuid;

  if (res ->> 'added')::int <> 3 then
    raise exception 'first import added % highlights, expected 3', res ->> 'added';
  end if;
  if (res ->> 'duplicates')::int <> 0 then
    raise exception 'first import found % duplicates, expected 0', res ->> 'duplicates';
  end if;
  if jsonb_array_length(res -> 'works') <> 2 then
    raise exception 'first import touched % works, expected 2',
      jsonb_array_length(res -> 'works');
  end if;

  select count(*) into n
    from public.import_items ii where ii.import_id = import_1;
  if n <> 3 then raise exception 'the batch holds % items, expected 3', n; end if;

  -- The reader can read what they kept, through ordinary policies.
  select p.id into pull_a
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
    join public.works w on w.id = s.work_id
   where w.slug like 'imported-walden%'
   limit 1;
  if pull_a is null then
    raise exception 'a reader cannot read the pull their own import created';
  end if;

  select w.id into work_med from public.works w where w.slug like 'imported-meditations%';
  select w.id into work_wal from public.works w where w.slug like 'imported-walden%';
  if work_med is null or work_wal is null then
    raise exception 'the import did not create both works';
  end if;

  select count(*) into n
    from public.works w
   where w.id in (work_med, work_wal) and w.rights_status <> 'user_owned';
  if n <> 0 then
    raise exception '% imported work(s) are not marked user_owned', n;
  end if;

  select count(*) into n
    from public.summaries s
   where s.work_id in (work_med, work_wal)
     and (s.author_id <> reader_a or s.visibility <> 'private' or s.status <> 'published');
  if n <> 0 then
    raise exception '% imported summary(ies) are not the author''s own private one', n;
  end if;

  -- Two highlights of one book, one of another, and the ordinals start at 1.
  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id = work_med;
  if n <> 2 then raise exception 'Meditations kept % pulls, expected 2', n; end if;

  -- Kept means kept: in Review and in the Library, not only in a table.
  select count(*) into n
    from public.knowledge_states k
    join public.pulls pl on pl.id = k.pull_id
    join public.summaries sm on sm.id = pl.summary_id
   where k.user_id = reader_a and sm.author_id = reader_a;
  if n <> 3 then
    raise exception 'only % of 3 kept highlights are scheduled for review', n;
  end if;

  select count(*) into n
    from public.saved_items si
    join public.pulls pl on pl.id = si.pull_id
    join public.summaries sm on sm.id = pl.summary_id
   where si.user_id = reader_a and sm.author_id = reader_a;
  if n <> 3 then
    raise exception 'only % of 3 kept highlights are in the library', n;
  end if;

  -- And due tomorrow rather than now, like anything else newly acquired.
  select count(*) into n
    from public.knowledge_states k
    join public.pulls pl on pl.id = k.pull_id
    join public.summaries sm on sm.id = pl.summary_id
   where k.user_id = reader_a and sm.author_id = reader_a
     and (k.acquired_via <> 'saved' or k.next_due_at <= now());
  if n <> 0 then
    raise exception '% kept highlights were scheduled wrongly', n;
  end if;

  -- ------------------------------------------------ 2. the same file adds nothing
  res2 := public.commit_import('kindle', repeat('a', 64), items_a);

  if (res2 ->> 'added')::int <> 0 then
    raise exception 're-importing the same file added % highlights, expected 0',
      res2 ->> 'added';
  end if;
  if (res2 ->> 'duplicates')::int <> 3 then
    raise exception 're-importing found % duplicates, expected 3', res2 ->> 'duplicates';
  end if;
  if (res2 ->> 'importId')::uuid <> import_1 then
    raise exception 'a chunk of the same file opened a second batch';
  end if;

  select count(*) into n from public.imports where user_id = reader_a;
  if n <> 1 then raise exception 'reader A has % batches, expected 1', n; end if;

  -- --------------------------------- 3. a second reader shares the work, nothing else
  perform pg_temp.become(reader_b);

  res := public.commit_import('readwise', repeat('b', 64), jsonb_build_array(
    jsonb_build_object('title', 'Meditations', 'author', 'Marcus Aurelius',
      'text', 'The impediment to action advances action.', 'locator', 'loc 12')
  ));
  import_2 := (res ->> 'importId')::uuid;

  if (res ->> 'added')::int <> 1 then
    raise exception 'reader B added % highlights, expected 1', res ->> 'added';
  end if;
  if ((res -> 'works' -> 0) ->> 'workId')::uuid <> work_med then
    raise exception 'reader B created a second work row for the same book';
  end if;

  -- B sees one summary and one pull on the shared work: their own. A's are not hidden
  -- by a filter in the RPC, they are hidden by the policies, which is the only kind of
  -- hiding that holds against a client that writes its own queries.
  select count(*) into n
    from public.summaries s where s.work_id = work_med;
  if n <> 1 then
    raise exception 'reader B can see % summaries of a shared work, expected only their own', n;
  end if;

  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id = work_med;
  if n <> 1 then
    raise exception 'reader B can see % pulls of a shared work, expected only their own', n;
  end if;

  -- And the sharing is real rather than an absence: from outside RLS the one work row
  -- carries a summary for each reader and all three of their highlights.
  perform pg_temp.as_owner();
  select count(*) into n from public.summaries s where s.work_id = work_med;
  if n <> 2 then
    raise exception 'Meditations carries % summaries, expected one per reader', n;
  end if;
  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id = work_med;
  if n <> 3 then
    raise exception 'the shared work carries % pulls, expected 2 from A and 1 from B', n;
  end if;
  select count(*) into n from public.works w where w.slug like 'imported-meditations%';
  if n <> 1 then
    raise exception 'two readers importing one book made % work rows', n;
  end if;
  perform pg_temp.become(reader_b);

  select count(*) into n from public.works w where w.id = work_wal;
  if n <> 0 then
    raise exception 'reader B can see a book only reader A imported';
  end if;

  select count(*) into n from public.imports where id = import_1;
  if n <> 0 then raise exception 'reader B can read reader A''s import batch'; end if;

  select count(*) into n from public.import_items where import_id = import_1;
  if n <> 0 then raise exception 'reader B can read reader A''s import items'; end if;

  select p.id into pull_b
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id = work_med
   limit 1;

  -- ------------------------------------------- 4. no imported pull reaches the feed
  feed := public.get_feed(p_limit := 50, p_seed := seed, p_page := 0);
  if feed::text like '%impediment to action%' then
    raise exception 'an imported private pull reached the feed';
  end if;
  if feed::text like '%live deliberately%' then
    raise exception 'another reader''s imported pull reached the feed';
  end if;

  -- ------------------------------------------------------- 5. a guest is refused
  perform pg_temp.become_guest(guest);
  refused := false;
  begin
    perform public.commit_import('paste', null, jsonb_build_array(
      jsonb_build_object('title', 'Anything', 'text', 'A guest should not get this far.')
    ));
  exception when invalid_authorization_specification then
    refused := true;
  end;
  if not refused then
    raise exception 'a guest kept highlights; commit_import must refuse with 28000';
  end if;

  -- --------------------------------------------------- 6. 501 items in one call
  perform pg_temp.become(reader_a);
  select jsonb_agg(jsonb_build_object('title', 'Bulk', 'text', 'Highlight number ' || g))
    into bulk
    from generate_series(1, 501) g;

  refused := false;
  begin
    perform public.commit_import('csv', null, bulk);
  exception when invalid_parameter_value then
    refused := true;
  end;
  if not refused then
    raise exception '501 items in one call was accepted; the limit is 500';
  end if;

  -- ------------------------------------------------------- 7. remember_pull
  res := public.remember_pull(pull_a, 'Why did he go to the woods?',
                              'To live deliberately.', 'recall', mid);
  q_id := (res ->> 'questionId')::uuid;

  if q_id is null or (res ->> 'created')::boolean is not true then
    raise exception 'remember_pull did not write a question';
  end if;

  select count(*) into n
    from public.knowledge_states where user_id = reader_a and pull_id = pull_a;
  if n <> 1 then raise exception 'remember_pull did not schedule the idea'; end if;

  select count(*) into n
    from public.saved_items where user_id = reader_a and pull_id = pull_a;
  if n <> 1 then raise exception 'remember_pull did not save the idea'; end if;

  -- A replay writes nothing and hands back the first id.
  res := public.remember_pull(pull_a, 'A different prompt entirely',
                              'and a different answer', 'recall', mid);
  if (res ->> 'created')::boolean is not false then
    raise exception 'a replayed remember_pull reported itself as new';
  end if;
  if (res ->> 'questionId')::uuid <> q_id then
    raise exception 'a replayed remember_pull returned a different question';
  end if;

  select count(*) into n
    from public.user_questions where user_id = reader_a and pull_id = pull_a;
  if n <> 1 then
    raise exception 'a replayed remember_pull wrote a second question (% rows)', n;
  end if;

  -- A question against a pull this reader cannot read is refused by the policy.
  refused := false;
  begin
    insert into public.user_questions (user_id, pull_id, prompt)
    values (reader_a, pull_b, 'What is in the book I cannot see?');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader wrote a question against a pull they cannot read';
  end if;

  -- ------------------------------------- 8. get_due_reviews prefers the reader's own
  update public.knowledge_states
     set next_due_at = now() - interval '1 hour'
   where user_id = reader_a and pull_id = pull_a;

  due := public.get_due_reviews(p_limit := 50);
  if jsonb_typeof(due) <> 'array' then
    raise exception 'get_due_reviews stopped returning an array';
  end if;

  select value into row_one
    from jsonb_array_elements(due)
   where (value ->> 'pullId')::uuid = pull_a;

  if row_one is null then
    raise exception 'the remembered idea is not due';
  end if;
  if row_one ->> 'questionSource' <> 'user' then
    raise exception 'get_due_reviews gave the % question, expected the reader''s own',
      coalesce(row_one ->> 'questionSource', 'none');
  end if;
  if (row_one ->> 'questionId')::uuid <> q_id then
    raise exception 'get_due_reviews returned a question id that is not the reader''s';
  end if;
  if row_one ->> 'question' <> 'Why did he go to the woods?' then
    raise exception 'get_due_reviews returned the wrong prompt: %', row_one ->> 'question';
  end if;

  -- A retired question falls back to whatever the canonical layer offers.
  update public.user_questions set retired_at = now() where id = q_id;
  due := public.get_due_reviews(p_limit := 50);
  select value into row_one
    from jsonb_array_elements(due)
   where (value ->> 'pullId')::uuid = pull_a;
  if row_one ->> 'questionSource' = 'user' then
    raise exception 'a retired question was still offered';
  end if;
  update public.user_questions set retired_at = null where id = q_id;

  -- ------------------------------- 9. a grade against your own question is filed there
  ks := public.grade_recall(
    p_pull_id      := pull_a,
    p_grade        := 'good',
    p_mutation_id  := extensions.gen_random_uuid(),
    p_submitted_at := now(),
    p_question_id  := q_id,
    p_kind         := 'review'
  );

  select count(*) into n
    from public.recall_events e
   where e.user_id = reader_a and e.user_question_id = q_id and e.quiz_question_id is null;
  if n <> 1 then
    raise exception 'a grade against the reader''s own question filed % rows in user_question_id', n;
  end if;

  -- A question belonging to another pull cannot be filed against this one. The plain
  -- reference this replaced checked only that the question existed, and the log has no
  -- update or delete policy, so a mis-filed answer would have stayed mis-filed.
  insert into public.user_questions (user_id, pull_id, prompt)
  values (reader_a, (select p2.id from public.pulls p2
                      join public.summaries s2 on s2.id = p2.summary_id
                     where s2.author_id = reader_a and p2.id <> pull_a limit 1),
          'A question about a different idea')
  returning id into strict q_other;

  refused := false;
  begin
    insert into public.recall_events (user_id, pull_id, user_question_id, kind, grade)
    values (reader_a, pull_a, q_other, 'review', 'good');
  exception when foreign_key_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'a grade was filed against a question belonging to another pull';
  end if;

  -- One question or the other, never both. `grade_recall` writes only one, but the
  -- insert policy admits a direct write on the strength of `user_id` alone, and the
  -- log has no update or delete policy — so such a row would be permanent and would
  -- mean two things at once.
  -- Needs a pull carrying BOTH, so a seeded public one the reader also wrote about:
  -- an imported pull has no canonical question, and the composite keys refuse a
  -- question from anywhere else.
  select p2.id into strict public_pull
    from public.pulls p2
   where exists (select 1 from public.quiz_questions q where q.pull_id = p2.id)
   limit 1;
  perform public.remember_pull(public_pull, 'My own question about this one',
                               'My own answer', 'recall', extensions.gen_random_uuid());
  select uq.id into strict q_both
    from public.user_questions uq
   where uq.user_id = reader_a and uq.pull_id = public_pull;

  refused := false;
  begin
    insert into public.recall_events
      (user_id, pull_id, quiz_question_id, user_question_id, kind, grade)
    values (reader_a, public_pull,
            (select q.id from public.quiz_questions q where q.pull_id = public_pull limit 1),
            q_both, 'review', 'good');
  exception when check_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'a grade named a canonical question and the reader''s own at once';
  end if;

  -- A question cannot be MOVED onto a pull the reader cannot read either. Guarding only
  -- the insert leaves the guard one statement from useless.
  refused := false;
  begin
    update public.user_questions set pull_id = pull_b where id = q_id;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader moved their question onto a pull they cannot read';
  end if;

  -- --------------------- 9a. the reader's own question wins WHERE THERE IS A CONTEST
  --
  -- Section 8 asserts this on an imported pull, which by construction has no canonical
  -- question -- so `canon.id` is null there and reversing the preference is invisible.
  -- A review mutant that swapped the coalesce left this whole file green. The only pull
  -- carrying both is the seeded one, so the contest has to be staged here.
  update public.knowledge_states
     set next_due_at = now() - interval '1 hour'
   where user_id = reader_a and pull_id = public_pull;
  if not found then
    insert into public.knowledge_states (user_id, pull_id, acquired_via, next_due_at)
    values (reader_a, public_pull, 'saved', now() - interval '1 hour');
  end if;

  due := public.get_due_reviews(p_limit := 50);
  select value into row_one
    from jsonb_array_elements(due)
   where (value ->> 'pullId')::uuid = public_pull;
  if row_one is null then
    raise exception 'the pull carrying both questions is not due';
  end if;
  if row_one ->> 'questionSource' <> 'user' then
    raise exception 'with both available get_due_reviews chose the % question',
      coalesce(row_one ->> 'questionSource', 'none');
  end if;
  if (row_one ->> 'questionId')::uuid <> q_both then
    raise exception 'questionSource said user but the id returned was not the reader''s';
  end if;
  if row_one ->> 'question' <> 'My own question about this one' then
    raise exception 'questionSource said user but the prompt returned was not theirs: %',
      row_one ->> 'question';
  end if;

  -- --------------------- 9c. a stranger's question, on a pull you BOTH hold
  --
  -- The composite key is three columns -- `(user_question_id, user_id, pull_id)` -- and
  -- nothing tested the middle one: a mutant that dropped `user_id` from it left this
  -- file green. Two columns are enough to stop a question from ANOTHER PULL and not
  -- enough to stop another READER's question on the same pull, which is reachable
  -- precisely because a seeded public pull is one two readers can both hold.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_b, 'role', 'authenticated')::text, true);
  perform public.remember_pull(public_pull, 'Reader B''s own question', 'B''s answer',
                               'recall', extensions.gen_random_uuid());
  select uq.id into strict q_theirs
    from public.user_questions uq
   where uq.user_id = reader_b and uq.pull_id = public_pull;

  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_a, 'role', 'authenticated')::text, true);
  refused := false;
  begin
    insert into public.recall_events (user_id, pull_id, user_question_id, kind, grade)
    values (reader_a, public_pull, q_theirs, 'review', 'good');
  exception when foreign_key_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader filed a grade against another reader''s question';
  end if;

  -- ----------------------------------- 9b. attribution does not publish the work
  --
  -- `attribute_work` writes `contributors` and `work_contributors`, both of which were
  -- `using (true)` and selectable by `anon` -- so one GET handed a visitor the UUID of
  -- every private imported work and the author it is by, while the `works` policy was
  -- busy hiding the title.
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

  select count(*) into n
    from public.work_contributors wc where wc.work_id in (work_med, work_wal);
  if n <> 0 then
    raise exception 'a visitor can see % contributor link(s) for a private work', n;
  end if;

  select count(*) into n
    from public.contributors c
   where lower(c.slug::text) in ('marcus-aurelius', 'henry-david-thoreau')
     and not exists (
       select 1 from public.work_contributors wc2
        join public.works w2 on w2.id = wc2.work_id
       where wc2.contributor_id = c.id
     );
  if n <> 0 then
    raise exception 'a contributor is visible with no readable work behind them';
  end if;

  -- The catalogue keeps its own. `on-liberty` is seeded and public, so its contributors
  -- must still be listed -- a policy that hid those would be a regression, not a fix.
  select count(*) into n
    from public.work_contributors wc
    join public.works w on w.id = wc.work_id
   where w.slug = 'on-liberty';
  if n = 0 then
    raise exception 'a visitor lost the contributors of a public seeded work';
  end if;

  perform pg_temp.become(reader_a);

  -- ------------------------------------------------------------ 10. Undo
  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id in (work_med, work_wal) and s.author_id = reader_a;
  if n <> 3 then raise exception 'reader A holds % pulls before Undo, expected 3', n; end if;

  -- A private draft about a DIFFERENT book, started by hand and not yet written into.
  -- Undoing an unrelated batch must not take it: the cleanup used to match every empty
  -- private summary the reader authored on any user_owned work.
  -- On the very book being undone, and a second summary of it, which is allowed:
  -- `summaries` is unique per (work, version, author). Scoping the cleanup by WORK
  -- would still have taken this; only the summary a deleted pull hung from is the
  -- batch's to clean up.
  insert into public.summaries (work_id, version, author_id, title, status, visibility)
  values (work_med, 2, reader_a, 'My own notes on Meditations', 'draft', 'private');
  select count(*) into n
    from public.summaries s
   where s.author_id = reader_a and s.title = 'My own notes on Meditations';
  if n <> 1 then raise exception 'the fixture draft was not created'; end if;

  res := public.undo_import(import_1);
  if (res ->> 'removed')::int <> 3 then
    raise exception 'Undo removed % pulls, expected 3', res ->> 'removed';
  end if;

  select count(*) into n
    from public.summaries s
   where s.author_id = reader_a and s.title = 'My own notes on Meditations';
  if n <> 1 then
    raise exception 'Undo deleted an unrelated draft the reader was writing';
  end if;
  delete from public.summaries s
   where s.author_id = reader_a and s.title = 'My own notes on Meditations';
  if (res ->> 'alreadyUndone')::boolean is not false then
    raise exception 'a first Undo reported itself as a repeat';
  end if;

  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.author_id = reader_a;
  if n <> 0 then raise exception 'Undo left % of reader A''s pulls', n; end if;

  select count(*) into n
    from public.knowledge_states where user_id = reader_a and pull_id = pull_a;
  if n <> 0 then raise exception 'Undo left the idea scheduled for review'; end if;

  select count(*) into n
    from public.saved_items where user_id = reader_a and pull_id = pull_a;
  if n <> 0 then raise exception 'Undo left the idea in the library'; end if;

  -- The dedupe record survives, so a re-import of the same file stays a no-op rather
  -- than handing back everything the reader just removed.
  select count(*) into n from public.import_items where import_id = import_1;
  if n <> 3 then
    raise exception 'Undo erased the dedupe record (% items left of 3)', n;
  end if;

  -- Undo is REVERSIBLE, and uploading the same file again is how you reverse it. The
  -- items survive as tombstones so an accidental re-upload of something still held is a
  -- no-op (asserted in section 2), and stop blocking once the reader has explicitly said
  -- they do not want them -- so this restores exactly what was taken.
  res := public.commit_import('kindle', repeat('c', 64), items_a);
  if (res ->> 'added')::int <> 3 or (res ->> 'duplicates')::int <> 0 then
    raise exception 'a re-import after Undo restored % and deduped %',
      res ->> 'added', res ->> 'duplicates';
  end if;

  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.author_id = reader_a;
  if n <> 3 then raise exception 'Undo could not be undone (% pulls back of 3)', n; end if;

  select count(*) into n from public.works w where w.id in (work_med, work_wal);
  if n <> 2 then raise exception 'the restored books did not come back into view'; end if;

  -- And the tombstones were revived rather than duplicated: the unique key is
  -- (user_id, content_hash), so a second row would have raised rather than counted.
  select count(*) into n from public.import_items where user_id = reader_a;
  if n <> 3 then raise exception 'restoring left % item rows, expected 3', n; end if;

  select count(*) into n
    from public.import_items where user_id = reader_a and undone_at is not null;
  if n <> 0 then raise exception '% restored items are still marked undone', n; end if;

  -- Take it back again, so the assertions after this see an empty library.
  res := public.undo_import((res ->> 'importId')::uuid);
  if (res ->> 'removed')::int <> 3 then
    raise exception 'the second Undo removed %, expected 3', res ->> 'removed';
  end if;

  select count(*) into n from public.summaries s where s.author_id = reader_a;
  if n <> 0 then
    raise exception 'Undo left % summary(ies) with nothing in them', n;
  end if;

  -- Idempotent.
  res := public.undo_import(import_1);
  if (res ->> 'alreadyUndone')::boolean is not true then
    raise exception 'a second Undo did not report itself as a repeat';
  end if;
  if (res ->> 'removed')::int <> 0 then
    raise exception 'a second Undo removed % more rows', res ->> 'removed';
  end if;

  -- Reader B is untouched by any of it.
  perform pg_temp.become(reader_b);
  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.author_id = reader_b;
  if n <> 1 then
    raise exception 'reader B holds % pulls after reader A''s Undo, expected 1', n;
  end if;

  -- And Undo is scoped: B cannot unwind A's batch.
  refused := false;
  begin
    perform public.undo_import(import_1);
  exception when undefined_object then
    refused := true;
  end;
  if not refused then
    raise exception 'reader B unwound reader A''s import';
  end if;

  -- ------------------------------------------ 11. the ceiling counts what is stored
  --
  -- Charged per row inserted rather than against the incoming chunk. Counted the old
  -- way, a reader at 19,800 highlights could not re-upload a 500-item file of which 498
  -- were already held -- an operation that would have added two rows -- and a reader at
  -- the ceiling exactly could not re-upload anything at all, even a file that would add
  -- nothing.
  perform pg_temp.become(bulk_user);
  res := public.commit_import('kindle', repeat('d', 64), jsonb_build_array(
    jsonb_build_object('title', 'A Full Shelf', 'author', 'Nobody',
      'text', 'The one real highlight this reader has.')
  ));
  import_2 := (res ->> 'importId')::uuid;

  perform pg_temp.as_owner();
  insert into public.import_items (import_id, user_id, content_hash)
  select import_2, bulk_user, md5(g::text) || md5((g + 1)::text)
    from generate_series(1, 19999) g;
  perform pg_temp.become(bulk_user);

  select count(*) into n from public.import_items where user_id = bulk_user;
  if n <> 20000 then
    raise exception 'the bulk fixture holds % items, expected 20000', n;
  end if;

  -- At the ceiling exactly, a file that adds nothing is still accepted.
  res := public.commit_import('kindle', repeat('d', 64), jsonb_build_array(
    jsonb_build_object('title', 'A Full Shelf', 'author', 'Nobody',
      'text', 'The one real highlight this reader has.')
  ));
  if (res ->> 'added')::int <> 0 or (res ->> 'duplicates')::int <> 1 then
    raise exception 'a duplicate-only upload at the ceiling reported added=% duplicates=%',
      res ->> 'added', res ->> 'duplicates';
  end if;

  -- One genuinely new highlight is not stored, and the call says so rather than
  -- raising: a raise would abort the transaction and roll back everything already
  -- added in the same chunk, so a reader with room for two of five hundred stored
  -- none of them.
  res := public.commit_import('kindle', repeat('d', 64), jsonb_build_array(
    jsonb_build_object('title', 'A Full Shelf', 'author', 'Nobody',
      'text', 'One more than this reader may hold.')
  ));
  if (res ->> 'added')::int <> 0 or (res ->> 'ceilingReached')::boolean is not true then
    raise exception 'a reader stored % past the ceiling (ceilingReached=%)',
      res ->> 'added', res ->> 'ceilingReached';
  end if;

  -- And a chunk that CROSSES the ceiling keeps what fits. The reader is at 20,000 with
  -- one item undone below, so exactly one slot is free.
  perform pg_temp.as_owner();
  update public.import_items set undone_at = now()
   where user_id = bulk_user and content_hash = (
     select ii.content_hash from public.import_items ii
      where ii.user_id = bulk_user order by ii.content_hash limit 1
   );
  perform pg_temp.become(bulk_user);

  res := public.commit_import('kindle', repeat('d', 64), jsonb_build_array(
    jsonb_build_object('title', 'A Full Shelf', 'author', 'Nobody', 'text', 'The one that fits.'),
    jsonb_build_object('title', 'A Full Shelf', 'author', 'Nobody', 'text', 'The one that does not.')
  ));
  if (res ->> 'added')::int <> 1 or (res ->> 'ceilingReached')::boolean is not true then
    raise exception 'a crossing chunk stored % of the 1 that fitted (ceilingReached=%)',
      res ->> 'added', res ->> 'ceilingReached';
  end if;

  raise notice 'imports: kept, deduped, shared by work and by nothing else, '
    'invisible to everyone but their reader (contributors included), never in the feed, '
    'refused to guests, scheduled and saved so Review and the Library see them, graded '
    'only against their own questions, bounded by what is stored rather than what is '
    'offered, and reversible exactly once with no empty book left behind';
end $$;

rollback;
