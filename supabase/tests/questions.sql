-- ---------------------------------------------------------------------------
-- A question that can be wrong.
--
-- 20260905120000 gives `quiz_questions` a checked `kind`, an explanation, a cloze
-- and a per-distractor rationale; gives `user_questions` the first two; and makes
-- `get_due_reviews` return an ARRAY of questions rather than one prompt.
--
-- What is asserted, and each is a way the change could be wrong:
--
--   * the top level of `get_due_reviews` is still an ARRAY -- `smoke-read-path.sql`
--     calls `jsonb_array_length` on it, so a shape change here is a broken read path
--   * `questions` puts the reader's own first, then the canonical ones, and caps at
--     three
--   * `question`, `questionId` and `questionSource` describe `questions[0]` and
--     cannot describe anything else, because they are read off it
--   * the fixture contains a genuine ORDERING TIE -- two canonical questions written
--     by one statement, so equal on every term but the id -- and the array comes back
--     the same on two calls anyway. See the caveat below: this demonstrates the tie is
--     real and the answer stable; it cannot demonstrate the tiebreak is what makes it
--     so, and it is not claimed to
--   * a retired question falls out, and the next one takes its place
--   * `p_limit` is clamped to 1..100 -- 2,000,000,000 does not ask Postgres for
--     every due row a reader has, and 0 does not report "nothing is due"
--   * the `kind` check accepts all SIX kinds and refuses a seventh -- both halves,
--     because a check narrowed to one value would pass the refusal test alone
--   * a reader's own `options` reach the array as `distractors`, so one renderer
--     serves both tables and a reader's MCQ does not arrive with no choices
--   * an MCQ with fewer than two distractors is refused, because it cannot be got
--     wrong, and a cloze with no blank is refused, because there is nothing to fill
--   * `distractors` and `rationale` refuse a non-array and refuse an enormous one
--   * `explanation` and `cloze` are length-bounded on BOTH tables
--   * a reader's own question is theirs alone: B's `get_due_reviews` on the same
--     pull never carries A's question -- and see the note below on WHERE that comes
--     from, which is not where the function's own text suggests
--
-- WHAT THIS FILE CANNOT PROVE, said plainly because a mutation run measured it. The
-- `id` at the end of the questions ordering makes it TOTAL, and removing it does not
-- fail this file: within one session Postgres picks one plan and returns tied rows in
-- a consistent order, so an unspecified order and a specified one look identical from
-- here. Section 4 is therefore evidence, not proof -- the same kind of caveat
-- `imports.sql` makes about lock ordering. What can be asserted is that the tie is
-- genuine rather than hypothetical, which is why the two canonical questions are
-- written by ONE statement, and section 4 checks that first.
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

-- `quiz_questions` has no insert policy -- the pipeline writes it and no reader may.
-- Seeding canonical questions is therefore an owner-role act by construction, and so
-- is asserting that a CHECK refuses one: a reader cannot get far enough to be refused
-- by it. Every assertion about what a READER sees runs as the reader.
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

  pull_1   uuid;
  pull_2   uuid;
  seeded_q uuid;
  mcq_id   uuid;
  cloze_id uuid;
  own_1    uuid;
  own_2    uuid;

  due      jsonb;
  due2     jsonb;
  card     jsonb;
  qs       jsonb;
  n        int;

  bulk_work    uuid := extensions.gen_random_uuid();
  bulk_summary uuid := extensions.gen_random_uuid();
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values (reader_a, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'questions-a@example.invalid', now(), now()),
         (reader_b, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'questions-b@example.invalid', now(), now());

  -- A seeded, published, public pull that already carries one canonical question.
  select p.id into pull_1
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.status = 'published' and s.visibility = 'public'
     and exists (select 1 from public.quiz_questions q where q.pull_id = p.id)
   order by p.id
   limit 1;

  if pull_1 is null then
    raise exception 'the seed has no published pull with a canonical question';
  end if;

  select q.id into seeded_q from public.quiz_questions q where q.pull_id = pull_1 limit 1;

  select p.id into pull_2
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.status = 'published' and s.visibility = 'public' and p.id <> pull_1
   order by p.id
   limit 1;

  ---------------------------------------------------------------------------
  -- 1. THE NEW COLUMNS EXIST AND ARE BOUNDED.
  ---------------------------------------------------------------------------
  perform pg_temp.as_owner();

  -- Written in ONE statement, so both rows share `created_at` to the microsecond.
  -- That is the case the total order in `get_due_reviews` exists for: without the
  -- `id` tiebreak Postgres may return them either way round and the reader's
  -- "1 of 3" renames itself between two loads of the same card.
  insert into public.quiz_questions
    (pull_id, prompt, answer, distractors, kind, cloze, explanation, rationale)
  values
    (pull_1, 'Which of these follows from the idea?', 'The one that follows',
     '["a plausible mistake","a second mistake","a third"]'::jsonb, 'mcq', null,
     'Because only that one is entailed.',
     '[{"distractor":"a plausible mistake","why":"it reverses the direction"}]'::jsonb),
    (pull_1, 'Fill the blank.', 'material', '[]'::jsonb, 'cloze',
     'The obstacle is the ____.', 'That is the phrase the passage turns on.',
     '[]'::jsonb);

  select q.id into mcq_id   from public.quiz_questions q where q.pull_id = pull_1 and q.kind = 'mcq';
  select q.id into cloze_id from public.quiz_questions q where q.pull_id = pull_1 and q.kind = 'cloze';

  if mcq_id is null or cloze_id is null then
    raise exception 'the mcq and cloze rows did not land';
  end if;

  -- ALL SIX KINDS ARE ACCEPTED. The refusal below is only half the check: narrowed
  -- to `kind in ('recall')` it would still pass, and every generated MCQ would then
  -- be rejected at the end of a generation somebody had already paid for.
  insert into public.quiz_questions (pull_id, prompt, answer, kind, distractors, cloze)
  select pull_2, 'Prompt for ' || k, 'Answer', k,
         case when k = 'mcq' then '["one","two"]'::jsonb else '[]'::jsonb end,
         case when k = 'cloze' then 'A sentence with a ____ in it.' else null end
    from unnest(array['recall','mcq','cloze','short_answer','ordering','scenario']) k;

  select count(*) into n from public.quiz_questions q where q.pull_id = pull_2;
  if n <> 6 then
    raise exception 'expected all six kinds to be accepted, stored %', n;
  end if;

  delete from public.quiz_questions q where q.pull_id = pull_2;

  -- A kind no renderer knows.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind)
    values (pull_2, 'p', 'a', 'interpretive_dance');
    raise exception 'an unknown question kind was accepted';
  exception when check_violation then null;
  end;

  -- An MCQ that cannot be got wrong.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, distractors)
    values (pull_2, 'p', 'a', 'mcq', '["only one wrong option"]'::jsonb);
    raise exception 'an mcq with one distractor was accepted';
  exception when check_violation then null;
  end;

  -- A cloze with nothing to fill in.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, cloze)
    values (pull_2, 'p', 'a', 'cloze', '   ');
    raise exception 'a cloze with a blank cloze was accepted';
  exception when check_violation then null;
  end;

  -- `distractors` refuses a non-array. It has been unchecked since 20260829124507,
  -- and `mcqOptions` in `activities.ts` shuffles it -- a non-array is a crash on a
  -- screen the reader cannot get past.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, distractors)
    values (pull_2, 'p', 'a', 'recall', '{"not":"an array"}'::jsonb);
    raise exception 'a non-array distractors was accepted';
  exception when check_violation then null;
  end;

  -- And refuses an enormous one. The writer here is a model, which is the other
  -- source of unbounded text in this schema.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, distractors)
    values (pull_2, 'p', 'a', 'recall',
            jsonb_build_array(repeat('x', 25000)));
    raise exception 'a 25 kB distractors array was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, rationale)
    values (pull_2, 'p', 'a', 'recall', '{"not":"an array"}'::jsonb);
    raise exception 'a non-array rationale was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, explanation)
    values (pull_2, 'p', 'a', 'recall', repeat('x', 2001));
    raise exception 'a 2001-character explanation was accepted';
  exception when check_violation then null;
  end;

  -- The canonical cloze is bounded too. A mutation run caught this missing: the
  -- reader's `cloze` had a length assertion and the model-written one did not, which
  -- is the wrong way round -- the reader is the writer with the smaller appetite.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, cloze)
    values (pull_2, 'p', 'a', 'cloze', repeat('x', 1001));
    raise exception 'a 1001-character cloze was accepted on quiz_questions';
  exception when check_violation then null;
  end;

  ---------------------------------------------------------------------------
  -- 2. A AND B EACH HOLD THE IDEA, AND EACH WRITES THEIR OWN QUESTION.
  ---------------------------------------------------------------------------
  perform pg_temp.become(reader_a);

  insert into public.knowledge_states (user_id, pull_id, acquired_via, next_due_at)
  values (reader_a, pull_1, 'saved', now() - interval '1 hour');

  own_1 := (public.remember_pull(pull_1, 'What did A ask?', 'A''s answer', 'recall',
                                 extensions.gen_random_uuid()) ->> 'questionId')::uuid;

  ---------------------------------------------------------------------------
  -- 3. THE SHAPE.
  ---------------------------------------------------------------------------
  due := public.get_due_reviews(50);

  if jsonb_typeof(due) <> 'array' then
    raise exception
      'get_due_reviews no longer returns an array (got %). scripts/smoke-read-path.sql '
      'calls jsonb_array_length on this.', jsonb_typeof(due);
  end if;

  select e into card from jsonb_array_elements(due) e where e ->> 'pullId' = pull_1::text;
  if card is null then
    raise exception 'the due card for the pull A holds is missing';
  end if;

  qs := card -> 'questions';
  if jsonb_typeof(qs) <> 'array' then
    raise exception 'questions is not an array (got %)', jsonb_typeof(qs);
  end if;

  -- One of A's own plus three canonical, capped at three.
  if jsonb_array_length(qs) <> 3 then
    raise exception 'expected 3 questions after the cap, got %', jsonb_array_length(qs);
  end if;

  if qs -> 0 ->> 'source' <> 'user' then
    raise exception 'the reader''s own question is not first (got %)', qs -> 0 ->> 'source';
  end if;
  if qs -> 0 ->> 'id' <> own_1::text then
    raise exception 'the first question is not the one A wrote';
  end if;

  select count(*) into n
    from jsonb_array_elements(qs) e where e ->> 'source' = 'canonical';
  if n <> 2 then
    raise exception 'expected 2 canonical questions after the cap, got %', n;
  end if;

  -- The three singular fields are READ OFF questions[0]; they cannot disagree with
  -- it. 20260905110000 had them computed separately and a review mutant made them
  -- name a different question than the one returned.
  if card ->> 'question' <> (qs -> 0 ->> 'prompt')
     or card ->> 'questionId' <> (qs -> 0 ->> 'id')
     or card ->> 'questionSource' <> (qs -> 0 ->> 'source') then
    raise exception
      'the singular question fields disagree with questions[0]: % / % / % vs % / % / %',
      card ->> 'question', card ->> 'questionId', card ->> 'questionSource',
      qs -> 0 ->> 'prompt', qs -> 0 ->> 'id', qs -> 0 ->> 'source';
  end if;

  -- The card's own prose, neither of which Review could reach before.
  if not (card ? 'example' and card ? 'explanation'
          and card ? 'contentVersion' and card ? 'difficulty' and card ? 'lapses') then
    raise exception 'the card is missing one of example/explanation/contentVersion/difficulty/lapses: %',
      (select string_agg(k, ',') from jsonb_object_keys(card) k);
  end if;

  -- Every canonical question carries the new columns, and the MCQ carries its
  -- rationale rather than losing it on the way out.
  select e into card
    from jsonb_array_elements(qs) e where e ->> 'id' = mcq_id::text;
  if card is null then
    raise exception 'the mcq did not survive the cap';
  end if;
  if jsonb_array_length(card -> 'distractors') <> 3 then
    raise exception 'the mcq lost its distractors';
  end if;
  if jsonb_array_length(card -> 'rationale') <> 1 then
    raise exception 'the mcq lost its rationale';
  end if;
  if card ->> 'explanation' is null then
    raise exception 'the mcq lost its explanation';
  end if;

  ---------------------------------------------------------------------------
  -- 4. THE TIE IS REAL, AND THE ORDER IS STABLE ACROSS IT.
  --
  -- See the header for what this can and cannot show. The assertion below that the
  -- two canonical questions share a `created_at` is the load-bearing half: without
  -- it, a later change that gave them distinct timestamps would leave this section
  -- passing while testing nothing at all.
  ---------------------------------------------------------------------------
  perform pg_temp.as_owner();
  select count(distinct q.created_at) into n
    from public.quiz_questions q
   where q.id in (mcq_id, cloze_id);
  if n <> 1 then
    raise exception
      'the mcq and the cloze no longer share a created_at, so there is no ordering '
      'tie left here and the stability check below proves nothing. Write them in one '
      'statement, or move this assertion to wherever the tie now lives.';
  end if;
  perform pg_temp.become(reader_a);

  due2 := public.get_due_reviews(50);
  select e -> 'questions' into qs
    from jsonb_array_elements(due2) e where e ->> 'pullId' = pull_1::text;

  if qs <> (select e -> 'questions' from jsonb_array_elements(due) e
             where e ->> 'pullId' = pull_1::text) then
    raise exception
      'the questions array is not stable across two calls, and the mcq and the cloze '
      'share a created_at -- so the reader''s "1 of 3" renames itself between two '
      'loads of the same card.';
  end if;

  ---------------------------------------------------------------------------
  -- 5. A RETIRED QUESTION FALLS OUT, AND THE NEXT ONE TAKES ITS PLACE.
  ---------------------------------------------------------------------------
  own_2 := (public.remember_pull(pull_1, 'A''s second question?', 'and its answer',
                                 'short_answer', extensions.gen_random_uuid())
            ->> 'questionId')::uuid;

  -- Backdated because `now()` is the TRANSACTION timestamp, so both of A's questions
  -- carry the same `created_at` in here and "the newer one" is not a thing this file
  -- can otherwise observe. In use each `remember_pull` is its own request and its own
  -- transaction, so the difference exists without help; the tie is the artefact, and
  -- forcing it apart is what makes the recency rule assertable rather than accidental.
  -- (The tie that IS real -- canonical questions written by one statement -- is what
  -- section 4 above covers, and it is the reason the ordering carries an id at all.)
  perform pg_temp.as_owner();
  update public.user_questions set created_at = now() - interval '1 minute'
   where id = own_1;
  perform pg_temp.become(reader_a);

  select e -> 'questions' into qs
    from jsonb_array_elements(public.get_due_reviews(50)) e
   where e ->> 'pullId' = pull_1::text;

  if qs -> 0 ->> 'id' <> own_2::text then
    raise exception 'the newer of A''s own questions is not asked first';
  end if;

  update public.user_questions set retired_at = now() where id = own_2;

  select e -> 'questions' into qs
    from jsonb_array_elements(public.get_due_reviews(50)) e
   where e ->> 'pullId' = pull_1::text;

  if qs -> 0 ->> 'id' <> own_1::text then
    raise exception 'a retired question did not fall out (got %)', qs -> 0 ->> 'id';
  end if;

  ---------------------------------------------------------------------------
  -- 6. p_limit IS CLAMPED.
  --
  -- Passed straight to `limit`, `get_due_reviews(2000000000)` asked Postgres for
  -- every due row this reader has and built one JSON document out of all of them,
  -- under an 8 s statement_timeout, through an RPC any signed-in caller can reach.
  ---------------------------------------------------------------------------
  perform pg_temp.as_owner();

  -- 120 more due ideas, so a clamp at 100 is distinguishable from no clamp. The
  -- seeded corpus is 34 published pulls, which is nowhere near it, so the fixture
  -- builds its own -- in exactly the shape an import makes, which is also the only
  -- realistic way a reader reaches this many due at once.
  insert into public.works (id, kind, title, slug, rights_status)
  values (bulk_work, 'book', 'A Hundred And Twenty Ideas',
          'questions-test-bulk', 'user_owned');

  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title, published_at)
  values (bulk_summary, bulk_work, 1, 'published', 'private', reader_a,
          'A Hundred And Twenty Ideas', now());

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  select bulk_summary, g, 'Bulk idea ' || g, 'The body of bulk idea ' || g || '.', 5
    from generate_series(1, 120) g;

  insert into public.knowledge_states (user_id, pull_id, acquired_via, next_due_at)
  select reader_a, p.id, 'saved', now() - interval '1 hour'
    from public.pulls p where p.summary_id = bulk_summary
  on conflict (user_id, pull_id) do nothing;

  perform pg_temp.become(reader_a);

  select count(*) into n from public.knowledge_states ks
   where ks.user_id = reader_a and ks.next_due_at <= now();
  if n <= 100 then
    raise exception
      'this fixture needs more than 100 due ideas to tell a clamp from no clamp (got %). '
      'The seeded corpus is smaller than it was.', n;
  end if;

  if jsonb_array_length(public.get_due_reviews(2000000000)) <> 100 then
    raise exception 'p_limit is not clamped at 100 (got % rows)',
      jsonb_array_length(public.get_due_reviews(2000000000));
  end if;
  if jsonb_array_length(public.get_due_reviews(0)) <> 1 then
    raise exception 'p_limit 0 did not floor to 1 (got % rows)',
      jsonb_array_length(public.get_due_reviews(0));
  end if;
  if jsonb_array_length(public.get_due_reviews(-5)) <> 1 then
    raise exception 'a negative p_limit did not floor to 1';
  end if;
  if jsonb_array_length(public.get_due_reviews(null)) <> 20 then
    raise exception 'a null p_limit did not fall back to the default of 20';
  end if;

  ---------------------------------------------------------------------------
  -- 6b. A READER'S OWN CHOICES REACH THE ARRAY.
  --
  -- `user_questions.options` and `quiz_questions.distractors` are the same list under
  -- two names, and `get_due_reviews` surfaces both as `distractors` so one renderer
  -- serves both tables. Returning `'[]'` for the reader's side instead -- which an
  -- earlier draft of the function did -- drops every choice they wrote and turns
  -- their own MCQ into a question with one option.
  ---------------------------------------------------------------------------
  perform pg_temp.as_owner();
  update public.user_questions
     set kind = 'mcq', options = '["a wrong one","another wrong one"]'::jsonb
   where id = own_1;
  perform pg_temp.become(reader_a);

  select e -> 'questions' into qs
    from jsonb_array_elements(public.get_due_reviews(50)) e
   where e ->> 'pullId' = pull_1::text;

  if qs -> 0 ->> 'source' <> 'user' then
    raise exception 'the reader''s own question is no longer first';
  end if;
  if jsonb_array_length(qs -> 0 -> 'distractors') <> 2 then
    raise exception
      'the reader''s own options did not reach the array as distractors (got %). '
      'Their MCQ would render with one option.', qs -> 0 -> 'distractors';
  end if;

  perform pg_temp.as_owner();
  update public.user_questions set kind = 'recall', options = '[]'::jsonb where id = own_1;
  perform pg_temp.become(reader_a);

  ---------------------------------------------------------------------------
  -- 7. A QUESTION IS THE READER'S OWN.
  --
  -- AND RLS IS WHAT MAKES IT SO, not the `uq.user_id = uid` in the function. Deleting
  -- that predicate does not change what a reader sees and does not fail this section:
  -- `get_due_reviews` is `security invoker`, so `user_questions_read_own` has already
  -- refused B every one of A's rows before the predicate is reached. Measured by
  -- mutation, and recorded because the opposite belief is the dangerous one -- a
  -- future `security definer` rewrite of this function would silently turn the
  -- redundant predicate into the only thing standing between two readers, and whoever
  -- makes that change should know the policy is load-bearing here.
  --
  -- The assertion stays as an end-to-end guard on the property itself, which is what
  -- a reader cares about and is true however it is enforced.
  ---------------------------------------------------------------------------
  perform pg_temp.become(reader_b);

  insert into public.knowledge_states (user_id, pull_id, acquired_via, next_due_at)
  values (reader_b, pull_1, 'saved', now() - interval '1 hour');

  select e -> 'questions' into qs
    from jsonb_array_elements(public.get_due_reviews(50)) e
   where e ->> 'pullId' = pull_1::text;

  select count(*) into n
    from jsonb_array_elements(qs) e where e ->> 'source' = 'user';
  if n <> 0 then
    raise exception 'B was asked % of A''s own questions', n;
  end if;

  if exists (select 1 from jsonb_array_elements(qs) e
              where e ->> 'id' in (own_1::text, own_2::text)) then
    raise exception 'A''s question id reached B''s review';
  end if;

  -- B still gets the canonical ones, which are the catalogue's.
  if jsonb_array_length(qs) <> 3 then
    raise exception 'B should be asked the three canonical questions, got %',
      jsonb_array_length(qs);
  end if;

  ---------------------------------------------------------------------------
  -- 8. `user_questions` BOUNDS.
  ---------------------------------------------------------------------------
  begin
    insert into public.user_questions (user_id, pull_id, kind, prompt, explanation)
    values (reader_b, pull_1, 'recall', 'p', repeat('x', 2001));
    raise exception 'a 2001-character explanation was accepted on user_questions';
  exception when check_violation then null;
  end;

  begin
    insert into public.user_questions (user_id, pull_id, kind, prompt, cloze)
    values (reader_b, pull_1, 'recall', 'p', repeat('x', 1001));
    raise exception 'a 1001-character cloze was accepted on user_questions';
  exception when check_violation then null;
  end;

  begin
    insert into public.user_questions (user_id, pull_id, kind, prompt, cloze)
    values (reader_b, pull_1, 'cloze', 'p', '  ');
    raise exception 'a reader''s cloze with no blank was accepted';
  exception when check_violation then null;
  end;

  -- And the four kinds a reader may write are still four: `ordering` and `scenario`
  -- are generated forms the "Remember this" box cannot express.
  begin
    insert into public.user_questions (user_id, pull_id, kind, prompt)
    values (reader_b, pull_1, 'ordering', 'p');
    raise exception 'a reader wrote an ordering question';
  exception when check_violation then null;
  end;

  perform pg_temp.as_owner();
  raise notice 'questions.sql: all assertions passed';
end $$;

rollback;
