-- Study generation: the door, the journal, the ledger, the span check, and privacy.
--
-- What must hold, and under which role it is asserted:
--
--   as `authenticated` (RLS and grants in force)
--     * only an allowlisted, non-guest reader may enqueue, only their own versions,
--       one to five of them, at most 200,000 characters, with consent and a goal
--     * a lost response replays the job rather than buying another
--     * a reader sees their own generation, claims, evidence, lessons, questions and
--       cache -- and nothing of anyone else's -- and can write none of them directly
--     * the worker's functions and the journal are out of reach
--     * deleting a source deletes every derivative of it and cancels the job
--
--   as `service_role` (what the worker runs as)
--     * a provider call can be journalled, and each attempt ledgered exactly once
--       even when the recording is replayed
--     * a ledger row for a call the journal never saw is refused
--     * a span that is not the stored text at its offsets is refused, whole
--     * the audit reports a journalled attempt the ledger does not have
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.become_reader(p_uid uuid, p_guest boolean default false)
returns void language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated',
                      'is_anonymous', p_guest)::text, true);
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

grant execute on function pg_temp.become_reader(uuid, boolean) to authenticated, service_role;
grant execute on function pg_temp.become_worker() to authenticated, service_role;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

do $test$
declare
  reader_a  uuid := extensions.gen_random_uuid();
  reader_b  uuid := extensions.gen_random_uuid();
  outsider  uuid := extensions.gen_random_uuid();
  guest_id  uuid := extensions.gen_random_uuid();
  note      text := 'Roediger and Karpicke had students read prose. On a final test five minutes '
                    'later, the group that restudied remembered more. On final tests two days and '
                    'one week later, the group that had taken the recall test remembered more.';
  saved     jsonb;
  v_a1      uuid;
  v_a2      uuid;
  v_big1    uuid;
  v_big2    uuid;
  v_b       uuid;
  source_a1 uuid;
  queued    jsonb;
  replay    jsonb;
  the_job   uuid;
  gen_id    uuid;
  call_1    uuid := extensions.gen_random_uuid();
  call_2    uuid := extensions.gen_random_uuid();
  stray     uuid := extensions.gen_random_uuid();
  cache_id  uuid;
  persisted jsonb;
  refused   boolean;
  n         bigint;
  cost      numeric;
  audit     record;
  span_at   int;
  span      text := 'the group that restudied remembered more';
begin
  insert into auth.users
    (id, instance_id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at, is_anonymous,
     raw_app_meta_data, raw_user_meta_data)
  values
    (reader_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'study-gen-a@example.test', '', now(), now(), now(), false, '{}', '{}'),
    (reader_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'study-gen-b@example.test', '', now(), now(), now(), false, '{}', '{}'),
    (outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'study-gen-c@example.test', '', now(), now(), now(), false, '{}', '{}'),
    (guest_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     null, '', now(), now(), now(), true, '{}', '{}');
  insert into public.study_generation_access (user_id) values (reader_a), (reader_b), (guest_id);

  -- Material, saved the way a reader saves it.
  perform pg_temp.become_reader(reader_a);
  saved := public.save_study_source_version('My notes', 'paste', note, extensions.gen_random_uuid());
  v_a1 := (saved ->> 'versionId')::uuid;
  source_a1 := (saved ->> 'sourceId')::uuid;
  saved := public.save_study_source_version('Second note', 'paste', 'A second short note.',
                                            extensions.gen_random_uuid());
  v_a2 := (saved ->> 'versionId')::uuid;
  saved := public.save_study_source_version('Big one', 'paste', repeat('a', 150000),
                                            extensions.gen_random_uuid());
  v_big1 := (saved ->> 'versionId')::uuid;
  saved := public.save_study_source_version('Big two', 'paste', repeat('b', 60000),
                                            extensions.gen_random_uuid());
  v_big2 := (saved ->> 'versionId')::uuid;
  perform pg_temp.become_reader(reader_b);
  saved := public.save_study_source_version('B notes', 'paste', 'Reader B text here.',
                                            extensions.gen_random_uuid());
  v_b := (saved ->> 'versionId')::uuid;

  -- The reader can see whether the door is open to them.
  perform pg_temp.become_reader(reader_a);
  if not public.study_generation_available() then
    raise exception 'an allowlisted reader is told study generation is unavailable';
  end if;
  perform pg_temp.become_reader(outsider);
  if public.study_generation_available() then
    raise exception 'a reader outside the beta is told study generation is available';
  end if;

  -- ------------------------------------------------------------------ the door
  begin
    perform public.enqueue_study_generation(array[v_a1], 'goal', extensions.gen_random_uuid(), true);
    raise exception 'a reader outside the beta enqueued';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become_reader(guest_id, true);
  begin
    perform public.enqueue_study_generation(array[v_a1], 'goal', extensions.gen_random_uuid(), true);
    raise exception 'a guest enqueued';
  exception when invalid_authorization_specification then null;
  end;

  perform pg_temp.become_reader(reader_a);
  begin
    perform public.enqueue_study_generation(array[v_a1], 'goal', extensions.gen_random_uuid(), false);
    raise exception 'enqueued without consent to processing';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_study_generation(array[v_b], 'goal', extensions.gen_random_uuid(), true);
    raise exception 'enqueued another reader''s version';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.enqueue_study_generation(array[v_a1, v_a1], 'goal', extensions.gen_random_uuid(), true);
    raise exception 'enqueued a duplicated version';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_study_generation(array[v_a1, v_a2, v_big1, v_big2, v_a1, v_a2]::uuid[],
                                            'goal', extensions.gen_random_uuid(), true);
    raise exception 'enqueued six versions';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_study_generation('{}'::uuid[], 'goal', extensions.gen_random_uuid(), true);
    raise exception 'enqueued nothing';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_study_generation(array[v_a1], '   ', extensions.gen_random_uuid(), true);
    raise exception 'enqueued without a goal';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_study_generation(array[v_big1, v_big2], 'goal', extensions.gen_random_uuid(), true);
    raise exception 'enqueued 210,000 characters';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_study_generation(array[v_a1], 'goal', null, true);
    raise exception 'enqueued without a mutation id';
  exception when invalid_parameter_value then null;
  end;

  queued := public.enqueue_study_generation(array[v_a1, v_a2], 'Explain the argument',
                                            '11111111-1111-4111-8111-111111111111', true);
  the_job := (queued ->> 'jobId')::uuid;
  gen_id := (queued ->> 'generationId')::uuid;
  replay := public.enqueue_study_generation(array[v_a1], 'something else',
                                            '11111111-1111-4111-8111-111111111111', true);
  if (replay ->> 'jobId')::uuid <> the_job or not (replay ->> 'replayed')::boolean then
    raise exception 'a lost response bought a second job: %', replay;
  end if;

  perform pg_temp.as_owner();
  select count(*) into n from public.generation_jobs
   where id = the_job and kind = 'study_course' and current_step = 'study_prepare'
     and visibility = 'private' and target = jsonb_build_object('generationId', gen_id);
  if n <> 1 then raise exception 'the job row is not a private study job holding only its generation id'; end if;
  select count(*) into n from pgmq.q_generation
   where message ->> 'jobId' = the_job::text and message ->> 'step' = 'study_prepare';
  if n <> 1 then raise exception 'the job was not queued at study_prepare (% messages)', n; end if;
  select count(*) into n from public.study_generation_sources where generation_id = gen_id;
  if n <> 2 then raise exception 'the course names % sources, not 2', n; end if;

  -- The cap refuses at the door when the day cannot fund two calls.
  insert into public.cost_ledger (provider, operation, unit, quantity, cost_cents)
  values ('test', 'test', 'tokens', 0, public.daily_spend_cap_cents() - public.study_min_job_cents() + 1);
  perform pg_temp.become_reader(reader_b);
  begin
    perform public.enqueue_study_generation(array[v_b], 'goal', extensions.gen_random_uuid(), true);
    raise exception 'enqueued into a spent day';
  exception when sqlstate '53400' then null;
  end;
  perform pg_temp.as_owner();
  delete from public.cost_ledger where provider = 'test';

  -- Study jobs share the requester's allowance with every other generation job.
  insert into public.generation_jobs (requester_id, kind, status)
  select reader_b, 'private_summary', 'succeeded' from generate_series(1, 3);
  perform pg_temp.become_reader(reader_b);
  queued := public.enqueue_study_generation(array[v_b], 'goal', extensions.gen_random_uuid(), true);
  if queued ->> 'queue' <> 'normal' or (queued ->> 'delaySeconds')::int <= 0 then
    raise exception 'a fourth job of the day was not staggered: %', queued;
  end if;

  -- ------------------------------------------------------- the worker's writes
  -- The journal and the worker's functions are out of a reader's reach.
  perform pg_temp.become_reader(reader_a);
  begin
    insert into public.provider_calls (id, job_id, step, provider, endpoint)
    values (extensions.gen_random_uuid(), the_job, 'study_extract', 'gemini', 'm');
    raise exception 'a reader journalled a provider call';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_study_stage(the_job, 'study_extract', '[]'::jsonb, null);
    raise exception 'a reader recorded a study stage';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.persist_study_course(the_job, '{}'::jsonb);
    raise exception 'a reader persisted a course';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.study_provider_call_audit();
    raise exception 'a reader read the provider audit';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become_worker();
  insert into public.provider_calls (id, job_id, step, provider, endpoint)
  values (call_1, the_job, 'study_extract', 'gemini', 'models/m:generateContent'),
         (call_2, the_job, 'study_extract', 'gemini', 'models/m:generateContent');
  update public.provider_calls set outcome = 'responded', http_status = 503, closed_at = now()
   where id = call_1;
  update public.provider_calls set outcome = 'responded', http_status = 200, closed_at = now()
   where id = call_2;
  perform public.reserve_budget(the_job, 'study_extract', 16);

  cache_id := public.record_study_stage(
    the_job, 'study_extract',
    jsonb_build_array(
      jsonb_build_object('providerCallId', call_1, 'provider', 'gemini', 'model', 'm',
                         'inputTokens', 0, 'outputTokens', 0, 'costCents', 0, 'usageKnown', true),
      jsonb_build_object('providerCallId', call_2, 'provider', 'gemini', 'model', 'm',
                         'inputTokens', 900, 'outputTokens', 300, 'costCents', 0.1575,
                         'usageKnown', true)),
    jsonb_build_object('stage', 'extract', 'cacheKey', repeat('c', 64),
                       'output', jsonb_build_object('claims', '[]'::jsonb),
                       'promptName', 'ExtractStudyClaims', 'promptHash', repeat('a', 64),
                       'schemaHash', repeat('b', 64), 'providerSignature', 'gemini:m',
                       'model', 'm', 'providerCallId', call_2,
                       'sourceVersionIds', jsonb_build_array(v_a1)));
  if cache_id is null then raise exception 'recording a usable stage cached nothing'; end if;

  -- Replayed after a lost response: no second charge, same cache entry.
  if public.record_study_stage(
       the_job, 'study_extract',
       jsonb_build_array(jsonb_build_object('providerCallId', call_2, 'provider', 'gemini',
                                            'costCents', 0.1575)),
       jsonb_build_object('stage', 'extract', 'cacheKey', repeat('c', 64),
                          'output', jsonb_build_object('claims', '[]'::jsonb),
                          'promptName', 'ExtractStudyClaims', 'promptHash', repeat('a', 64),
                          'schemaHash', repeat('b', 64), 'providerSignature', 'gemini:m',
                          'model', 'm', 'providerCallId', call_2,
                          'sourceVersionIds', jsonb_build_array(v_a1))) <> cache_id then
    raise exception 'a replayed recording made a second cache entry';
  end if;

  perform pg_temp.as_owner();
  select count(*), coalesce(sum(cost_cents), 0) into n, cost
    from public.cost_ledger where provider_call_id in (call_1, call_2);
  if n <> 2 or cost <> 0.1575 then
    raise exception 'expected one ledger row per attempt and one charge, got % rows, % cents', n, cost;
  end if;
  select cost_cents into cost from public.generation_jobs where id = the_job;
  if cost <> 0.1575 then raise exception 'the job was charged % cents, not 0.1575', cost; end if;
  select count(*) into n from public.budget_reservations br
   where br.job_id = the_job and br.step = 'study_extract' and br.settled_at is null;
  if n <> 0 then raise exception 'recording the stage left its hold open'; end if;

  perform pg_temp.become_worker();
  begin
    perform public.record_study_stage(the_job, 'study_extract',
      jsonb_build_array(jsonb_build_object('providerCallId', stray, 'provider', 'gemini',
                                           'costCents', 1)), null);
    raise exception 'ledgered a call the journal never saw';
  exception when foreign_key_violation then null;
  end;
  begin
    perform public.record_study_stage(the_job, 'study_extract', '[]'::jsonb,
      jsonb_build_object('stage', 'extract', 'cacheKey', repeat('d', 64),
                         'output', '{}'::jsonb, 'promptName', 'x', 'promptHash', repeat('a', 64),
                         'schemaHash', repeat('b', 64), 'providerSignature', 'g', 'model', 'm',
                         'sourceVersionIds', jsonb_build_array(v_b)));
    raise exception 'cached a stage against a version outside the course';
  exception when foreign_key_violation then null;
  end;

  -- A journalled attempt with no ledger row is what the audit exists to report.
  insert into public.provider_calls (id, job_id, step, provider, endpoint)
  values (stray, the_job, 'study_assemble', 'gemini', 'models/m:generateContent');
  select * into audit from public.study_provider_call_audit(now() - interval '1 hour');
  if audit.journalled <> 3 or audit.ledgered <> 2 or audit.unledgered <> 1 then
    raise exception 'audit did not see the unledgered attempt: %', audit;
  end if;

  -- ------------------------------------------------------ the span check
  span_at := position(span in note) - 1;
  begin
    perform public.persist_study_course(the_job, jsonb_build_object(
      'course', jsonb_build_object('title', 'T'),
      'claims', jsonb_build_array(jsonb_build_object(
        'key', 's1c1', 'sourceVersionId', v_a1, 'kind', 'finding', 'statement', 'S',
        'status', 'draft',
        'evidence', jsonb_build_array(jsonb_build_object(
          'modelQuote', span, 'spanText', span, 'start', span_at + 1,
          'end', span_at + 1 + char_length(span), 'match', 'exact')),
        'provenance', jsonb_build_object('promptHash', repeat('a', 64),
                                         'schemaHash', repeat('b', 64), 'model', 'm')))));
    raise exception 'persisted a span that is not the stored text at its offsets';
  exception when check_violation then null;
  end;
  select count(*) into n from public.study_claims where generation_id = gen_id;
  if n <> 0 then raise exception 'a refused payload left % claims behind', n; end if;

  begin
    perform public.persist_study_course(the_job, jsonb_build_object(
      'claims', jsonb_build_array(jsonb_build_object(
        'key', 's1c1', 'sourceVersionId', v_b, 'kind', 'finding', 'statement', 'S',
        'status', 'draft', 'evidence', '[]'::jsonb,
        'provenance', jsonb_build_object('promptHash', repeat('a', 64),
                                         'schemaHash', repeat('b', 64), 'model', 'm')))));
    raise exception 'persisted a claim citing another reader''s version';
  exception when foreign_key_violation then null;
  end;

  persisted := public.persist_study_course(the_job, jsonb_build_object(
    'course', jsonb_build_object(
      'title', 'Immediate versus delayed', 'overview', 'O', 'objectives', jsonb_build_array('Explain'),
      'recap', 'R', 'disagreements', '[]'::jsonb,
      'withheld', jsonb_build_array(jsonb_build_object(
        'prompt', 'Does retrieval work better for everyone?', 'reason', 'One group only.'))),
    'claims', jsonb_build_array(
      jsonb_build_object(
        'key', 's1c1', 'sourceVersionId', v_a1, 'kind', 'finding',
        'statement', 'At five minutes, restudying produced better recall.',
        'qualifications', jsonb_build_array('five minutes'), 'status', 'draft',
        'evidence', jsonb_build_array(jsonb_build_object(
          'modelQuote', span, 'spanText', span, 'start', span_at,
          'end', span_at + char_length(span), 'page', null, 'match', 'exact')),
        'provenance', jsonb_build_object('promptHash', repeat('a', 64),
                                         'schemaHash', repeat('b', 64), 'model', 'm',
                                         'providerCallId', call_2)),
      jsonb_build_object(
        'key', 's1c2', 'sourceVersionId', v_a1, 'kind', 'finding',
        'statement', 'Retrieval works for everyone.', 'status', 'rejected',
        'rejectionReasons', jsonb_build_array('evidence_missing'),
        'evidence', jsonb_build_array(jsonb_build_object(
          'modelQuote', 'works for everyone', 'match', 'unresolved')),
        'provenance', jsonb_build_object('promptHash', repeat('a', 64),
                                         'schemaHash', repeat('b', 64), 'model', 'm'))),
    'lessons', jsonb_build_array(jsonb_build_object(
      'key', 'l1', 'position', 1, 'unitNo', 1, 'unitTitle', 'U', 'title', 'Timing',
      'objective', 'Contrast', 'explanation', 'E', 'recap', 'R', 'minutes', 3,
      'status', 'draft', 'claimKeys', jsonb_build_array('s1c1'))),
    'items', jsonb_build_array(
      jsonb_build_object(
        'key', 'q1', 'lessonKey', 'l1', 'purpose', 'placement', 'kind', 'multiple_choice',
        'prompt', 'Which group remembered more at five minutes?', 'answer', 'Restudy',
        'distractors', jsonb_build_array(jsonb_build_object('text', 'Test', 'why', 'Reversed'),
                                         jsonb_build_object('text', 'Neither', 'why', 'No')),
        'explanation', 'X', 'difficulty', 1, 'status', 'draft',
        'claimKeys', jsonb_build_array('s1c1')),
      jsonb_build_object(
        'key', 'q2', 'lessonKey', null, 'purpose', 'review', 'kind', 'short_recall',
        'prompt', 'State the five-minute result.', 'answer', 'Restudy was better.',
        'explanation', 'X', 'difficulty', 2, 'status', 'draft',
        'claimKeys', jsonb_build_array('s1c1'))),
    'provenance', jsonb_build_object('promptHash', repeat('e', 64), 'schemaHash', repeat('f', 64),
                                     'model', 'm', 'providerCallId', call_2)));
  if (persisted ->> 'claims')::int <> 2 or (persisted ->> 'lessons')::int <> 1
     or (persisted ->> 'items')::int <> 2 then
    raise exception 'persist wrote the wrong counts: %', persisted;
  end if;
  if not (public.persist_study_course(the_job, '{}'::jsonb) ->> 'replayed')::boolean then
    raise exception 'a second persist was not a replay';
  end if;

  -- ------------------------------------------------------------ privacy
  perform pg_temp.become_reader(reader_a);
  select count(*) into n from public.study_claims where generation_id = gen_id;
  if n <> 2 then raise exception 'the owner sees % claims, not 2', n; end if;
  select count(*) into n from public.study_claim_evidence;
  if n <> 2 then raise exception 'the owner sees % evidence rows, not 2', n; end if;
  select count(*) into n from public.study_items where generation_id = gen_id;
  if n <> 2 then raise exception 'the owner sees % questions, not 2', n; end if;
  select count(*) into n from public.study_stage_cache;
  if n <> 1 then raise exception 'the owner sees % cache entries, not 1', n; end if;
  begin
    perform 1 from public.provider_calls limit 1;
    raise exception 'a reader can query the provider journal';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.study_items set answer = 'changed' where generation_id = gen_id;
    raise exception 'a reader edited a generated question directly';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.study_claims where generation_id = gen_id;
    raise exception 'a reader deleted a claim directly';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become_reader(reader_b);
  select (select count(*) from public.study_generations where id = gen_id)
       + (select count(*) from public.study_claims where generation_id = gen_id)
       + (select count(*) from public.study_claim_evidence)
       + (select count(*) from public.study_lessons where generation_id = gen_id)
       + (select count(*) from public.study_items where generation_id = gen_id)
       + (select count(*) from public.study_lesson_claims)
       + (select count(*) from public.study_item_claims)
       + (select count(*) from public.study_stage_cache)
       + (select count(*) from public.study_stage_cache_sources)
       + (select count(*) from public.study_generation_sources where generation_id = gen_id)
    into n;
  if n <> 0 then raise exception 'another reader sees % of reader A''s study rows', n; end if;

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  refused := false;
  begin
    perform 1 from public.study_claims limit 1;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'anon can query study claims'; end if;

  -- --------------------------------------------- deleting the source deletes it all
  perform pg_temp.become_reader(reader_a);
  delete from public.study_sources where id = source_a1;

  perform pg_temp.as_owner();
  select (select count(*) from public.study_generations where id = gen_id)
       + (select count(*) from public.study_claims where generation_id = gen_id)
       + (select count(*) from public.study_items where generation_id = gen_id)
       + (select count(*) from public.study_lessons where generation_id = gen_id)
       + (select count(*) from public.study_stage_cache where id = cache_id)
    into n;
  if n <> 0 then raise exception 'deleting a source left % derived rows behind', n; end if;
  if (select status from public.generation_jobs where id = the_job) <> 'cancelled' then
    raise exception 'deleting the material did not cancel its job';
  end if;
  -- The audit trail outlives the material: no content in it, and the charge happened.
  select count(*) into n from public.cost_ledger where provider_call_id in (call_1, call_2);
  if n <> 2 then raise exception 'deleting the material removed ledger rows'; end if;

  -- Account deletion takes the rest of the reader's study rows with it.
  delete from auth.users where id = reader_b;
  select count(*) into n from public.study_generations where owner_id = reader_b;
  if n <> 0 then raise exception 'account deletion left study generations behind'; end if;
end
$test$;

rollback;

\echo 'study generation: ok'
