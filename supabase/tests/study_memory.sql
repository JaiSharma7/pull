-- The study Delta (20260925210000): the memory of each claim and what reads as known from
-- it. False suppression is the first risk, so most of this is what must NOT make a lesson
-- read as known. Reader paths run as `authenticated` under RLS.
begin;

create or replace function pg_temp.become_reader(p_uid uuid)
returns void language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', false)::text, true);
  if current_user <> 'authenticated' then
    raise exception 'RLS assertions must run as authenticated, not %', current_user;
  end if;
end $fn$;

create or replace function pg_temp.become_worker()
returns void language plpgsql as $fn$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
end $fn$;

create or replace function pg_temp.as_owner()
returns void language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $fn$;

grant execute on function pg_temp.become_reader(uuid) to authenticated, service_role;
grant execute on function pg_temp.become_worker() to authenticated, service_role;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

create or replace function pg_temp.claim(
  p_key text, p_version uuid, p_statement text, p_span text, p_note text
)
returns jsonb language sql as $fn$
  select jsonb_build_object(
    'key', p_key, 'sourceVersionId', p_version, 'kind', 'finding', 'statement', p_statement,
    'status', 'draft',
    'evidence', jsonb_build_array(jsonb_build_object(
      'modelQuote', p_span, 'spanText', p_span, 'start', position(p_span in p_note) - 1,
      'end', position(p_span in p_note) - 1 + char_length(p_span), 'match', 'exact')),
    'provenance', jsonb_build_object('promptHash', repeat('a', 64),
                                      'schemaHash', repeat('b', 64), 'model', 'm'))
$fn$;

create or replace function pg_temp.lesson(p_key text, p_position int, p_claims text[])
returns jsonb language sql as $fn$
  select jsonb_build_object(
    'key', p_key, 'position', p_position, 'unitNo', 1, 'unitTitle', 'Timing',
    'title', 'Lesson ' || p_key, 'objective', 'Explain the contrast.',
    'explanation', 'The result depended on the delay.', 'example', null,
    'recap', 'Timing matters.', 'minutes', 3, 'status', 'draft',
    'claimKeys', to_jsonb(p_claims))
$fn$;

/* A question with every field given, so each kind can be built as it is stored. */
create or replace function pg_temp.q(
  p_key text, p_lesson text, p_kind text, p_prompt text, p_answer text, p_claims text[],
  p_extra jsonb default '{}'::jsonb
)
returns jsonb language sql as $fn$
  select jsonb_build_object(
    'key', p_key, 'lessonKey', p_lesson, 'purpose', 'practice', 'kind', p_kind,
    'prompt', p_prompt, 'answer', p_answer, 'acceptedAnswers', '[]'::jsonb,
    'distractors', '[]'::jsonb, 'cloze', null, 'sequence', '[]'::jsonb,
    'pairs', '[]'::jsonb, 'explanation', 'Because the note says so.', 'difficulty', 1,
    'status', 'draft', 'claimKeys', to_jsonb(p_claims)) || p_extra
$fn$;

grant execute on function pg_temp.claim(text, uuid, text, text, text) to service_role;
grant execute on function pg_temp.lesson(text, int, text[]) to service_role;
grant execute on function pg_temp.q(text, text, text, text, text, text[], jsonb) to service_role;

/* Record one answer and hand back its result, or its refusal. */
create or replace function pg_temp.answer(
  p_item uuid, p_response jsonb, p_self text default null, p_hinted boolean default null,
  p_client uuid default extensions.gen_random_uuid()
)
returns jsonb language sql as $fn$
  select public.record_study_answers(jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'clientEventId', p_client, 'itemId', p_item, 'response', p_response,
    'selfGrade', p_self, 'hinted', p_hinted))))
$fn$;
grant execute on function pg_temp.answer(uuid, jsonb, text, boolean, uuid) to authenticated;

do $test$
declare
  reader   uuid := extensions.gen_random_uuid();
  other    uuid := extensions.gen_random_uuid();
  note     text := 'Roediger and Karpicke had students read prose. On a final test five '
                   'minutes later, the group that restudied remembered more. On final tests '
                   'two days and one week later, the group that had taken the recall test '
                   'remembered more.';
  saved    jsonb;
  v        uuid;
  out      jsonb;
  job      uuid;
  gen      uuid;
  course   uuid;
  l1       uuid;
  l2       uuid;
  l3       uuid;
  c1       uuid;
  c2       uuid;
  q1       uuid;
  q3       uuid;
  q5       uuid;
  q5_mine  uuid;
  q6       uuid;
  q1_mine  uuid;
  rep      uuid;
  r        jsonb;
  st       double precision;
  st0      double precision;
  dif      double precision;
  lsa      timestamptz;
  x        uuid := extensions.gen_random_uuid();
  n        int;
begin
  insert into auth.users
    (id, instance_id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at, is_anonymous,
     raw_app_meta_data, raw_user_meta_data)
  values
    (reader, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'study-memory@example.test', '', now(), now(), now(), false, '{}', '{}'),
    (other, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'study-memory-other@example.test', '', now(), now(), now(), false, '{}', '{}');
  insert into public.study_generation_access (user_id) values (reader);

  perform pg_temp.become_reader(reader);
  saved := public.save_study_source_version('Prose memory', 'paste', note,
                                            extensions.gen_random_uuid());
  v := (saved ->> 'versionId')::uuid;
  out := public.enqueue_study_generation(array[v], 'Explain the argument',
                                         extensions.gen_random_uuid(), true);
  job := (out ->> 'jobId')::uuid;
  gen := (out ->> 'generationId')::uuid;
  course := (out ->> 'courseId')::uuid;

  perform pg_temp.become_worker();
  perform public.persist_study_course(job, jsonb_build_object(
    'course', jsonb_build_object('title', 'Immediate versus delayed',
                                 'objectives', jsonb_build_array('Explain the contrast.')),
    'claims', jsonb_build_array(
      pg_temp.claim('s1c1', v, 'At five minutes, restudying beat the recall test.',
                    'the group that restudied remembered more', note),
      pg_temp.claim('s1c2', v, 'After a week, the recall test group remembered more.',
                    'the group that had taken the recall test remembered more', note)),
    'lessons', jsonb_build_array(
      pg_temp.lesson('l1', 1, array['s1c1']),
      pg_temp.lesson('l2', 2, array['s1c2']),
      pg_temp.lesson('l3', 3, array['s1c1', 's1c2'])),
    'items', jsonb_build_array(
      pg_temp.q('q1', 'l2', 'multiple_choice', 'Which group remembered more after a week?',
                'The recall test group', array['s1c2'], jsonb_build_object('distractors',
                  jsonb_build_array(
                    jsonb_build_object('text', 'The restudy group', 'why', 'Only at five minutes.'),
                    jsonb_build_object('text', 'Neither group', 'why', 'The note reports a difference.')))),
      pg_temp.q('q3', 'l1', 'short_recall', 'Which strategy won at five minutes?',
                'restudying', array['s1c1']),
      pg_temp.q('q5', 'l1', 'short_recall', 'What did the winning group do at five minutes?',
                'restudied', array['s1c1']),
      -- Never answered: never due, whatever its claim's memory says.
      pg_temp.q('q6', 'l1', 'multiple_choice', 'Which won at five minutes?', 'Restudying',
                array['s1c1'], jsonb_build_object('distractors', jsonb_build_array(
                  jsonb_build_object('text', 'Testing', 'why', 'Only later.'),
                  jsonb_build_object('text', 'Neither', 'why', 'One won.'))))),
    'provenance', jsonb_build_object('promptHash', repeat('a', 64),
                                     'schemaHash', repeat('b', 64), 'model', 'm')));
  perform public.validate_study_course(job);
  perform pg_temp.as_owner();
  update public.generation_jobs set status = 'succeeded' where id = job;

  select id into l1 from public.study_lessons where generation_id = gen and lesson_key = 'l1';
  select id into l2 from public.study_lessons where generation_id = gen and lesson_key = 'l2';
  select id into l3 from public.study_lessons where generation_id = gen and lesson_key = 'l3';
  select id into c1 from public.study_claims where generation_id = gen and claim_key = 's1c1';
  select id into c2 from public.study_claims where generation_id = gen and claim_key = 's1c2';
  select id into q1 from public.study_items where generation_id = gen and item_key = 'q1';
  select id into q3 from public.study_items where generation_id = gen and item_key = 'q3';
  select id into q5 from public.study_items where generation_id = gen and item_key = 'q5';
  select id into q6 from public.study_items where generation_id = gen and item_key = 'q6';
  if (select count(*) from public.study_lessons
      where generation_id = gen and status = 'validated') is distinct from 3::bigint
     or (select count(*) from public.study_items
         where generation_id = gen and status = 'validated') is distinct from 4::bigint then
    raise exception 'the fixture did not validate as expected';
  end if;

  perform pg_temp.become_reader(reader);
  if exists (select 1 from public.study_course_outline(course) where known or revisit or faded) then
    raise exception 'a lesson read as known, to revisit or faded before anything was answered';
  end if;

  -- A reader's own revision of a lesson can add to what it must be known by, never take away:
  -- re-citing a proven claim does not make an unstudied lesson known. Probed, and undone.
  begin
    perform pg_temp.answer(q1, '"The recall test group"');
    perform public.revise_study_lesson(l1, jsonb_build_object('claimIds', jsonb_build_array(c2)));
    if exists (select 1 from public.study_course_outline(course)
               where lesson_key = 'l1' and known) then
      raise exception 'a lesson revised to cite a proven claim read as known unstudied';
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;

  -- ---------------------------------------------------------------- what proves nothing
  -- Exposure.
  perform public.record_study_progress(jsonb_build_array(
    jsonb_build_object('clientEventId', extensions.gen_random_uuid(), 'kind', 'lesson_read',
                       'lessonId', l1)));
  -- A self-graded answer, however right.
  perform pg_temp.answer(q3, '"reading it again"', 'correct');
  -- A hinted one.
  perform pg_temp.answer(q3, '"restudying"', null, true);
  -- An answer to the reader's own version.
  q5_mine := public.revise_study_item(q5, '{"prompt": "What did the group that won at five minutes do?"}');
  perform pg_temp.answer(q5_mine, '"restudied"');
  -- An answer to a question held back by a report -- half an hour on, so it is not hinted by
  -- the self-grade above and it is the holding back, alone, that makes it prove nothing.
  perform pg_temp.as_owner();
  alter table public.study_answer_events disable trigger study_answer_events_are_final;
  update public.study_answer_events set answered_at = clock_timestamp() - interval '31 minutes'
  where owner_id = reader;
  alter table public.study_answer_events enable trigger study_answer_events_are_final;
  perform pg_temp.become_reader(reader);
  rep := public.report_study_content('item', q3, 'ambiguous', null);
  r := pg_temp.answer(q3, '"restudying"');
  if (r -> 'results' -> 0 ->> 'hinted')::boolean is not false then
    raise exception 'the held-back answer was hinted, so it tests nothing: %', r;
  end if;
  perform public.dismiss_study_report(rep);
  if (select known from public.study_course_outline(course) where lesson_id = l1)
     is distinct from false
     or exists (select 1 from public.study_claim_memory where claim_id = c1) then
    raise exception 'exposure, a self-grade, a hint, a reader''s version or a held-back '
                    'question made a lesson read as known';
  end if;

  -- ---------------------------------------------------------------- proof
  -- Half an hour on, so the self-graded answer above -- judged against the course's answer
  -- -- no longer hints the next. Aged as the owner, past the trigger that keeps answers final.
  perform pg_temp.as_owner();
  alter table public.study_answer_events disable trigger study_answer_events_are_final;
  update public.study_answer_events set answered_at = clock_timestamp() - interval '31 minutes'
  where owner_id = reader;
  alter table public.study_answer_events enable trigger study_answer_events_are_final;
  perform pg_temp.become_reader(reader);
  r := pg_temp.answer(q3, '"restudying"');
  if (r -> 'results' -> 0 ->> 'provesRecall')::boolean is not true then
    raise exception 'the proving answer did not prove: %', r;
  end if;
  if (select known from public.study_course_outline(course) where lesson_id = l1)
     is distinct from true then
    raise exception 'a lesson whose claim was proven did not read as known';
  end if;
  -- A lesson with two claims, one proven, is not known -- and not faded: one was never known.
  if (select row(known, faded)::text from public.study_course_outline(course) where lesson_id = l3)
     is distinct from row(false, false)::text then
    raise exception 'a lesson read as known, or faded, with one of its two claims unproven';
  end if;
  -- A question never answered is not due, whatever its claim's memory says.
  if (select due_at from public.study_course_questions(course) where item_id = q6) is not null then
    raise exception 'a question never answered was due';
  end if;
  select stability into st from public.study_claim_memory where claim_id = c1;
  if st is distinct from 2.7::double precision then
    raise exception 'a first success did not grow stability as grade_recall does: %', st;
  end if;
  -- Proving it again the same day is repetition, not spacing.
  perform pg_temp.answer(q3, '"restudying"');
  if (select stability from public.study_claim_memory where claim_id = c1) is distinct from st then
    raise exception 'answering again the same day grew stability';
  end if;
  -- The proof expires with its stability: a month on, it is not known.
  if (select known from public.study_claim_knowledge(course, now() + interval '30 days')
      where claim_id = c1) is distinct from false
     or (select known from public.study_claim_knowledge(course, now() + interval '1 day')
         where claim_id = c1) is distinct from true then
    raise exception 'a proof did not expire with its stability';
  end if;
  -- Due one stability after the success.
  if (select due_at from public.study_course_questions(course) where item_id = q3)
     is distinct from (select last_success_at + make_interval(secs => stability * 86400)
                       from public.study_claim_memory where claim_id = c1) then
    raise exception 'a proven question is not due one stability after its success';
  end if;
  -- Asked about the past, nothing proven since counts; not asked, it is now.
  if (select known from public.study_claim_knowledge(course, now() - interval '1 year')
      where claim_id = c1) is distinct from false
     or (select known from public.study_claim_knowledge(course, null) where claim_id = c1)
        is distinct from true then
    raise exception 'knowledge asked about the past, or about no time, was wrong';
  end if;
  -- Half a day on is still before it is due: repetition, not spacing, however many hours --
  -- a proof every half day compounded stability into years.
  perform pg_temp.as_owner();
  update public.study_claim_memory set last_success_at = last_success_at - interval '13 hours'
  where claim_id = c1;
  perform pg_temp.become_reader(reader);
  perform pg_temp.answer(q3, '"restudying"');
  if (select stability from public.study_claim_memory where claim_id = c1) is distinct from st then
    raise exception 'a success before the claim was due grew stability';
  end if;
  -- Once due, a success is spacing, and stability grows: the last success is set back past
  -- one stability, as the owner, and the claim proven again.
  perform pg_temp.as_owner();
  update public.study_claim_memory set last_success_at = last_success_at - interval '3 days'
  where claim_id = c1;
  perform pg_temp.become_reader(reader);
  perform pg_temp.answer(q3, '"restudying"');
  select stability, last_success_at into st, lsa from public.study_claim_memory where claim_id = c1;
  if abs(st - 2.7 * 2.7) > 1e-9 then
    raise exception 'a success once due did not grow stability: %', st;
  end if;
  -- Known down to the feed Delta's floor and no further: either side of 0.7.
  if (select known from public.study_claim_knowledge(course,
        lsa + make_interval(secs => st * ln(0.75) / ln(0.9) * 86400)) where claim_id = c1)
       is distinct from true
     or (select known from public.study_claim_knowledge(course,
           lsa + make_interval(secs => st * ln(0.65) / ln(0.9) * 86400)) where claim_id = c1)
       is distinct from false then
    raise exception 'knowledge did not end at the retrievability floor';
  end if;
  -- An answer sent twice moves the memory once.
  perform pg_temp.answer(q3, '"restudying"', null, null, x);
  select reps into n from public.study_claim_memory where claim_id = c1;
  perform pg_temp.answer(q3, '"restudying"', null, null, x);
  if (select reps from public.study_claim_memory where claim_id = c1) is distinct from n then
    raise exception 'a duplicate answer moved the memory again';
  end if;

  -- A claim never proven grows on its first success, even after a scored lapse: there is no
  -- stability yet to relearn to. c2's first answer is wrong; half an hour on, it is proven.
  -- Probed, and undone.
  begin
    perform pg_temp.answer(q1, '"The restudy group"');
    select stability, difficulty into st0, dif from public.study_claim_memory where claim_id = c2;
    perform pg_temp.as_owner();
    alter table public.study_answer_events disable trigger study_answer_events_are_final;
    update public.study_answer_events set answered_at = clock_timestamp() - interval '31 minutes'
    where owner_id = reader;
    alter table public.study_answer_events enable trigger study_answer_events_are_final;
    perform pg_temp.become_reader(reader);
    r := pg_temp.answer(q1, '"The recall test group"');
    if (r -> 'results' -> 0 ->> 'provesRecall')::boolean is not true
       or (select stability from public.study_claim_memory where claim_id = c2)
          is distinct from least(730.0, st0 * (2.0 + (1.0 - dif)))
       or (select known from public.study_claim_knowledge(course) where claim_id = c2)
          is distinct from true then
      raise exception 'a first success after a scored lapse did not grow stability: %',
        (select to_jsonb(m) from public.study_claim_memory m where claim_id = c2);
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  perform pg_temp.become_reader(reader);

  r := pg_temp.answer(q1, '"The recall test group"');
  if (select string_agg(known::text, ',' order by lesson_position)
      from public.study_course_outline(course)) is distinct from 'true,true,true' then
    raise exception 'proving every claim did not make every lesson known';
  end if;

  -- A report after the proof withdraws it: the proof is re-read, not remembered.
  rep := public.report_study_content('item', q1, 'ambiguous', null);
  if (select known from public.study_course_outline(course) where lesson_id = l2)
     is distinct from false then
    raise exception 'a proof survived a report of the question that gave it';
  end if;
  perform public.dismiss_study_report(rep);
  if (select known from public.study_course_outline(course) where lesson_id = l2)
     is distinct from true then
    raise exception 'dismissing the report did not restore the proof';
  end if;
  -- And a report of the claim itself: it leaves what the course can say it knows.
  rep := public.report_study_content('claim', c2, 'ambiguous', null);
  if exists (select 1 from public.study_claim_knowledge(course) where claim_id = c2) then
    raise exception 'a claim held back by a report stayed in what the course says it knows';
  end if;
  -- Held back, it is not known -- it does not drop out of a lesson and leave the rest to call
  -- it known. A lesson that cites it is held back with it; one revised to leave it out still
  -- counts it, as every claim any version cited. Probed, and undone.
  begin
    perform public.revise_study_lesson(l3, jsonb_build_object('claimIds', jsonb_build_array(c1)));
    if (select known from public.study_course_outline(course) where lesson_key = 'l3')
       is distinct from false then
      raise exception 'a lesson read as known with a claim an earlier version cited held back';
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  perform public.dismiss_study_report(rep);
  if (select known from public.study_claim_knowledge(course) where claim_id = c2)
     is distinct from true then
    raise exception 'dismissing the claim''s report did not restore the proof';
  end if;
  -- A claim withdrawn for good is no longer part of a lesson an earlier version of which cited
  -- it: the lesson revised to leave it out is known by the rest. Probed, and undone.
  begin
    perform public.revise_study_lesson(l3, jsonb_build_object('claimIds', jsonb_build_array(c1)));
    perform public.retire_study_content('claim', c2);
    if (select known from public.study_course_outline(course) where lesson_key = 'l3')
       is distinct from true then
      raise exception 'a withdrawn claim still counted in a lesson that had left it out';
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  -- No moment asked about is out of range.
  perform count(*) from public.study_claim_knowledge(course, '294276-12-31T23:59:59Z');
  -- Stability is capped at two years, and grows only once due. Probed, and undone.
  begin
    perform pg_temp.as_owner();
    update public.study_claim_memory
       set stability = 700, last_success_at = last_success_at - interval '800 days'
     where claim_id = c1;
    alter table public.study_answer_events disable trigger study_answer_events_are_final;
    update public.study_answer_events set answered_at = clock_timestamp() - interval '31 minutes'
    where owner_id = reader;
    alter table public.study_answer_events enable trigger study_answer_events_are_final;
    perform pg_temp.become_reader(reader);
    r := pg_temp.answer(q3, '"restudying"');
    if (select stability from public.study_claim_memory where claim_id = c1) <> 730 then
      raise exception 'stability grew past its cap: %', r;
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  perform pg_temp.become_reader(reader);

  -- ---------------------------------------------------------------- a lapse
  -- A wrong answer to the reader's own version is word that they do not have it now, though
  -- no evidence to schedule by. Probed, and undone.
  begin
    perform pg_temp.answer(q5_mine, '"memorised it"', 'incorrect');
    if (select known from public.study_course_outline(course) where lesson_id = l1)
       is distinct from false
       or (select row(last_outcome, stability, difficulty, lapses)::text
           from public.study_claim_memory where claim_id = c1)
          is distinct from row('lapse', st, 0.3, 0)::text then
      raise exception 'a wrong answer to the reader''s own version left the lesson known, or '
                      'moved more: %',
        (select to_jsonb(m) from public.study_claim_memory m where claim_id = c1);
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  -- l1 read again after its claim was proven, and before the "not had" below: worth
  -- rereading is timed by the lapse, not the proof.
  perform public.record_study_progress(jsonb_build_array(
    jsonb_build_object('clientEventId', extensions.gen_random_uuid(), 'kind', 'lesson_read',
                       'lessonId', l1)));
  -- So is their own "not had": it takes the knowledge away, and moves nothing else. A claim
  -- tested only by short answers could otherwise never be un-known.
  perform pg_temp.answer(q3, '"memorising it"', 'incorrect');
  if (select known from public.study_course_outline(course) where lesson_id = l1)
       is distinct from false
     or (select row(last_outcome, stability, lapses)::text from public.study_claim_memory
         where claim_id = c1) is distinct from row('lapse', st, 0)::text then
    raise exception 'a self-graded "not had" did not take the knowledge away, or moved more: %',
      (select to_jsonb(m) from public.study_claim_memory m where claim_id = c1);
  end if;
  -- And it does not prime the next success to grow stability: a "not had" every day, then a
  -- proof, compounded a claim the reader keeps missing into years. Probed, and undone.
  begin
    perform pg_temp.as_owner();
    alter table public.study_answer_events disable trigger study_answer_events_are_final;
    update public.study_answer_events set answered_at = clock_timestamp() - interval '31 minutes'
    where owner_id = reader;
    alter table public.study_answer_events enable trigger study_answer_events_are_final;
    perform pg_temp.become_reader(reader);
    r := pg_temp.answer(q3, '"restudying"');
    if (r -> 'results' -> 0 ->> 'provesRecall')::boolean is not true
       or (select stability from public.study_claim_memory where claim_id = c1)
          is distinct from st then
      raise exception 'a proof after "not had" grew stability before the claim was due: %',
        (select to_jsonb(m) from public.study_claim_memory m where claim_id = c1);
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  perform pg_temp.become_reader(reader);
  -- A proof after a lapse is relearning, not spacing, however due the claim was: a reader
  -- missing it at every due review and proving it half an hour later would be sent past it
  -- for years. The "not had" above lapsed c1; it is set past due, and proven again. Probed,
  -- and undone.
  begin
    perform pg_temp.as_owner();
    update public.study_claim_memory set last_success_at = last_success_at - interval '30 days'
    where claim_id = c1;
    alter table public.study_answer_events disable trigger study_answer_events_are_final;
    update public.study_answer_events set answered_at = clock_timestamp() - interval '31 minutes'
    where owner_id = reader;
    alter table public.study_answer_events enable trigger study_answer_events_are_final;
    perform pg_temp.become_reader(reader);
    r := pg_temp.answer(q3, '"restudying"');
    if (r -> 'results' -> 0 ->> 'provesRecall')::boolean is not true
       or (select stability from public.study_claim_memory where claim_id = c1)
          is distinct from st then
      raise exception 'a proof after a lapse at the due review grew stability: %',
        (select to_jsonb(m) from public.study_claim_memory m where claim_id = c1);
    end if;
    -- Relearnt: known again, and not due until a stability on.
    if (select known from public.study_claim_knowledge(course) where claim_id = c1)
       is distinct from true
       or (select due from public.study_course_questions(course) where item_id = q3)
          is distinct from false then
      raise exception 'a proof after a lapse did not bring the claim back: %',
        (select to_jsonb(m) from public.study_claim_memory m where claim_id = c1);
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  perform pg_temp.become_reader(reader);
  -- A "not had" is when the claim was last answered: due half an hour on.
  if (select due_at from public.study_course_questions(course) where item_id = q3)
     is distinct from (select max(answered_at) + interval '30 minutes' from public.study_answer_events
                       where item_id = q3 and grading = 'self' and not correct) then
    raise exception 'a "not had" did not move when the claim is due';
  end if;
  -- A wrong answer to the reader's own version of a multiple-choice question -- graded by
  -- the rule, but not the model's -- is not scored. Probed, and undone.
  begin
    q1_mine := public.revise_study_item(q1, '{"prompt": "After a week, who remembered more?"}');
    perform pg_temp.answer(q1_mine, '"The restudy group"');
    if (select row(last_outcome, lapses, difficulty)::text from public.study_claim_memory
        where claim_id = c2) is distinct from row('lapse', 0, 0.3)::text then
      raise exception 'a wrong answer to the reader''s own version was scored: %',
        (select to_jsonb(m) from public.study_claim_memory m where claim_id = c2);
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  -- A wrong answer to a question the reader has said is wrong is not scored: word that they
  -- do not have it, not evidence to schedule by. Probed, and undone.
  begin
    rep := public.report_study_content('item', q1, 'incorrect', null);
    perform pg_temp.answer(q1, '"The restudy group"');
    if (select row(last_outcome, lapses, difficulty)::text from public.study_claim_memory
        where claim_id = c2) is distinct from row('lapse', 0, 0.3)::text then
      raise exception 'a wrong answer to a question held back was scored: %',
        (select to_jsonb(m) from public.study_claim_memory m where claim_id = c2);
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  perform pg_temp.answer(q1, '"The restudy group"');
  if (select known from public.study_course_outline(course) where lesson_id = l2)
     is distinct from false
     or (select known from public.study_course_outline(course) where lesson_id = l3)
        is distinct from false
     or (select row(lapses, stability, difficulty)::text from public.study_claim_memory
         where claim_id = c2) is distinct from row(1, 2.7 * 0.35, 0.3 + 0.15)::text then
    raise exception 'a wrong answer did not take the claim''s knowledge away at once: %',
      (select jsonb_agg(to_jsonb(o)) from public.study_course_outline(course) o);
  end if;
  -- The same after a scored lapse: proven half an hour on -- the answer it was just shown --
  -- the claim relearns, and stability stays as the lapse cut it. Probed, and undone.
  begin
    perform pg_temp.as_owner();
    update public.study_claim_memory set last_success_at = last_success_at - interval '30 days'
    where claim_id = c2;
    alter table public.study_answer_events disable trigger study_answer_events_are_final;
    update public.study_answer_events set answered_at = clock_timestamp() - interval '31 minutes'
    where owner_id = reader;
    alter table public.study_answer_events enable trigger study_answer_events_are_final;
    perform pg_temp.become_reader(reader);
    r := pg_temp.answer(q1, '"The recall test group"');
    if (r -> 'results' -> 0 ->> 'provesRecall')::boolean is not true
       or (select stability from public.study_claim_memory where claim_id = c2)
          is distinct from 2.7 * 0.35 then
      raise exception 'a proof after a scored lapse grew stability: %',
        (select to_jsonb(m) from public.study_claim_memory m where claim_id = c2);
    end if;
    if (select known from public.study_course_outline(course) where lesson_id = l2)
       is distinct from true
       or (select due from public.study_course_questions(course) where item_id = q1)
          is distinct from false then
      raise exception 'a proof after a scored lapse did not bring the lesson back: %',
        (select jsonb_agg(to_jsonb(o)) from public.study_course_outline(course) o);
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  perform pg_temp.become_reader(reader);
  -- Worth rereading is a lesson read before the lapse: l1, read above, whose claim the "not
  -- had" lapsed -- not l2, never read, which a sitting reaches in its turn. l2 was known
  -- once, and says so.
  if (select string_agg(lesson_key || '=' || revisit::text || '/' || faded::text, ','
                        order by lesson_position)
      from public.study_course_outline(course)) is distinct from 'l1=true/false,l2=false/true,l3=false/true' then
    raise exception 'revisit and faded are %',
      (select string_agg(lesson_key || '=' || revisit::text || '/' || faded::text, ','
                         order by lesson_position)
       from public.study_course_outline(course));
  end if;
  -- Due half an hour after the lapse, when an answer can clear it -- not before, when every
  -- answer to it is hinted.
  if (select row(due, due_at)::text from public.study_course_questions(course) where item_id = q1)
     is distinct from (select row(false, last_answered_at + interval '30 minutes')::text
                       from public.study_claim_memory where claim_id = c2) then
    raise exception 'a question on a lapsed claim was due before an answer could clear it: %',
      (select to_jsonb(q) from public.study_course_questions(course) q where item_id = q1);
  end if;
  -- The reader's own version is never due: answering it could clear nothing.
  if (select due_at from public.study_course_questions(course) where item_id = q5_mine)
     is not null then
    raise exception 'the reader''s own version of a question was due';
  end if;
  -- A lapse cuts stability to no less than half a day. Probed, and undone.
  begin
    perform pg_temp.as_owner();
    update public.study_claim_memory set stability = 1.0 where claim_id = c2;
    perform pg_temp.become_reader(reader);
    perform pg_temp.answer(q1, '"Neither group"');
    if (select stability from public.study_claim_memory where claim_id = c2) <> 0.5 then
      raise exception 'a lapse cut stability below half a day';
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  perform pg_temp.become_reader(reader);
  -- Worth rereading follows the claims the lesson teaches now: l3 revised to leave c2 out,
  -- read, and c2 lapsing again, is not sent back for it. Probed, and undone.
  begin
    perform public.revise_study_lesson(l3, jsonb_build_object('claimIds', jsonb_build_array(c1)));
    perform public.record_study_progress(jsonb_build_array(
      jsonb_build_object('clientEventId', extensions.gen_random_uuid(), 'kind', 'lesson_read',
                         'lessonId', (select id from public.study_lessons
                                      where generation_id = gen and lesson_key = 'l3'
                                        and status = 'validated'))));
    perform pg_temp.answer(q1, '"Neither group"');
    if (select revisit from public.study_course_outline(course) where lesson_key = 'l3')
       is distinct from false then
      raise exception 'a lesson was sent back for a claim it no longer teaches';
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  -- Reading the lesson again answers "worth rereading"; the claim stays due. Probed, and
  -- undone.
  begin
    perform public.record_study_progress(jsonb_build_array(
      jsonb_build_object('clientEventId', extensions.gen_random_uuid(), 'kind', 'lesson_read',
                         'lessonId', l1)));
    if (select revisit from public.study_course_outline(course) where lesson_id = l1)
       is distinct from false
       or (select lapsed from public.study_claim_knowledge(course) where claim_id = c1)
          is distinct from true then
      raise exception 'reading a lesson again did not answer "worth rereading"';
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  -- Only a question the model wrote can clear a lapse: with the reader's own versions of
  -- every question on it left -- q5 is theirs already -- it would never go. Probed, and
  -- undone.
  begin
    perform public.revise_study_item(q3, '{"prompt": "What won at five minutes?"}');
    perform public.revise_study_item(q6, '{"prompt": "Which won early?"}');
    if (select revisit from public.study_course_outline(course) where lesson_id = l1)
       is distinct from false then
      raise exception 'a lapse held only by the reader''s own versions read as worth rereading';
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;
  -- The retry that follows it is hinted, so it cannot give the knowledge back.
  r := pg_temp.answer(q1, '"The recall test group"');
  if (r -> 'results' -> 0 ->> 'hinted')::boolean is not true
     or (select known from public.study_course_outline(course) where lesson_id = l2)
        is distinct from false
     or (select last_outcome from public.study_claim_memory where claim_id = c2)
        is distinct from 'lapse' then
    raise exception 'a retry after a wrong answer restored knowledge';
  end if;

  -- With every question on a lapsed claim withdrawn, nothing could ever clear "worth
  -- rereading", so it goes. Probed, and undone.
  begin
    perform public.retire_study_content('item', q3);
    perform public.retire_study_content('item', q6);
    if (select revisit from public.study_course_outline(course) where lesson_id = l1)
       is distinct from false then
      raise exception 'a lapse with no question left to clear it still read as worth rereading';
    end if;
    raise exception using errcode = 'P0001', message = 'probe done';
  exception when raise_exception then
    if sqlerrm is distinct from 'probe done' then raise; end if;
  end;

  -- ---------------------------------------------------------------- reach
  perform pg_temp.become_reader(other);
  -- Another reader's answer to this course's question is refused, and moves no memory.
  r := pg_temp.answer(q1, '"The recall test group"');
  if r -> 'refused' -> 0 ->> 'reason' is distinct from 'not_found' then
    raise exception 'another reader answered this reader''s question: %', r;
  end if;
  if exists (select 1 from public.study_claim_memory)
     or exists (select 1 from public.study_claim_knowledge(course)) then
    raise exception 'another reader could see this reader''s memory';
  end if;
  perform pg_temp.become_reader(reader);
  if has_table_privilege('authenticated', 'public.study_claim_memory', 'insert')
     or has_table_privilege('authenticated', 'public.study_claim_memory', 'update')
     or has_table_privilege('service_role', 'public.study_claim_memory', 'insert')
     or has_function_privilege('authenticated', 'public.study_remember(uuid)', 'execute')
     or has_function_privilege('anon', 'public.study_claim_knowledge(uuid, timestamptz)',
                               'execute') then
    raise exception 'the memory is writable, or readable by anon';
  end if;

  -- Deleting the source takes the memory with the claims.
  delete from public.study_sources where owner_id = reader;
  perform pg_temp.as_owner();
  if exists (select 1 from public.study_claim_memory where owner_id = reader) then
    raise exception 'the memory outlived its claims';
  end if;
end
$test$;

select 'study memory: ok';

rollback;
