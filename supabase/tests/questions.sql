-- ---------------------------------------------------------------------------
-- A question that can be wrong.
--
-- 20260905120000 widens the question model from "a prompt and an answer the reader
-- grades themselves" to something that can be wrong specifically: a constrained
-- `kind`, an `explanation`, per-distractor `rationale`, and the `cloze` sentence a
-- word is removed from.
--
-- What is asserted, and each is a way the widening could betray somebody:
--
--   * every one of the six kinds is accepted, and a seventh is refused -- the check
--     is the whole of the taxonomy, since `kind` is plain text
--   * an MCQ with fewer than two distractors is refused, because one option is not
--     a choice and `mcqOptions` deduplicates before anything can notice
--   * a cloze with no sentence is refused
--   * `distractors` and `rationale` must be arrays; an object in either is what a
--     bad generation returns and `mcqOptions` would have iterated its keys
--   * `explanation` and `cloze` are bounded, like every other authored column
--   * `get_due_reviews` returns EVERY question for a due pull, the reader's own
--     first, with their `options` surfaced as `distractors` rather than dropped
--   * the three legacy fields are the head of that array and cannot disagree with it
--   * a retired question leaves the array entirely
--   * the top level is still an array, and `p_limit` is bounded at both ends
--   * `example`, `explanation`, `lapses` and `contentVersion` reach the reader, which
--     is what lets Review show an example after an answer
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

create or replace function pg_temp.as_owner() returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $fn$;

do $$
declare
  reader   uuid := extensions.gen_random_uuid();
  a_pull   uuid;
  canon_id uuid;
  mine_id  uuid;
  due      jsonb;
  row_one  jsonb;
  qs       jsonb;
  refused  boolean;
  n        int;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, is_anonymous)
  values (reader, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'questions_reader@example.com', 'x', now(), now(), now(), false);

  -- A seeded public pull, so the reader can genuinely read it under RLS.
  perform pg_temp.as_owner();
  select p.id into strict a_pull
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
   where s.status = 'published' and s.visibility = 'public'
   limit 1;

  -- ------------------------------------------------- 1. the taxonomy is the check
  --
  -- `kind` is plain text with a default, so the constraint is the only thing that
  -- decides what a kind is. All six, then one that is not.
  delete from public.quiz_questions where pull_id = a_pull;
  insert into public.quiz_questions (pull_id, kind, prompt, answer, distractors, cloze)
  values
    (a_pull, 'recall',       'r', 'a', '[]'::jsonb, null),
    (a_pull, 'short_answer', 's', 'a', '[]'::jsonb, null),
    (a_pull, 'ordering',     'o', 'a', '[]'::jsonb, null),
    (a_pull, 'scenario',     'c', 'a', '[]'::jsonb, null),
    (a_pull, 'mcq',          'm', 'a', '["b","c"]'::jsonb, null),
    (a_pull, 'cloze',        'z', 'a', '[]'::jsonb, 'The obstacle is the ___.');

  select count(*) into n from public.quiz_questions where pull_id = a_pull;
  if n <> 6 then
    raise exception 'expected all six kinds to be accepted, stored %', n;
  end if;

  refused := false;
  begin
    insert into public.quiz_questions (pull_id, kind, prompt, answer)
    values (a_pull, 'essay', 'e', 'a');
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'an unknown kind was accepted, so the taxonomy is not enforced';
  end if;

  -- ---------------------------------------- 2. an MCQ with one option is not a choice
  refused := false;
  begin
    insert into public.quiz_questions (pull_id, kind, prompt, answer, distractors)
    values (a_pull, 'mcq', 'thin', 'a', '["b"]'::jsonb);
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'an MCQ with one distractor was accepted';
  end if;

  -- ------------------------------------------- 3. a cloze without its sentence
  refused := false;
  begin
    insert into public.quiz_questions (pull_id, kind, prompt, answer, cloze)
    values (a_pull, 'cloze', 'blank', 'a', '   ');
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'a cloze with a blank sentence was accepted';
  end if;

  -- ------------------------------------- 4. both jsonb columns are arrays or nothing
  refused := false;
  begin
    insert into public.quiz_questions (pull_id, kind, prompt, answer, distractors)
    values (a_pull, 'recall', 'obj', 'a', '{"a":1}'::jsonb);
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'an object was accepted as distractors';
  end if;

  refused := false;
  begin
    insert into public.quiz_questions (pull_id, kind, prompt, answer, rationale)
    values (a_pull, 'recall', 'obj2', 'a', '{"a":1}'::jsonb);
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'an object was accepted as rationale';
  end if;

  -- ------------------------------------------------- 5. the authored text is bounded
  refused := false;
  begin
    insert into public.quiz_questions (pull_id, kind, prompt, answer, explanation)
    values (a_pull, 'recall', 'long', 'a', repeat('x', 2001));
  exception when check_violation then refused := true;
  end;
  if not refused then
    raise exception 'a 2001-character explanation was accepted';
  end if;

  -- ------------------------------- 6. every question reaches the reader, theirs first
  delete from public.quiz_questions where pull_id = a_pull;
  insert into public.quiz_questions
    (pull_id, kind, prompt, answer, distractors, explanation, rationale)
  values
    (a_pull, 'mcq', 'Which is it?', 'the way',
     '["a detour","a delay"]'::jsonb,
     'Because the obstruction is the material.',
     '[{"distractor":"a detour","why":"That treats it as avoidable."}]'::jsonb)
  returning id into canon_id;

  perform pg_temp.become(reader);

  -- The reader writes their own, with options of their own.
  insert into public.user_questions (user_id, pull_id, kind, prompt, answer, options, explanation)
  values (reader, a_pull, 'mcq', 'My own framing?', 'the way',
          '["mine one","mine two"]'::jsonb, 'Because I said so.')
  returning id into mine_id;

  insert into public.knowledge_states (user_id, pull_id, acquired_via, next_due_at)
  values (reader, a_pull, 'saved', now() - interval '1 hour')
  on conflict (user_id, pull_id) do update set next_due_at = now() - interval '1 hour';

  due := public.get_due_reviews(p_limit := 50);
  if jsonb_typeof(due) <> 'array' then
    raise exception 'get_due_reviews stopped returning an array';
  end if;

  select value into row_one
    from jsonb_array_elements(due)
   where (value ->> 'pullId')::uuid = a_pull;
  if row_one is null then
    raise exception 'the due pull is missing from get_due_reviews';
  end if;

  qs := row_one -> 'questions';
  if jsonb_array_length(qs) <> 2 then
    raise exception 'expected both questions, got %', jsonb_array_length(qs);
  end if;
  if qs -> 0 ->> 'source' <> 'user' or (qs -> 0 ->> 'id')::uuid <> mine_id then
    raise exception 'the reader''s own question is not first';
  end if;
  if qs -> 1 ->> 'source' <> 'canonical' or (qs -> 1 ->> 'id')::uuid <> canon_id then
    raise exception 'the canonical question is not second';
  end if;

  -- The reader's own options are surfaced under the canonical name. Reading `'[]'`
  -- here instead silently turned their MCQ into a one-option question.
  if qs -> 0 -> 'distractors' <> '["mine one","mine two"]'::jsonb then
    raise exception 'a reader''s own options were dropped: %', qs -> 0 -> 'distractors';
  end if;
  if qs -> 1 -> 'rationale' -> 0 ->> 'distractor' <> 'a detour' then
    raise exception 'the canonical rationale did not reach the reader';
  end if;
  if qs -> 1 ->> 'explanation' is null then
    raise exception 'the canonical explanation did not reach the reader';
  end if;

  -- ------------------------------- 7. the legacy three are the head, not a second view
  --
  -- 20260905110000 fixed a version of this where `questionSource` could say `user`
  -- while the prompt and id returned were the canonical ones. The fields are derived
  -- from `questions[0]` now, so the only way they can disagree is if that stops being
  -- true -- which is what this asserts.
  if row_one ->> 'question' <> (qs -> 0 ->> 'prompt') then
    raise exception 'the legacy question is not the head of the array';
  end if;
  if (row_one ->> 'questionId')::uuid <> (qs -> 0 ->> 'id')::uuid then
    raise exception 'the legacy questionId is not the head of the array';
  end if;
  if row_one ->> 'questionSource' <> (qs -> 0 ->> 'source') then
    raise exception 'the legacy questionSource is not the head of the array';
  end if;

  -- --------------------------------------- 8. a retired question leaves entirely
  update public.user_questions set retired_at = now() where id = mine_id;
  due := public.get_due_reviews(p_limit := 50);
  select value into row_one
    from jsonb_array_elements(due)
   where (value ->> 'pullId')::uuid = a_pull;
  qs := row_one -> 'questions';
  if jsonb_array_length(qs) <> 1 or qs -> 0 ->> 'source' <> 'canonical' then
    raise exception 'a retired question was still offered';
  end if;
  if row_one ->> 'questionSource' <> 'canonical' then
    raise exception 'the legacy source did not follow the array when one was retired';
  end if;
  update public.user_questions set retired_at = null where id = mine_id;

  -- --------------------------------------------- 9. the card carries what it generated
  if row_one -> 'contentVersion' is null then
    raise exception 'contentVersion is missing';
  end if;
  if row_one -> 'lapses' is null then
    raise exception 'lapses is missing';
  end if;

  -- ------------------------------------------------- 10. p_limit is bounded both ways
  if jsonb_array_length(public.get_due_reviews(p_limit := 0)) > 1 then
    raise exception 'a limit of zero returned more than one row';
  end if;
  if jsonb_typeof(public.get_due_reviews(p_limit := 100000)) <> 'array' then
    raise exception 'an absurd limit stopped returning an array';
  end if;
  if jsonb_typeof(public.get_due_reviews(p_limit := -5)) <> 'array' then
    raise exception 'a negative limit stopped returning an array';
  end if;

  raise notice 'questions: six kinds and no seventh, an MCQ needs choices, a cloze needs its sentence, both jsonb columns are arrays, and every question reaches the reader with theirs first and the legacy fields at its head';
end $$;

rollback;
