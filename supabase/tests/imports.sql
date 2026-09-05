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
--   * Undo removes the pulls and everything that cascades from them, keeps the
--     dedupe record so a re-import stays a no-op, and is idempotent
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
  mid       uuid := extensions.gen_random_uuid();

  seed      bigint := 424242;
  feed      jsonb;
  due       jsonb;
  row_one   jsonb;

  n         int;
  refused   boolean;
  ks        public.knowledge_states;
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
     '{"provider":"anonymous","providers":["anonymous"]}'::jsonb, '{}'::jsonb);

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

  -- ------------------------------------------------------------ 10. Undo
  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id in (work_med, work_wal) and s.author_id = reader_a;
  if n <> 3 then raise exception 'reader A holds % pulls before Undo, expected 3', n; end if;

  res := public.undo_import(import_1);
  if (res ->> 'removed')::int <> 3 then
    raise exception 'Undo removed % pulls, expected 3', res ->> 'removed';
  end if;
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

  raise notice 'imports: kept, deduped, shared by work and by nothing else, '
    'invisible to everyone but their reader, never in the feed, refused to guests, '
    'and reversible exactly once';
end $$;

rollback;
