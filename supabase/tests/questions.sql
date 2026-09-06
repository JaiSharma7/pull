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
--   * `distractors` and `rationale` refuse a non-array, refuse an enormous one AND
--     refuse a ninth entry -- the count bound and the byte bound are separate, and one
--     huge element trips only the second
--   * `prompt` and `answer` are length-bounded on `quiz_questions` too
--   * `explanation` and `cloze` are length-bounded on BOTH tables
--   * a reader's own question is theirs alone: B's `get_due_reviews` on the same
--     pull never carries A's question -- and see the note below on WHERE that comes
--     from, which is not where the function's own text suggests
--   * a due card whose pull the reader cannot READ does not consume a slot in the
--     page: the visibility joins run before the limit, not after it
--   * a reader's own questions are bounded per BRANCH, so however many they write
--     about one idea, `get_due_reviews` builds three
--   * a question graded by comparison -- `mcq`, `cloze` -- cannot be stored with no
--     answer to compare against, and BOTH self-graded kinds keep the optional one
--   * "blank" means any whitespace, not just spaces: a tab is not an answer
--   * `remember_pull` can still write every kind `user_questions_kind_known` permits --
--     a constraint the only writer cannot satisfy is an unusable RPC, not a guard
--   * every lookup of a card under test goes through `pg_temp.questions_for`, which
--     raises rather than returning NULL: an assertion against NULL takes no branch and
--     passes without testing anything
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

/*
 * The `questions` array for one pull, or an exception naming the section that asked.
 *
 * A plain `select ... into qs where pullId = ...` leaves `qs` NULL when the card is not
 * in the page, and every `if qs -> 0 ->> 'source' <> 'user'` against NULL is NULL --
 * so no branch is taken and the section passes having asserted nothing. That is
 * reachable here rather than theoretical: by section 6 reader A holds 161 due cards,
 * `knowledge_states` defaults to `stability 1.0` and `last_seen_at now()`, `now()` is
 * the transaction timestamp, and `retrievability` is therefore exactly 1.0 for every
 * one of them -- so `order by retrievability asc limit 50` picks fifty under an
 * unspecified tiebreak. Today's plan happens to keep the first-inserted row; that is a
 * property of the plan, not of the fixture.
 */
create or replace function pg_temp.questions_for(p_pull uuid, p_where text)
returns jsonb
language plpgsql as $fn$
declare
  found jsonb;
begin
  select e -> 'questions' into found
    from jsonb_array_elements(public.get_due_reviews(100)) e
   where e ->> 'pullId' = p_pull::text;

  if found is null then
    raise exception
      '%: the pull under test is not in the page, so every assertion below it would '
      'have compared against NULL and passed without testing anything.', p_where;
  end if;
  return found;
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
  hidden_work    uuid := extensions.gen_random_uuid();
  hidden_summary uuid := extensions.gen_random_uuid();
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

  -- A pull with NO canonical question, because section 1 writes one of each kind onto
  -- it. Without the guard this drew any published pull at random -- `pulls.id` is a
  -- fresh `gen_random_uuid()` on every `db:reset`, so `order by p.id` is a fresh draw --
  -- and 14 of the 34 seeded published pulls already carry a `recall` question. Landing
  -- on one made the six-kinds insert hit `quiz_questions_pull_kind_key` with an
  -- UNCAUGHT `unique_violation` and abort the whole file, about one reset in six.
  select p.id into pull_2
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.status = 'published' and s.visibility = 'public' and p.id <> pull_1
     and not exists (select 1 from public.quiz_questions q where q.pull_id = p.id)
   order by p.id
   limit 1;

  if pull_2 is null then
    raise exception 'the seed has no published pull without a canonical question';
  end if;

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

  -- A cloze with nothing to fill in -- spaces, and then the whitespace that is not a
  -- space. One-argument `btrim` strips spaces only, so a cloze of a single newline
  -- passed as "has its blank" and rendered a prompt with no gap in it. A mutation run
  -- found this half missing: reverting the check to `length(btrim(cloze)) > 0` passed
  -- the whole file on the spaces case alone.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, cloze)
    values (pull_2, 'p', 'a', 'cloze', '   ');
    raise exception 'a cloze with a blank cloze was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, cloze)
    values (pull_2, 'p', 'a', 'cloze', E'\t\n');
    raise exception 'a cloze of whitespace was accepted';
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

  -- And an enormous rationale, which the header claimed was covered and was not. Both
  -- size halves of `quiz_questions_rationale_shape` could be deleted and the file passed.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, rationale)
    values (pull_2, 'p', 'a', 'recall',
            jsonb_build_array(jsonb_build_object('distractor', 'd', 'why', repeat('x', 25000))));
    raise exception 'a 25 kB rationale was accepted';
  exception when check_violation then null;
  end;

  -- THE COUNT BOUNDS, separately from the byte bounds. The "enormous" cases above are
  -- one huge element each, so they trip `length(...::text) <= 20000` and never
  -- `jsonb_array_length(...) <= 8`. Nine small entries is the other half.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, distractors)
    values (pull_2, 'p', 'a', 'recall',
            (select jsonb_agg('d' || g) from generate_series(1, 9) g));
    raise exception 'nine distractors were accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind, rationale)
    values (pull_2, 'p', 'a', 'recall',
            (select jsonb_agg(jsonb_build_object('distractor', 'd' || g, 'why', 'w'))
               from generate_series(1, 9) g));
    raise exception 'nine rationale entries were accepted';
  exception when check_violation then null;
  end;

  -- The prompt and answer bounds, which were the one pair of new bounds with nothing
  -- behind them at all.
  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind)
    values (pull_2, repeat('p', 2001), 'a', 'recall');
    raise exception 'a 2001-character prompt was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.quiz_questions (pull_id, prompt, answer, kind)
    values (pull_2, 'p', repeat('a', 2001), 'recall');
    raise exception 'a 2001-character answer was accepted';
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

  qs := pg_temp.questions_for(pull_1, 'section 5 (a retired question falls out)');

  if qs -> 0 ->> 'id' <> own_2::text then
    raise exception 'the newer of A''s own questions is not asked first';
  end if;

  update public.user_questions set retired_at = now() where id = own_2;

  qs := pg_temp.questions_for(pull_1, 'section 5 (the newer question is asked first)');

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

  qs := pg_temp.questions_for(pull_1, 'section 6b (a reader''s own options reach the array)');

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
  -- 6c. AN UNREADABLE PULL DOES NOT EAT THE PAGE.
  --
  -- Review finding, and a regression this migration introduced: moving the `limit`
  -- inside is right, but leaving the RLS-filtered joins on `pulls`/`summaries`/
  -- `works` OUTSIDE it means a due row the reader can no longer see takes a slot and
  -- is then dropped. Measured before the fix: a reader with 30 readable cards due and
  -- 30 unreadable ones sorting ahead of them got 0 back from `get_due_reviews(20)` --
  -- Review would have said nothing was due.
  ---------------------------------------------------------------------------
  perform pg_temp.as_owner();

  insert into public.works (id, kind, title, slug, rights_status)
  values (hidden_work, 'book', 'Withdrawn', 'questions-test-withdrawn', 'public_domain');

  -- Draft and private with no author: `summary_is_readable` is false, so the pulls
  -- behind it are refused by `pulls_read_via_summary`.
  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title)
  values (hidden_summary, hidden_work, 1, 'draft', 'private', null, 'Withdrawn');

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  select hidden_summary, g, 'withdrawn ' || g, 'gone', 5 from generate_series(1, 40) g;

  -- The lowest retrievability there is, so they sort ahead of everything readable.
  insert into public.knowledge_states
    (user_id, pull_id, acquired_via, next_due_at, stability, last_seen_at)
  select reader_a, p.id, 'saved', now() - interval '1 hour', 0.5, now() - interval '400 days'
    from public.pulls p where p.summary_id = hidden_summary
  on conflict (user_id, pull_id) do nothing;

  perform pg_temp.become(reader_a);

  select count(*) into n from public.pulls p where p.summary_id = hidden_summary;
  if n <> 0 then
    raise exception
      'the fixture is not testing anything: the reader can read % of the withdrawn '
      'pulls, so they were never going to be filtered out', n;
  end if;

  if jsonb_array_length(public.get_due_reviews(20)) <> 20 then
    raise exception
      'unreadable due rows ate the page: asked for 20 and got %. The visibility joins '
      'must run before the limit, not after it.',
      jsonb_array_length(public.get_due_reviews(20));
  end if;

  ---------------------------------------------------------------------------
  -- 6d. A READER CANNOT MAKE THEIR OWN CARD ARBITRARILY EXPENSIVE.
  --
  -- Review finding. `user_questions_insert_own` lets a signed-in caller write as many
  -- questions about one pull as they like, and aggregating them all before keeping
  -- three made `p_limit` no bound on the work: `jsonb_build_object` is in the target
  -- list, so every payload was built and then thrown away. Each branch is bounded
  -- now. Measured at 5,000 questions on one pull: 129.72 ms before, 24.26 ms after.
  --
  -- WHAT THIS SECTION CAN AND CANNOT SHOW, measured by mutation rather than assumed.
  -- Deleting the `limit 3` on the reader's own branch does NOT fail this file: the
  -- union-level limit still trims the array to three, so the ANSWER is unchanged and
  -- only the WORK grows. The per-branch limits are a performance property and the
  -- only honest evidence for them is the timing above; asserting a duration here
  -- would be a flake waiting for a slow runner. So this section pins the answer, and
  -- the two limits are load-bearing for different reasons: remove the union-level one
  -- and the array is wrong (the next mutation proves it), remove a per-branch one and
  -- the array is right and the query is unbounded in the reader's own writes.
  ---------------------------------------------------------------------------
  perform pg_temp.as_owner();
  insert into public.user_questions (user_id, pull_id, kind, prompt, answer)
  select reader_a, pull_1, 'recall', 'bulk question ' || g, 'an answer'
    from generate_series(1, 200) g;
  perform pg_temp.become(reader_a);

  qs := pg_temp.questions_for(pull_1, 'section 6d (a reader cannot make their card expensive)');

  if jsonb_array_length(qs) <> 3 then
    raise exception
      'a pull with 200 of the reader''s own questions returned % of them', 
      jsonb_array_length(qs);
  end if;

  select count(*) into n
    from jsonb_array_elements(qs) e where e ->> 'source' = 'user';
  if n <> 3 then
    raise exception
      'the reader''s own questions did not fill the array when they had 200 (got %)', n;
  end if;

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

  qs := pg_temp.questions_for(pull_1, 'section 7 (a question is the reader''s own)');

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

  -- A READER'S CLOZE WITH NO BLANK IS ACCEPTED, and that is deliberate rather than a
  -- hole. `remember_pull` cannot write the `cloze` column at all, so a rule requiring
  -- one would make `kind = 'cloze'` unwritable through the only RPC that writes these
  -- rows -- 23514 on every call, for a kind `user_questions_kind_known` permits. The
  -- rule waits for 2d/2e, alongside a screen that can supply the sentence. Asserted so
  -- that adding it back without a writer fails here rather than in production.
  if (public.remember_pull(pull_1, 'The obstacle is the ___', 'way', 'cloze',
                           extensions.gen_random_uuid()) ->> 'questionId') is null then
    raise exception 'remember_pull could not write a cloze question';
  end if;

  -- The reader's cloze is still LENGTH-bounded, which is the half that is satisfiable
  -- without a writer for the column.
  begin
    insert into public.user_questions (user_id, pull_id, kind, prompt, answer, cloze)
    values (reader_b, pull_1, 'cloze', 'p', 'material', repeat('x', 1001));
    raise exception 'a 1001-character cloze was accepted on user_questions';
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

  -- A KIND GRADED BY COMPARISON NEEDS SOMETHING TO COMPARE AGAINST.
  --
  -- Review finding, reached through the ordinary API: `remember_pull` takes the answer
  -- as optional, so `remember_pull(pull, 'An mcq?', null, 'mcq', id)` stored an `mcq`
  -- with a null answer -- a valid row, returned in the same shape as a canonical
  -- question, on which `mcqOptions` calls `answer.trim()` and throws. `recall` and
  -- `short_answer` are self-graded and keep the optional answer.
  begin
    perform public.remember_pull(pull_1, 'An mcq with no answer?', null, 'mcq',
                                 extensions.gen_random_uuid());
    raise exception 'remember_pull stored an mcq with no answer';
  exception when check_violation then null;
  end;

  begin
    insert into public.user_questions (user_id, pull_id, kind, prompt, answer, cloze)
    values (reader_b, pull_1, 'cloze', 'p', '   ', 'a ____ sentence');
    raise exception 'a cloze with a blank answer was accepted';
  exception when check_violation then null;
  end;

  -- AND "BLANK" MEANS ANY WHITESPACE. One-argument `btrim` strips spaces only, so a tab
  -- or a newline satisfied `length(btrim(answer)) > 0` and stored a graded question with
  -- nothing to grade against -- the reader then gets an option-less MCQ rather than the
  -- exception the constraint was added to prevent, which is quieter and no better.
  begin
    insert into public.user_questions (user_id, pull_id, kind, prompt, answer)
    values (reader_b, pull_1, 'mcq', 'p', E'\t');
    raise exception 'an mcq answered with a tab was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.user_questions (user_id, pull_id, kind, prompt, answer)
    values (reader_b, pull_1, 'mcq', 'p', E'\n  \r');
    raise exception 'an mcq answered with newlines was accepted';
  exception when check_violation then null;
  end;

  -- BOTH self-graded kinds keep the optional answer, and both are asserted. A reader
  -- who writes a prompt and reveals from memory has nothing to store.
  --
  -- `short_answer` was claimed as covered and was not: narrowing the exemption to
  -- `kind in ('recall')` passed the whole file, and a reader's self-graded short answer
  -- would have started being refused by `remember_pull` in production. That is exactly
  -- the asymmetry this PR's own merge commit argues about the kind check -- assert what
  -- is ACCEPTED, not only what is refused -- and it was not applied here.
  if (public.remember_pull(pull_1, 'A recall with no answer?', null, 'recall',
                           extensions.gen_random_uuid()) ->> 'questionId') is null then
    raise exception 'a recall question with no answer was refused';
  end if;
  if (public.remember_pull(pull_1, 'A short answer with none stored?', null, 'short_answer',
                           extensions.gen_random_uuid()) ->> 'questionId') is null then
    raise exception 'a short_answer question with no answer was refused';
  end if;

  perform pg_temp.as_owner();
  raise notice 'questions.sql: all assertions passed';
end $$;

rollback;
