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
--   * a second reader importing the same book gets their OWN work row -- and reads
--     back their own title casing and their own timestamp, never the first
--     importer's, because a shared row was an oracle over a private library
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
--     `work_contributors`, which was world-readable -- nor through the WRITE path,
--     where reusing a stranger's contributor row would confirm the same fact
--   * Undo removes the pulls and everything that cascades from them, keeps the
--     dedupe record so a re-import stays a no-op, and is idempotent -- and that
--     re-import creates no empty summary, so the book does not come back
--   * the 20,000 ceiling is charged per row stored, so a duplicate-only upload at
--     the ceiling is still accepted -- and a reader with no room left creates no
--     `works` or `contributors` rows at all. Every work is created in the step that
--     stores the highlight needing it, so the book counter and the rows agree
--     exactly; there is no window that can forecast more than the loop then uses
--   * a book refused by the book ceiling does not end the chunk: later highlights
--     of books the reader already owns still land
--   * an Undo gives the highlights back and not the book ceiling -- nothing shared is
--     ever deleted, because deleting it races every other reader's import, so creation
--     is bounded instead by the books this reader has ever imported into
--   * every book by one author in a chunk keeps its byline, not just the first
--   * a chunk joins the batch the client NAMES, and only one the reader still holds
--   * closing the account takes an import with it however the summary has been moved
--
-- THE LOCK ORDERING THIS FILE USED TO CAVEAT IS GONE, and so is the deadlock it avoided.
-- `commit_import` used to create every work and contributor a chunk might need ahead of
-- the loop, in slug order, because find-or-create inside the loop deadlocked two readers
-- with crossing files 12 times in 12. Two readers can no longer name the same `works` or
-- `contributors` row at all -- the slug carries the owner -- and a reader against
-- themselves is serialised by the advisory lock, so there is no shared resource left to
-- order. Still not assertable from one psql session; it is now unreachable rather than
-- ordered, which is the stronger of the two.
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
  work_med_b uuid;
  slug_oq_a text;
  slug_oq_b text;
  slug_pd_b text;
  bulk_pull uuid;
  closer_two uuid := extensions.gen_random_uuid();
  closer_two_sess uuid := extensions.gen_random_uuid();
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
  n_before  int;
  c_before  int;
  closer    uuid := extensions.gen_random_uuid();
  closer_sess uuid := extensions.gen_random_uuid();
  capped    uuid := extensions.gen_random_uuid();
  capped_undone uuid := extensions.gen_random_uuid();
  reviver   uuid := extensions.gen_random_uuid();
  sharer    uuid := extensions.gen_random_uuid();
  shared_work uuid;
  seeded_work uuid;
  batch_one uuid;
  work_oracle uuid;
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

  -- ------------------------- 3. a second reader gets their own work, and no oracle
  --
  -- The work row used to be SHARED, keyed on a slug hashed from title and author alone,
  -- and the claim was that two readers still "see each other's nothing" because a work
  -- is visible only behind a readable summary. That held for the pulls and not for the
  -- row: B's own private summary makes the shared work readable to B, so B read back
  -- A's exact capitalisation of the title and the moment A imported it. B sends the
  -- title in lower case here for exactly that reason -- if the row were shared, the
  -- reply would come back in A's casing, which is the whole oracle in one assertion.
  perform pg_temp.become(reader_b);

  res := public.commit_import('readwise', repeat('b', 64), jsonb_build_array(
    jsonb_build_object('title', 'meditations', 'author', 'marcus aurelius',
      'text', 'The impediment to action advances action.', 'locator', 'loc 12')
  ));
  import_2 := (res ->> 'importId')::uuid;

  if (res ->> 'added')::int <> 1 then
    raise exception 'reader B added % highlights, expected 1', res ->> 'added';
  end if;
  work_med_b := ((res -> 'works' -> 0) ->> 'workId')::uuid;
  if work_med_b = work_med then
    raise exception 'reader B landed on reader A''s work row for the same book';
  end if;
  if ((res -> 'works' -> 0) ->> 'title') <> 'meditations' then
    raise exception
      'reader B was handed the title % -- another reader''s casing is an oracle',
      (res -> 'works' -> 0) ->> 'title';
  end if;

  -- B sees one summary and one pull, on their own work. A's are not hidden by a filter
  -- in the RPC, they are hidden by the policies, which is the only kind of hiding that
  -- holds against a client that writes its own queries.
  select count(*) into n
    from public.summaries s where s.work_id = work_med_b;
  if n <> 1 then
    raise exception 'reader B can see % summaries of their own work, expected 1', n;
  end if;

  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id = work_med_b;
  if n <> 1 then
    raise exception 'reader B can see % pulls of their own work, expected 1', n;
  end if;

  -- AND A'S ROW IS NOT MERELY EMPTY TO B, IT IS ABSENT. An empty row still answers
  -- "somebody imported this book"; that was the oracle.
  select count(*) into n from public.works w where w.id = work_med;
  if n <> 0 then
    raise exception 'reader B can see the work row reader A''s import created';
  end if;

  -- From outside RLS: two rows, one per reader, each carrying only its own reader's
  -- highlights, and A's still spelled the way A typed it.
  perform pg_temp.as_owner();
  select count(*) into n from public.works w where w.slug like 'imported-meditations%';
  if n <> 2 then
    raise exception 'two readers importing one book made % work rows, expected 2', n;
  end if;
  select count(*) into n from public.works w
   where w.id = work_med and w.title = 'Meditations';
  if n <> 1 then
    raise exception 'reader A''s title was rewritten by reader B''s import';
  end if;
  select count(*) into n from public.summaries s where s.work_id = work_med;
  if n <> 1 then
    raise exception 'reader A''s Meditations carries % summaries, expected 1', n;
  end if;
  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id = work_med;
  if n <> 2 then
    raise exception 'reader A''s work carries % pulls, expected 2', n;
  end if;
  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id = work_med_b;
  if n <> 1 then
    raise exception 'reader B''s work carries % pulls, expected 1', n;
  end if;
  -- The byline is on B's own contributor row, not the one A's import created. Round 7
  -- measured the guard this replaces refusing B a byline entirely, 14 times in 14.
  select count(*) into n
    from public.work_contributors wc
    join public.contributors c on c.id = wc.contributor_id
   where wc.work_id = work_med_b;
  if n <> 1 then
    raise exception 'reader B''s book carries % bylines, expected 1', n;
  end if;
  select count(*) into n
    from public.work_contributors wa
    join public.work_contributors wb on wb.contributor_id = wa.contributor_id
   where wa.work_id = work_med and wb.work_id = work_med_b;
  if n <> 0 then
    raise exception 'both readers landed on one contributor row';
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
   where s.work_id = work_med_b
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

  -- BY SLUG, not by the id captured before the Undo, and the difference is the point.
  -- An Undo now deletes the works its batch created when nothing else uses them --
  -- no summary at all, no item from another batch -- because otherwise the ceiling
  -- that bounds shared-row creation and the Undo that frees room under it cancel into
  -- unbounded growth (measured: five import-and-undo cycles added 500 permanent
  -- `works` rows with `held` back at 0 every time). The slug is deterministic, so a
  -- re-import lands on the same book; the row behind it is new, and nothing a reader
  -- can see or hold ever referred to the old one -- its pulls went with the Undo.
  select count(*) into n
    from public.works w
   where w.slug like 'imported-meditations%' or w.slug like 'imported-walden%';
  if n <> 2 then raise exception 'the restored books did not come back into view'; end if;
  select w.id into work_med from public.works w where w.slug like 'imported-meditations%';
  select w.id into work_wal from public.works w where w.slug like 'imported-walden%';

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

  -- ------------------------- 9d. and the WRITE path is not an oracle either
  --
  -- 9b closes the read path: a contributor with no readable work behind them is not
  -- listable. The write path leaked the same fact and no policy can see it.
  -- `attribute_work` deduplicates on the author slug and REUSES the row, so a reader
  -- importing a one-line paste naming an obscure author landed on the row a STRANGER's
  -- private import had created -- and `work_contributors` then attached it to a work of
  -- their own, which they can read. That hands them both the fact that somebody on this
  -- instance imported that author and the exact string that reader typed.
  --
  -- Rounds 4 and 5 guarded the reuse. Round 7 measured what a guard leaves: the byline's
  -- ABSENCE answers the same question, and the second reader of any author outside the
  -- public catalogue got no byline at all -- the readability leg needed a
  -- `work_contributors` row the guard was itself refusing to create. So the rows are
  -- namespaced per reader instead, and this section asserts BOTH halves: the stranger
  -- is invisible, and the byline is still there. A guard that cost every reader their
  -- byline would satisfy the first half alone, which is why the second half is here.
  --
  -- The author below appears in no seed, and that is the point. 9b asks this of
  -- `marcus-aurelius`, who is seeded on the PUBLIC `meditations` work, so a mutant
  -- restoring `contributors_read_all using (true)` survived the whole file: the
  -- assertion was true of the catalogue whatever the policy said.
  -- Both expected slugs, derived once as owner. `imported_contributor_slug` is revoked
  -- from `authenticated`, correctly -- it is an internal derivation, not something a
  -- reader may ask for -- so the assertions below compare against captured text.
  perform pg_temp.as_owner();
  select public.imported_contributor_slug('Ottoline Quennevil', reader_a) into slug_oq_a;
  select public.imported_contributor_slug('Ottoline Quennevil', reader_b) into slug_oq_b;

  perform pg_temp.become(reader_a);
  res := public.commit_import('paste', null, jsonb_build_array(
    jsonb_build_object('title', 'A Private Notebook', 'author', 'Ottoline Quennevil',
      'text', 'Only one reader on this instance has ever typed that author.')
  ));
  if (res ->> 'added')::int <> 1 then
    raise exception 'the oracle fixture stored % highlights, expected 1', res ->> 'added';
  end if;

  -- The reader who created the row is still attributed. A guard that cost every reader
  -- their byline would pass every assertion below and be a worse feature.
  select count(*) into n
    from public.work_contributors wc
    join public.contributors c on c.id = wc.contributor_id
   where c.slug operator(extensions.=)
         slug_oq_a::extensions.citext;
  if n <> 1 then
    raise exception 'a reader''s own imported author was attributed % times, expected 1', n;
  end if;

  -- And a SECOND book by that author, imported by the same reader, still attributes:
  -- the row is now readable to them through the first one.
  res := public.commit_import('paste', null, jsonb_build_array(
    jsonb_build_object('title', 'A Second Private Notebook', 'author', 'Ottoline Quennevil',
      'text', 'The same reader, the same author, a second book.')
  ));
  select count(*) into n
    from public.work_contributors wc
    join public.contributors c on c.id = wc.contributor_id
   where c.slug operator(extensions.=)
         slug_oq_a::extensions.citext;
  if n <> 2 then
    raise exception 'a reader lost the byline on their own second book (% links)', n;
  end if;

  -- A DIFFERENT reader, a different book, the same author.
  perform pg_temp.become(reader_b);
  res := public.commit_import('paste', null, jsonb_build_array(
    jsonb_build_object('title', 'Another Notebook Entirely', 'author', 'Ottoline Quennevil',
      'text', 'A different book, the same author, a different reader.')
  ));
  if (res ->> 'added')::int <> 1 then
    raise exception 'the second reader''s import stored % highlights, expected 1',
      res ->> 'added';
  end if;

  select w.id into work_oracle
    from public.works w where w.slug like 'imported-another-notebook-entirely%';
  if work_oracle is null then
    raise exception 'the second reader''s import did not create its work';
  end if;

  -- B GETS THE BYLINE. This is the half a guard could not deliver: measured at 0 links
  -- in 14 of 14 runs, because the row B was refused was the only one that existed.
  select count(*) into n
    from public.work_contributors wc where wc.work_id = work_oracle;
  if n <> 1 then
    raise exception 'the second reader of an author got % bylines, expected 1', n;
  end if;

  -- ON THEIR OWN ROW, and A's is not reachable from it.
  select count(*) into n
    from public.work_contributors wc
    join public.contributors c on c.id = wc.contributor_id
   where wc.work_id = work_oracle
     and c.slug operator(extensions.=)
         slug_oq_b::extensions.citext;
  if n <> 1 then
    raise exception 'the second reader''s byline is not on their own contributor row';
  end if;

  select count(*) into n
    from public.contributors c
   where c.slug operator(extensions.=)
         slug_oq_a::extensions.citext;
  if n <> 0 then
    raise exception 'a reader can list a contributor only a stranger''s private import made';
  end if;

  -- Two rows, one per reader, each carrying that reader's own spelling. From outside RLS
  -- so the count is of what exists rather than of what one reader can see.
  perform pg_temp.as_owner();
  select count(*) into n
    from public.contributors c
   where c.slug operator(extensions.=) any (array[slug_oq_a, slug_oq_b]::extensions.citext[]);
  if n <> 2 then
    raise exception 'the instance holds % contributor rows for one author, expected 2', n;
  end if;
  -- And the undecorated slug belongs to nobody, so nothing landed on a shared row by a
  -- path this file has not thought of.
  select count(*) into n
    from public.contributors c
   where c.slug operator(extensions.=) 'ottoline-quennevil'::extensions.citext;
  if n <> 0 then
    raise exception 'an import created a shared contributor row after all';
  end if;
  perform pg_temp.become(reader_a);

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

  -- WITH A PULL EACH, because "held" now means `undone_at is null AND pull_id is not
  -- null` and a row with no pull is a highlight the reader does not have. The filler
  -- used to leave `pull_id` null, which built 19,999 rows in a state `commit_import`
  -- cannot produce and which the ceiling correctly no longer counts. They all point at
  -- the one real pull this fixture made: `import_items.pull_id` carries no unique
  -- constraint, and what is under test is the COUNT.
  perform pg_temp.as_owner();
  select ii.pull_id into bulk_pull
    from public.import_items ii
   where ii.user_id = bulk_user and ii.pull_id is not null
   limit 1;
  if bulk_pull is null then
    raise exception 'the bulk fixture has no pull to point its filler at';
  end if;
  insert into public.import_items (import_id, user_id, pull_id, content_hash)
  select import_2, bulk_user, bulk_pull, md5(g::text) || md5((g + 1)::text)
    from generate_series(1, 19999) g;
  perform pg_temp.become(bulk_user);

  select count(*) into n
    from public.import_items
   where user_id = bulk_user and undone_at is null and pull_id is not null;
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

  -- AND NOTHING SHARED IS CREATED FOR IT EITHER.
  --
  -- The find-or-create was hoisted out of the item loop to fix a deadlock, which put it
  -- above the dedupe and the ceiling as well: a reader with no room left still ran the
  -- pre-pass and committed its `works` and `contributors`. Measured on the unfixed
  -- function -- this reader called it twice with 500 fresh titles and added 1,000 orphan
  -- works and about as many contributors, `added: 0` both times, repeatable forever.
  -- Those are SHARED CATALOGUE tables: no per-reader ceiling covers them, no sweep
  -- collects them, and this feature is itself what makes `works` grow, so it fed the
  -- sequential scan the slug index exists to prevent.
  --
  -- Counted from outside RLS because the point is that the rows do not EXIST, which no
  -- reader can observe -- 20260905101000 hides an orphan work from everyone, so a
  -- reader's own query cannot tell an unbounded leak from a clean refusal.
  perform pg_temp.as_owner();
  select count(*) into n_before from public.works;
  perform pg_temp.become(bulk_user);

  res := public.commit_import('kindle', repeat('d', 64), (
    select jsonb_agg(jsonb_build_object(
             'title', 'Orphan Volume ' || g,
             'author', 'Orphan Author ' || g,
             'text', 'A fresh highlight, number ' || g || ', that will not be stored.'))
      from generate_series(1, 50) g
  ));
  if (res ->> 'added')::int <> 0 or (res ->> 'ceilingReached')::boolean is not true then
    raise exception 'a reader at the ceiling stored % of 50 fresh highlights', res ->> 'added';
  end if;

  perform pg_temp.as_owner();
  select count(*) into n from public.works;
  if n <> n_before then
    raise exception 'a reader at the ceiling created % shared works', n - n_before;
  end if;
  select count(*) into n
    from public.contributors c where c.slug::text like 'orphan-author-%';
  if n <> 0 then
    raise exception 'a reader at the ceiling created % shared contributors', n;
  end if;
  perform pg_temp.become(bulk_user);

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

  -- --------------- 12. an Undo gives the highlights back and not the book ceiling
  --
  -- Round 4 bounded shared-catalogue creation by the room left under the ITEM ceiling,
  -- which round 3 had already made an Undo refund. The two cancel: import fresh titles,
  -- undo, repeat. Round 5 answered by deleting the works an Undo orphaned, and that
  -- raced every other reader's import three separate ways -- 12 silent losses in 14
  -- runs, another reader's 500-highlight chunk gone with `added: 500` returned. See the
  -- block in `undo_import`.
  --
  -- Nothing shared is deleted now. The bound is on CREATION instead, counted in the one
  -- unit that does not come back: distinct books this reader has ever imported into.
  -- Tombstones keep their `work_id`, so an Undo returns the holding quota and not this.
  perform pg_temp.as_owner();
  select count(*) into n_before from public.works;
  select count(*) into c_before from public.contributors;
  perform pg_temp.become(reader_b);

  for n in 1..3 loop
    res := public.commit_import('csv', repeat(n::text, 64), (
      select jsonb_agg(jsonb_build_object(
               'title', 'Cycle Volume ' || n || '-' || g,
               'author', 'Cycle Writer ' || n || '-' || g,
               'text', 'a highlight from cycle ' || n || ', book ' || g))
        from generate_series(1, 4) g
    ));
    if (res ->> 'added')::int <> 4 then
      raise exception 'cycle % stored % of 4', n, res ->> 'added';
    end if;
    perform public.undo_import((res ->> 'importId')::uuid);
  end loop;

  -- The rows stay, and that is the design rather than a leak: they are `user_owned`
  -- with nothing readable behind them, which 20260905101000 makes invisible to
  -- everyone. What matters is that the reader cannot keep making more.
  perform pg_temp.as_owner();
  select count(*) into n from public.works;
  if n <> n_before + 12 then
    raise exception 'three cycles of four books left % works, expected 12', n - n_before;
  end if;
  perform pg_temp.become(reader_b);

  -- AND THE CEILING DID NOT REFUND, asked of the function rather than of a query
  -- beside it. `capped_undone` is put one book short of `max_works_per_user` and then
  -- undoes everything: the holding quota comes back in full, and the book quota does
  -- not, so exactly one more book can ever be made. Counting `import_items` here
  -- instead would pass whether the function consulted it or not.
  perform pg_temp.as_owner();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, is_anonymous,
                          raw_app_meta_data, raw_user_meta_data)
  values (capped_undone, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'undone@example.test', 'x', now(), now(), now(), false,
          '{}'::jsonb, '{}'::jsonb);

  with made as (
    insert into public.works (kind, title, slug, rights_status)
    select 'book', 'Spent ' || g, 'imported-spent-' || g, 'user_owned'
      from generate_series(1, 1999) g
    returning id
  ),
  batch as (
    insert into public.imports (user_id, source_kind, file_hash, undone_at)
    values (capped_undone, 'csv', repeat('6', 64), now()) returning id
  )
  insert into public.import_items (import_id, user_id, work_id, content_hash, undone_at)
  select (select id from batch), capped_undone, made.id,
         md5('u' || made.id::text) || md5(made.id::text), now()
    from made;

  select count(*) into n
    from public.import_items ii
   where ii.user_id = capped_undone and ii.undone_at is null;
  if n <> 0 then
    raise exception 'the refund fixture holds % live items, expected 0', n;
  end if;
  perform pg_temp.become(capped_undone);

  -- Nothing held, so the item ceiling would allow all three. The book ceiling allows one.
  res := public.commit_import('csv', repeat('5', 64), jsonb_build_array(
    jsonb_build_object('title', 'One Book Of Room Left', 'text', 'the last book that fits'),
    jsonb_build_object('title', 'A Book Past The Refund', 'text', 'one book too many'),
    jsonb_build_object('title', 'And Another Past It', 'text', 'and another')
  ));
  if (res ->> 'added')::int <> 1 or (res ->> 'ceilingReached')::boolean is not true then
    raise exception 'an Undo refunded the book ceiling: stored % (ceilingReached=%)',
      res ->> 'added', res ->> 'ceilingReached';
  end if;
  perform pg_temp.become(reader_b);

  -- And the byline comes back with the book, without anything being deleted to make it.
  -- `attribute_work` reuses a contributor only when the caller can already see a work
  -- behind it, and an Undo deletes exactly that summary -- so a reader who imported an
  -- author, undid it, and imported them again got nothing the second time. The guard
  -- now asks whether this reader has imported that author before, which is a fact they
  -- already hold and discloses nothing.
  --
  -- A DIFFERENT book by that author, which is the case the guard decides. The link on
  -- the same book survived the Undo untouched -- nothing deletes `work_contributors`
  -- now -- so asserting that one would pass whatever the guard did.
  res := public.commit_import('csv', repeat('9', 64), jsonb_build_array(
    jsonb_build_object('title', 'A Later Book By 1-1', 'author', 'Cycle Writer 1-1',
      'text', 'a different book by an author this reader has imported and undone')
  ));
  if (res ->> 'added')::int <> 1 then
    raise exception 'the re-import after three undos stored %', res ->> 'added';
  end if;
  select count(*) into n
    from public.work_contributors wc
    join public.works w on w.id = wc.work_id
   where w.slug like 'imported-a-later-book-by-1-1%';
  if n <> 1 then
    raise exception 'a book by an author this reader had undone came back with % bylines', n;
  end if;

  -- ------------------------------- 12b. an Undo does not reach another reader's book
  --
  -- The shared work is the premise of the whole feature: two readers who import the same
  -- book land on the same row. Round 5 deleted that row when the undoing reader's own
  -- summary was the last one visible to the deleting statement, and the snapshot made
  -- that judgement wrong under concurrency -- `summaries.work_id` is `on delete
  -- cascade`, so the other reader's summary, pull, schedule and saves went with it,
  -- silently, in 12 of 14 ordinary runs. Nothing shared is deleted now, and this is the
  -- committed-state half of that: the case that was supposed to be safe.
  perform pg_temp.as_owner();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, is_anonymous,
                          raw_app_meta_data, raw_user_meta_data)
  values (sharer, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'sharer@example.test', 'x', now(), now(), now(), false, '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.become(sharer);

  res := public.commit_import('csv', repeat('e', 64), jsonb_build_array(
    jsonb_build_object('title', 'A Book Two Readers Have', 'author', 'A Shared Author',
      'text', 'the sharer''s highlight')
  ));
  batch_one := (res ->> 'importId')::uuid;

  perform pg_temp.become(reader_a);
  res := public.commit_import('csv', repeat('f', 64), jsonb_build_array(
    jsonb_build_object('title', 'A Book Two Readers Have', 'author', 'A Shared Author',
      'text', 'reader A''s different highlight of the same book')
  ));
  if (res ->> 'added')::int <> 1 then
    raise exception 'the shared-book fixture stored %', res ->> 'added';
  end if;
  select w.id into shared_work
    from public.works w where w.slug like 'imported-a-book-two-readers-have%';

  -- The sharer takes theirs back. Reader A keeps everything.
  perform pg_temp.become(sharer);
  perform public.undo_import(batch_one);

  perform pg_temp.as_owner();
  select count(*) into n from public.works w where w.id = shared_work;
  if n <> 1 then
    raise exception 'one reader''s Undo deleted a book another reader holds';
  end if;
  select count(*) into n
    from public.work_contributors wc where wc.work_id = shared_work;
  if n <> 1 then
    raise exception 'one reader''s Undo stripped the byline off another reader''s book';
  end if;
  perform pg_temp.become(reader_a);
  select count(*) into n
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.work_id = shared_work and s.author_id = reader_a;
  if n <> 1 then
    raise exception 'a reader lost % of their 1 highlight to a stranger''s Undo', 1 - n;
  end if;

  -- ------------------- 12d. a re-import after an Undo does not crowd out a new book
  --
  -- The pre-pass ranks slugs and the window is capped, so anything in the set that does
  -- not need a work created displaces something that does. A tombstoned hash is exactly
  -- that: the loop stores it, and its work is already there. Filtering the set on live
  -- duplicates instead of on any row put revivals back in the window, and because the
  -- loop now STOPS on a missing work rather than raising, the fresh titles behind them
  -- would have gone silently.
  -- WITH THE WINDOW TIGHT, because that is the only state where it shows. A reader
  -- with room to spare has a rank cap larger than anything they offer, so a revival
  -- taking a slot costs nothing; this reader has room for exactly one more book.
  perform pg_temp.as_owner();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, is_anonymous,
                          raw_app_meta_data, raw_user_meta_data)
  values (reviver, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'reviver@example.test', 'x', now(), now(), now(), false, '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.become(reviver);

  res := public.commit_import('csv', repeat('4', 64), jsonb_build_array(
    jsonb_build_object('title', 'Revival Book One', 'text', 'a highlight to take back'),
    jsonb_build_object('title', 'Revival Book Two', 'text', 'another to take back')
  ));
  if (res ->> 'added')::int <> 2 then
    raise exception 'the revival fixture stored % of 2', res ->> 'added';
  end if;
  perform public.undo_import((res ->> 'importId')::uuid);

  -- 1,997 more books spent, so with the two above this reader is at 1,999 of 2,000.
  perform pg_temp.as_owner();
  with made as (
    insert into public.works (kind, title, slug, rights_status)
    select 'book', 'Revived Filler ' || g, 'imported-revived-filler-' || g, 'user_owned'
      from generate_series(1, 1997) g
    returning id
  ),
  batch as (
    insert into public.imports (user_id, source_kind, file_hash, undone_at)
    values (reviver, 'csv', repeat('2', 64), now()) returning id
  )
  insert into public.import_items (import_id, user_id, work_id, content_hash, undone_at)
  select (select id from batch), reviver, made.id,
         md5('r' || made.id::text) || md5(made.id::text), now()
    from made;
  select count(distinct ii.work_id) into n
    from public.import_items ii where ii.user_id = reviver and ii.work_id is not null;
  if n <> 1999 then
    raise exception 'the revival fixture holds % books, expected 1999', n;
  end if;
  perform pg_temp.become(reviver);

  -- The same two, plus one genuinely new book. The two revivals need no work created
  -- and must not consume the single slot the new one needs. All three land.
  res := public.commit_import('csv', repeat('3', 64), jsonb_build_array(
    jsonb_build_object('title', 'Revival Book One', 'text', 'a highlight to take back'),
    jsonb_build_object('title', 'Revival Book Two', 'text', 'another to take back'),
    jsonb_build_object('title', 'Revival Book Three', 'text', 'and one that is new')
  ));
  if (res ->> 'added')::int <> 3 then
    raise exception 'two revivals crowded out a new book: stored % of 3', res ->> 'added';
  end if;
  select count(*) into n
    from public.works w where w.slug like 'imported-revival-book-three%';
  if n <> 1 then
    raise exception 'the new book behind two revivals was never created';
  end if;
  perform pg_temp.become(reader_b);

  -- ------------------------------- 12c. the book ceiling stops, it does not raise
  --
  -- The bound that replaces the deletion. A reader at `max_works_per_user` creates no
  -- more shared rows -- and reports the stop rather than raising, because a raise rolls
  -- back everything the call had room for. 2,000 is the constant; the fixture puts this
  -- reader one book short of it.
  perform pg_temp.as_owner();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, is_anonymous,
                          raw_app_meta_data, raw_user_meta_data)
  values (capped, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'capped@example.test', 'x', now(), now(), now(), false, '{}'::jsonb, '{}'::jsonb);

  with made as (
    insert into public.works (kind, title, slug, rights_status)
    select 'book', 'Filler ' || g, 'imported-filler-' || g, 'user_owned'
      from generate_series(1, 1999) g
    returning id
  ),
  batch as (
    insert into public.imports (user_id, source_kind, file_hash)
    values (capped, 'csv', repeat('7', 64)) returning id
  )
  insert into public.import_items (import_id, user_id, work_id, content_hash)
  select (select id from batch), capped, made.id,
         md5(made.id::text) || md5(made.id::text)
    from made;

  select count(distinct ii.work_id) into n
    from public.import_items ii where ii.user_id = capped;
  if n <> 1999 then
    raise exception 'the cap fixture holds % books, expected 1999', n;
  end if;
  select count(*) into n_before from public.works;
  perform pg_temp.become(capped);

  -- Three new titles, one slot left: one book is made, the call stops, nothing raises.
  res := public.commit_import('csv', repeat('8', 64), jsonb_build_array(
    jsonb_build_object('title', 'The Two Thousandth Book', 'text', 'the last one that fits'),
    jsonb_build_object('title', 'The Two Thousand And First', 'text', 'one book too many'),
    jsonb_build_object('title', 'The Two Thousand And Second', 'text', 'and another')
  ));
  if (res ->> 'added')::int <> 1 or (res ->> 'ceilingReached')::boolean is not true then
    raise exception 'at the book ceiling a reader stored % (ceilingReached=%)',
      res ->> 'added', res ->> 'ceilingReached';
  end if;

  perform pg_temp.as_owner();
  select count(*) into n from public.works;
  if n <> n_before + 1 then
    raise exception 'a reader one book from the ceiling created % works, expected 1',
      n - n_before;
  end if;

  -- ------- 12b. a book refused by the ceiling does not throw away the rest of the file
  --
  -- The loop used to `exit` on the first title it could not create, which discarded
  -- later items sitting on books the reader ALREADY owns -- costing no book quota and
  -- well inside their item room. Measured: the same 500 items stored 0 or 499 depending
  -- only on where the one new title fell in the file, and a Kindle export is grouped by
  -- book, so that is wherever it lands.
  select count(*) into n_before from public.works;
  select count(*) into c_before from public.contributors;
  perform pg_temp.become(capped);

  res := public.commit_import('csv', repeat('9', 64), jsonb_build_array(
    jsonb_build_object('title', 'A Title Past The Ceiling', 'author', 'Refused Author',
      'text', 'this one needs a book the reader may not create'),
    jsonb_build_object('title', 'The Two Thousandth Book',
      'text', 'but this one is a second highlight of a book they already hold')
  ));
  if (res ->> 'added')::int <> 1 then
    raise exception
      'a title refused by the book ceiling cost the reader % of the rest of the file',
      1 - (res ->> 'added')::int;
  end if;
  if (res ->> 'ceilingReached')::boolean is not true then
    raise exception 'the book ceiling was reached and not reported';
  end if;

  -- AND NOTHING WAS CREATED FOR THE ITEM IT DECLINED. Creation used to run ahead of the
  -- loop in a window sized from the room left, so works were made for items the loop
  -- then never stored -- rows no `import_items` row points at, which is exactly what the
  -- book counter counts. Measured at +750 works and +750 contributors over three
  -- import-undo cycles with the counter unmoved.
  perform pg_temp.as_owner();
  select count(*) into n from public.works;
  if n <> n_before then
    raise exception 'a refused title still created % work row(s)', n - n_before;
  end if;
  select count(*) into n from public.contributors;
  if n <> c_before then
    raise exception 'a refused title still created % contributor row(s)', n - c_before;
  end if;

  -- No work of this reader's is unreferenced, which is the invariant the counter rests
  -- on: `v_books` counts distinct `import_items.work_id`, so a work with no item is a
  -- row the ceiling cannot see.
  select count(*) into n
    from public.works w
   where w.rights_status = 'user_owned'
     and w.slug like 'imported-%'
     and exists (
       select 1 from public.summaries s2 where s2.work_id = w.id and s2.author_id = capped
     )
     and not exists (
       select 1 from public.import_items ii where ii.work_id = w.id and ii.user_id = capped
     );
  if n <> 0 then
    raise exception '% of this reader''s works are referenced by no import item', n;
  end if;
  perform pg_temp.become(reader_a);

  -- ------------------------------- 13. every book by an author keeps its byline
  --
  -- The contributors pre-pass was `distinct on (author)`, which passed `attribute_work`
  -- the lexicographically smallest slug and dropped the byline on every other book by
  -- that author in the same call. Section 9d could not see it: both of its fixtures are
  -- separate one-item calls. A Kindle export is grouped by book and chunked at 500, so
  -- several books by one author in one chunk is the ordinary case.
  --
  -- Says who it is. This and section 14 used to inherit whoever the previous section
  -- left active, so inserting a section between them silently moved both to another
  -- reader — and section 14, whose whole assertion is that a STRANGER cannot write into
  -- a batch, quietly became a reader writing into their own, and passed.
  perform pg_temp.as_owner();
  select public.imported_contributor_slug('Prolific Diarist', reader_b) into slug_pd_b;

  perform pg_temp.become(reader_b);
  res := public.commit_import('csv', repeat('a', 63) || 'b', jsonb_build_array(
    jsonb_build_object('title', 'Alpha Volume', 'author', 'Prolific Diarist',
      'text', 'the first of three by one author'),
    jsonb_build_object('title', 'Mu Volume', 'author', 'Prolific Diarist',
      'text', 'the second of three by one author'),
    jsonb_build_object('title', 'Zeta Volume', 'author', 'Prolific Diarist',
      'text', 'the third of three by one author')
  ));
  if (res ->> 'added')::int <> 3 then
    raise exception 'the three-book fixture stored %', res ->> 'added';
  end if;
  select count(*) into n
    from public.work_contributors wc
    join public.contributors c on c.id = wc.contributor_id
   where c.slug operator(extensions.=) slug_pd_b::extensions.citext;
  if n <> 3 then
    raise exception 'three books by one author in one call were attributed % times', n;
  end if;

  -- ------------------------------- 14. a chunk names the batch it continues
  --
  -- The reuse window is a heuristic: `source_kind` alone cannot tell chunk two of a
  -- paste from an unrelated paste, and at six hours two unrelated pastes merged so that
  -- undoing the second took the first one's highlights -- the one thing an Undo must not
  -- do. Five minutes shrinks that window without closing it. A client chunking an upload
  -- knows the answer and can now say it.
  perform pg_temp.become(reader_b);
  res := public.commit_import('paste', null, jsonb_build_array(
    jsonb_build_object('title', 'A Named Batch', 'text', 'chunk one of a long paste')
  ));
  batch_one := (res ->> 'importId')::uuid;

  res := public.commit_import('paste', null, jsonb_build_array(
    jsonb_build_object('title', 'A Named Batch', 'text', 'chunk two of the same paste')
  ), batch_one);
  if (res ->> 'importId')::uuid <> batch_one then
    raise exception 'a named chunk opened a new batch instead of joining %', batch_one;
  end if;

  -- A batch that is not yours is not a batch you may write into, and neither is one you
  -- have already taken back.
  perform pg_temp.become(reader_a);
  refused := false;
  begin
    perform public.commit_import('paste', null, jsonb_build_array(
      jsonb_build_object('title', 'Not Mine', 'text', 'writing into a stranger''s batch')
    ), batch_one);
  exception when others then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader wrote into another reader''s import batch';
  end if;
  perform pg_temp.become(reader_b);

  perform public.undo_import(batch_one);
  refused := false;
  begin
    perform public.commit_import('paste', null, jsonb_build_array(
      jsonb_build_object('title', 'A Named Batch', 'text', 'chunk three, after the undo')
    ), batch_one);
  exception when others then
    refused := true;
  end;
  if not refused then
    raise exception 'a chunk joined a batch the reader had already undone';
  end if;

  -- ---------------- 15. closing the account takes the import wherever it has been moved
  --
  -- `delete_my_account` deleted the reader's summaries unless they were genuinely
  -- published to the world, which destroyed canonical drafts mid-generation; round 4
  -- narrowed that to the work's `rights_status = 'user_owned'`, and the reader can move
  -- the summary. `summaries_author_update` constrains `author_id`, the published+public
  -- pair and `work_is_authorable(work_id)` -- true of every catalogue work -- and
  -- `authenticated` holds column UPDATE on `work_id`. So one PATCH left an ownerless
  -- summary whose pulls hold a publisher's paragraphs, which is exactly the retention
  -- the RPC exists to prevent. Provenance is the thing the reader cannot move.
  perform pg_temp.as_owner();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, is_anonymous,
                          raw_app_meta_data, raw_user_meta_data)
  values (closer, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'closer@example.test', 'x', now(), now(), now(), false, '{}'::jsonb, '{}'::jsonb);
  select w.id into seeded_work from public.works w where w.slug = 'on-liberty';
  -- `delete_my_account` refuses a session older than the reauth window, so the fixture
  -- needs a real one; `account_security.sql` §5 is where that rule is asserted.
  insert into auth.sessions (id, user_id, created_at, updated_at)
  values (closer_sess, closer, now(), now());
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', closer, 'role', 'authenticated',
                      'session_id', closer_sess)::text, true);
  perform pg_temp.assert_is_reader();

  res := public.commit_import('paste', null, jsonb_build_array(
    jsonb_build_object('title', 'A Publisher''s Book', 'author', 'Some Publisher',
      'text', 'A verbatim paragraph the publisher owns, kept by the reader.')
  ));

  update public.summaries s
     set work_id = seeded_work, status = 'draft', visibility = 'public'
   where s.author_id = closer;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'the fixture could not move the summary (% rows), so it proves nothing', n;
  end if;

  perform public.delete_my_account();

  perform pg_temp.as_owner();
  select count(*) into n from public.summaries s where s.author_id = closer;
  if n <> 0 then
    raise exception 'a moved import survived the account it belonged to (% summaries)', n;
  end if;
  select count(*) into n
    from public.pulls p
   where p.body = 'A verbatim paragraph the publisher owns, kept by the reader.';
  if n <> 0 then
    raise exception 'the publisher''s paragraph outlived the reader (% pulls)', n;
  end if;
  -- And the summary is not merely ownerless: `delete_my_account` deletes the auth row,
  -- so an orphan here would be unreachable and permanent.
  select count(*) into n from auth.users u where u.id = closer;
  if n <> 0 then
    raise exception 'delete_my_account left the account behind';
  end if;

  -- --------- 15b. moved AND undone, which is what got past both predicates at once
  --
  -- Provenance was called "the thing the reader cannot move", and an Undo moves it:
  -- deleting the pull nulls `import_items.pull_id`, so the join that identified an
  -- imported summary found nothing. Undo's own delete did not collect it either, because
  -- that asked for `visibility = 'private'` and the reader had just PATCHed it public.
  -- The two gaps line up exactly, and a summary walked between them -- measured, left
  -- behind with `auth.users` gone: permanent, unreachable and uncollectable.
  perform pg_temp.as_owner();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, is_anonymous,
                          raw_app_meta_data, raw_user_meta_data)
  values (closer_two, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'closer2@example.test', 'x', now(), now(), now(), false,
          '{}'::jsonb, '{}'::jsonb);
  insert into auth.sessions (id, user_id, created_at, updated_at)
  values (closer_two_sess, closer_two, now(), now());
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', closer_two, 'role', 'authenticated',
                      'session_id', closer_two_sess)::text, true);

  res := public.commit_import('paste', null, jsonb_build_array(
    jsonb_build_object('title', 'A Diary Of My Illness', 'author', 'A Private Person',
      'text', 'A sentence the reader would not want left on a server forever.')
  ));

  update public.summaries s
     set status = 'draft', visibility = 'public'
   where s.author_id = closer_two;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'the fixture could not make the summary public (% rows)', n;
  end if;

  perform public.undo_import((res ->> 'importId')::uuid);

  -- ASKED HERE, BEFORE THE CLOSE, because the two fixes mask each other otherwise. The
  -- Undo is the one that acts: `delete_my_account` grew a `user_owned` leg for the same
  -- gap, and with either one in place the end state is right, so a test that only looked
  -- after the close passed with either reverted. This pins the Undo.
  perform pg_temp.as_owner();
  select count(*) into n from public.summaries s where s.author_id = closer_two;
  if n <> 0 then
    raise exception 'an Undo left a summary the reader had made public (% rows)', n;
  end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', closer_two, 'role', 'authenticated',
                      'session_id', closer_two_sess)::text, true);

  perform public.delete_my_account();

  perform pg_temp.as_owner();
  select count(*) into n from public.summaries s where s.author_id = closer_two;
  if n <> 0 then
    raise exception
      'a summary the reader made public and then undid survived the account (% rows)', n;
  end if;
  perform pg_temp.become(reader_a);

  raise notice 'imports: kept, deduped, and shared with nobody -- a second reader of '
    'the same book gets their own work, their own byline and their own timestamp, and '
    'cannot see that the first reader exists; never in the feed, refused to guests, '
    'scheduled and saved so Review and the Library see them, graded only against their '
    'own questions, bounded by rows that exist rather than by a window that forecast '
    'them, a refused book costing only itself, an Undo giving back the highlights and '
    'not the ceiling, attributed on every book rather than the first, joinable only to '
    'a batch the reader names and still holds, and gone with the account however the '
    'summary has since been moved or undone';
end $$;

rollback;
