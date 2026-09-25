-- Study generation, after the second review round.
--
-- 20260925010000 and 20260925020000 are pushed, so they are superseded here (law 6).
--
-- 1. ONE READER CANNOT SPEND THE DAY. The global cap bounds what the product spends; it
--    was never a fairness mechanism (20260914010000 says so), and a study course is up
--    to fourteen paid calls where a summary is two, so one allowlisted reader with one
--    maximal course could reach the cap in a quarter of an hour and close the door on
--    every reader until 00:00 UTC. `study_requester_daily_cap_cents()` -- 60, three
--    tenths of the day -- is each reader's share of study spend: the ledger for their
--    study jobs today plus their open holds. `reserve_study_budget` checks it under the
--    same global lock before taking the global hold, and the door refuses a job the
--    share cannot start. A refusal is a budget wait, like the global one. It also bounds
--    how much a reader's failing jobs can charge at the ceiling for attempts of unknown
--    cost: at most their share, never the day. Summaries are unchanged.
--
--    A share must exceed one call's ceiling (about 16 cents at default prices), or every
--    study step would wait out its day; raising GEMINI_MAX_OUTPUT_TOKENS far past its
--    default needs this raised with it.
--
-- 2. `record_study_stage` locked the job (its cost roll-up) before the version (the
--    cache's source links) -- the reverse of a source deletion, and the two deadlocked.
--    The roll-up now comes last, and a course deleted while the recording runs costs
--    only the cache entry, inside a block that keeps the ledger rows.
--
-- 3. `persist_study_course` took versions before the course, which fixed the source-
--    deletion deadlock and created one with account deletion, which takes the course
--    first. It now waits only for the course and takes the versions NOWAIT.

create function public.study_requester_daily_cap_cents()
returns numeric
language sql
immutable
set search_path = ''
as $$ select 60::numeric $$;

revoke all on function public.study_requester_daily_cap_cents() from public, anon;
grant execute on function public.study_requester_daily_cap_cents() to authenticated, service_role;

/* What one reader's study jobs have charged or hold today, by the rules spend_today uses. */
create function public.study_requester_spend_today(p_requester uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
           (select sum(cl.cost_cents)
              from public.cost_ledger cl
              join public.generation_jobs j on j.id = cl.job_id
             where j.requester_id = p_requester
               and j.kind = 'study_course'
               and cl.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc'),
           0)
       + coalesce(
           (select sum(br.reserved_cents)
              from public.budget_reservations br
              join public.generation_jobs j on j.id = br.job_id
             where j.requester_id = p_requester
               and j.kind = 'study_course'
               and br.settled_at is null
               and br.created_at >= now() - public.budget_reservation_ttl()
               and br.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc'),
           0);
$$;

revoke all on function public.study_requester_spend_today(uuid) from public, anon, authenticated;
grant execute on function public.study_requester_spend_today(uuid) to service_role;

/*
 * The reader's share, then the day's cap.
 *
 * Under the global budget lock `reserve_budget` takes (advisory locks are re-entrant in
 * a session), so two of one reader's calls cannot both fit in what is left of their
 * share. Refused with 53400, which the worker treats as a budget wait.
 */
create function public.reserve_study_budget(p_job_id uuid, p_step text, p_cents numeric)
returns numeric
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  requester uuid;
  mine      numeric;
  want      numeric := greatest(coalesce(p_cents, 0), 0);
  share     numeric := public.study_requester_daily_cap_cents();
begin
  select j.requester_id into requester
  from public.generation_jobs j
  where j.id = p_job_id and j.kind = 'study_course';
  if not found then
    raise exception 'reserve_study_budget: % is not a study job', p_job_id using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('what-a-pull:budget', 0));

  mine := public.study_requester_spend_today(requester);
  if mine + want > share then
    raise exception
      'this reader''s share of the day''s study budget is spent (% of % cents held or charged); '
      'this step needs % more', round(mine, 4), share, round(want, 4)
      using errcode = '53400';
  end if;

  return public.reserve_budget(p_job_id, p_step, want);
end
$fn$;

revoke all on function public.reserve_study_budget(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_study_budget(uuid, text, numeric) to service_role;

create or replace function public.record_study_stage(
  p_job_id uuid,
  p_step text,
  p_calls jsonb,
  p_cache jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  job        public.generation_jobs%rowtype;
  gen_owner  uuid;
  attempt    jsonb;
  call_id    uuid;
  cost       numeric;
  added      numeric := 0;
  cached     uuid;
  version_id uuid;
begin
  if p_step not in ('study_extract', 'study_assemble') then
    raise exception 'record_study_stage: % does not call a provider', p_step
      using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_calls, '[]'::jsonb)) <> 'array' then
    raise exception 'record_study_stage: calls must be an array' using errcode = '22023';
  end if;

  select * into job from public.generation_jobs where id = p_job_id;
  if found and job.kind <> 'study_course' then
    raise exception 'record_study_stage: % is not a study job', p_job_id using errcode = '22023';
  end if;

  -- The job is gone (its reader deleted their account mid-call). Its journal rows were
  -- detached by the deletion; ledger each one that is still unledgered, with no job.
  if not found then
    for attempt in select value from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) loop
      call_id := (attempt ->> 'providerCallId')::uuid;
      if exists (
        select 1 from public.provider_calls pc
        where pc.id = call_id and pc.job_id is null and pc.step = p_step
      ) then
        insert into public.cost_ledger
          (job_id, provider, operation, unit, quantity, cost_cents, provider_call_id, usage_known)
        values
          (null, attempt ->> 'provider', p_step, 'tokens',
           greatest(coalesce((attempt ->> 'inputTokens')::numeric, 0), 0)
             + greatest(coalesce((attempt ->> 'outputTokens')::numeric, 0), 0),
           greatest(coalesce((attempt ->> 'costCents')::numeric, 0), 0), call_id,
           coalesce((attempt ->> 'usageKnown')::boolean, true))
        on conflict (provider_call_id) do nothing;
      end if;
    end loop;
    return null;
  end if;

  -- Before anything is written: whether there is still a course to cache for.
  select g.owner_id into gen_owner
  from public.study_generations g
  where g.job_id = p_job_id;

  for attempt in select value from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) loop
    call_id := (attempt ->> 'providerCallId')::uuid;
    cost := greatest(coalesce((attempt ->> 'costCents')::numeric, 0), 0);
    if not exists (
      select 1 from public.provider_calls pc
      where pc.id = call_id and pc.job_id = p_job_id and pc.step = p_step
    ) then
      raise exception 'record_study_stage: call % is not journalled for this job and step', call_id
        using errcode = '23503';
    end if;

    insert into public.cost_ledger
      (job_id, provider, operation, unit, quantity, cost_cents, provider_call_id, usage_known)
    values
      (p_job_id, attempt ->> 'provider', p_step, 'tokens',
       greatest(coalesce((attempt ->> 'inputTokens')::numeric, 0), 0)
         + greatest(coalesce((attempt ->> 'outputTokens')::numeric, 0), 0),
       cost, call_id, coalesce((attempt ->> 'usageKnown')::boolean, true))
    on conflict (provider_call_id) do nothing;
    if found then
      added := added + cost;
    end if;
  end loop;

  -- No course, no cache entry: the attempts above are ledgered either way.
  --
  -- And a course deleted WHILE this runs is the same case. The cache insert then meets a
  -- version or course that is gone (a foreign-key violation); inside this block that
  -- rolls back only the cache entry, never the ledger rows written above, and a
  -- violation for any other reason is raised as it was.
  if p_cache is not null and gen_owner is not null then
    begin
    insert into public.study_stage_cache
      (owner_id, stage, cache_key, output, prompt_name, prompt_hash, schema_hash,
       provider_signature, model, provider_call_id, job_id)
    values
      (gen_owner, p_cache ->> 'stage', p_cache ->> 'cacheKey', p_cache -> 'output',
       p_cache ->> 'promptName', p_cache ->> 'promptHash', p_cache ->> 'schemaHash',
       p_cache ->> 'providerSignature', p_cache ->> 'model',
       (p_cache ->> 'providerCallId')::uuid, p_job_id)
    on conflict (owner_id, stage, cache_key) do nothing
    returning id into cached;

    if cached is null then
      select c.id into cached
      from public.study_stage_cache c
      where c.owner_id = gen_owner
        and c.stage = p_cache ->> 'stage'
        and c.cache_key = p_cache ->> 'cacheKey';
    else
      -- Every version the entry was derived from must belong to this job's course;
      -- the composite key then makes the owner match too.
      for version_id in
        select (value #>> '{}')::uuid
        from jsonb_array_elements(coalesce(p_cache -> 'sourceVersionIds', '[]'::jsonb))
      loop
        if not exists (
          select 1 from public.study_generation_sources s
          join public.study_generations g on g.id = s.generation_id
          where g.job_id = p_job_id and s.source_version_id = version_id
        ) then
          raise exception 'record_study_stage: version % is not a source of this course', version_id
            using errcode = '23503';
        end if;
        insert into public.study_stage_cache_sources (cache_id, owner_id, source_version_id)
        values (cached, gen_owner, version_id)
        on conflict do nothing;
      end loop;
      if not exists (select 1 from public.study_stage_cache_sources where cache_id = cached) then
        raise exception 'record_study_stage: a cache entry must name the versions it came from'
          using errcode = '23502';
      end if;
    end if;
    exception when foreign_key_violation then
      if exists (select 1 from public.study_generations g where g.job_id = p_job_id) then
        raise;
      end if;
      cached := null;
    end;
  end if;

  -- LAST, after the cache block: the job row is the lock a source deletion takes last
  -- (its version row first, then this job through the cancel trigger). Taken first here,
  -- the two deadlocked.
  update public.generation_jobs
     set cost_cents = coalesce(cost_cents, 0) + added
   where id = p_job_id;

  -- No settle: the worker settles this step's hold exactly once, on its way out.
  return cached;
end
$fn$;


create or replace function public.persist_study_course(p_job_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  gen        public.study_generations%rowtype;
  claim      jsonb;
  ev         jsonb;
  lesson     jsonb;
  item       jsonb;
  ref        text;
  new_id     uuid;
  version_id uuid;
  ord        int;
  claim_ids  jsonb := '{}'::jsonb;
  lesson_ids jsonb := '{}'::jsonb;
  counts     jsonb;
  gen_id     uuid;
  v_current  uuid;
  v_text     text;
  v_len      int;
begin
  select g.id into gen_id from public.study_generations g where g.job_id = p_job_id;
  if not found then
    raise exception 'persist_study_course: the study material for % was deleted', p_job_id
      using errcode = '23503';
  end if;

  /*
   * The course, then its versions WITHOUT WAITING.
   *
   * Two deletions reach these rows in opposite orders: a source deletion takes the
   * version and then the course (through its trigger), and account deletion takes the
   * course (through the job) and then the versions. No fixed order suits both, so this
   * waits only for the course -- after which a deleted course is simply not found -- and
   * refuses rather than waits on a version something else holds. A refusal (55P03) fails
   * this attempt with nothing written; the retry finds the material gone or free.
   */
  select g.* into gen
  from public.study_generations g
  where g.id = gen_id
  for update;
  if not found then
    raise exception 'persist_study_course: the study material for % was deleted', p_job_id
      using errcode = '23503';
  end if;

  perform 1
  from public.study_source_versions v
  join public.study_generation_sources s on s.source_version_id = v.id
  where s.generation_id = gen_id
  for key share of v nowait;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'persist_study_course: payload must be an object' using errcode = '22023';
  end if;

  if exists (select 1 from public.study_claims c where c.generation_id = gen.id) then
    return jsonb_build_object(
      'generationId', gen.id,
      'replayed', true,
      'claims', (select count(*) from public.study_claims c where c.generation_id = gen.id),
      'lessons', (select count(*) from public.study_lessons l where l.generation_id = gen.id),
      'items', (select count(*) from public.study_items i where i.generation_id = gen.id)
    );
  end if;

  update public.study_generations
     set title = p_payload #>> '{course,title}',
         overview = p_payload #>> '{course,overview}',
         objectives = coalesce(
           array(select jsonb_array_elements_text(p_payload #> '{course,objectives}')), '{}'),
         recap = p_payload #>> '{course,recap}',
         disagreements = coalesce(p_payload #> '{course,disagreements}', '[]'::jsonb),
         withheld = coalesce(p_payload #> '{course,withheld}', '[]'::jsonb),
         assembly_provenance = p_payload -> 'provenance',
         assembled_at = now()
   where id = gen.id;

  for claim in select value from jsonb_array_elements(coalesce(p_payload -> 'claims', '[]'::jsonb)) loop
    version_id := (claim ->> 'sourceVersionId')::uuid;
    if not exists (
      select 1 from public.study_generation_sources s
      where s.generation_id = gen.id and s.source_version_id = version_id
    ) then
      raise exception 'persist_study_course: claim % cites a version outside this course',
        claim ->> 'key' using errcode = '23503';
    end if;

    insert into public.study_claims
      (owner_id, generation_id, source_version_id, claim_key, kind, statement,
       qualifications, attribution, status, rejection_reasons,
       prompt_hash, schema_hash, model, provider_call_id)
    values
      (gen.owner_id, gen.id, version_id, claim ->> 'key', claim ->> 'kind',
       claim ->> 'statement',
       coalesce(array(select jsonb_array_elements_text(claim -> 'qualifications')), '{}'),
       claim ->> 'attribution', claim ->> 'status',
       coalesce(array(select jsonb_array_elements_text(claim -> 'rejectionReasons')), '{}'),
       claim #>> '{provenance,promptHash}', claim #>> '{provenance,schemaHash}',
       claim #>> '{provenance,model}', (claim #>> '{provenance,providerCallId}')::uuid)
    returning id into new_id;
    claim_ids := claim_ids || jsonb_build_object(claim ->> 'key', new_id);

    -- Each version's text is read once, not once per span: re-reading a 200,000-character
    -- version for every span cost a millisecond or two apiece, which at the size limits
    -- is seconds against an eight-second statement timeout.
    if v_current is distinct from version_id then
      select v.extracted_text into v_text from public.study_source_versions v where v.id = version_id;
      v_len := char_length(v_text);
      v_current := version_id;
    end if;

    ord := 0;
    for ev in select value from jsonb_array_elements(coalesce(claim -> 'evidence', '[]'::jsonb)) loop
      ord := ord + 1;
      if ev ->> 'match' <> 'unresolved' and (
        (ev ->> 'end')::int > v_len
        or substr(v_text, (ev ->> 'start')::int + 1,
                  (ev ->> 'end')::int - (ev ->> 'start')::int) is distinct from ev ->> 'spanText'
      ) then
        raise exception 'persist_study_course: evidence % of claim % is not in the stored version',
          ord, claim ->> 'key' using errcode = '23514';
      end if;
      insert into public.study_claim_evidence
        (claim_id, owner_id, ordinal, model_quote, span_text, start_offset, end_offset, page, match)
      values
        (new_id, gen.owner_id, ord, ev ->> 'modelQuote', ev ->> 'spanText',
         (ev ->> 'start')::int, (ev ->> 'end')::int, (ev ->> 'page')::int, ev ->> 'match');
    end loop;
  end loop;

  for lesson in select value from jsonb_array_elements(coalesce(p_payload -> 'lessons', '[]'::jsonb)) loop
    insert into public.study_lessons
      (owner_id, generation_id, lesson_key, position, unit_no, unit_title, title, objective,
       explanation, example, recap, minutes, status, rejection_reasons,
       prompt_hash, schema_hash, model, provider_call_id)
    values
      (gen.owner_id, gen.id, lesson ->> 'key', (lesson ->> 'position')::smallint,
       (lesson ->> 'unitNo')::smallint, lesson ->> 'unitTitle', lesson ->> 'title',
       lesson ->> 'objective', lesson ->> 'explanation', lesson ->> 'example',
       lesson ->> 'recap', (lesson ->> 'minutes')::smallint, lesson ->> 'status',
       coalesce(array(select jsonb_array_elements_text(lesson -> 'rejectionReasons')), '{}'),
       p_payload #>> '{provenance,promptHash}', p_payload #>> '{provenance,schemaHash}',
       p_payload #>> '{provenance,model}', (p_payload #>> '{provenance,providerCallId}')::uuid)
    returning id into new_id;
    lesson_ids := lesson_ids || jsonb_build_object(lesson ->> 'key', new_id);

    for ref in select jsonb_array_elements_text(coalesce(lesson -> 'claimKeys', '[]'::jsonb)) loop
      if claim_ids ->> ref is null then
        raise exception 'persist_study_course: lesson % cites unknown claim %', lesson ->> 'key', ref
          using errcode = '23503';
      end if;
      insert into public.study_lesson_claims (lesson_id, claim_id, owner_id)
      values (new_id, (claim_ids ->> ref)::uuid, gen.owner_id)
      on conflict do nothing;
    end loop;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
    if item ->> 'lessonKey' is not null and lesson_ids ->> (item ->> 'lessonKey') is null then
      raise exception 'persist_study_course: question % names unknown lesson %',
        item ->> 'key', item ->> 'lessonKey' using errcode = '23503';
    end if;

    insert into public.study_items
      (owner_id, generation_id, lesson_id, item_key, purpose, kind, prompt, answer,
       accepted_answers, distractors, cloze, sequence, pairs, explanation, difficulty,
       status, rejection_reasons, prompt_hash, schema_hash, model, provider_call_id)
    values
      (gen.owner_id, gen.id, (lesson_ids ->> (item ->> 'lessonKey'))::uuid,
       item ->> 'key', item ->> 'purpose', item ->> 'kind', item ->> 'prompt',
       item ->> 'answer',
       coalesce(array(select jsonb_array_elements_text(item -> 'acceptedAnswers')), '{}'),
       coalesce(item -> 'distractors', '[]'::jsonb), item ->> 'cloze',
       coalesce(array(select jsonb_array_elements_text(item -> 'sequence')), '{}'),
       coalesce(item -> 'pairs', '[]'::jsonb), item ->> 'explanation',
       (item ->> 'difficulty')::smallint, item ->> 'status',
       coalesce(array(select jsonb_array_elements_text(item -> 'rejectionReasons')), '{}'),
       p_payload #>> '{provenance,promptHash}', p_payload #>> '{provenance,schemaHash}',
       p_payload #>> '{provenance,model}', (p_payload #>> '{provenance,providerCallId}')::uuid)
    returning id into new_id;

    for ref in select jsonb_array_elements_text(coalesce(item -> 'claimKeys', '[]'::jsonb)) loop
      if claim_ids ->> ref is null then
        raise exception 'persist_study_course: question % cites unknown claim %', item ->> 'key', ref
          using errcode = '23503';
      end if;
      insert into public.study_item_claims (item_id, claim_id, owner_id)
      values (new_id, (claim_ids ->> ref)::uuid, gen.owner_id)
      on conflict do nothing;
    end loop;
  end loop;

  select jsonb_build_object(
           'generationId', gen.id,
           'replayed', false,
           'claims', (select count(*) from public.study_claims c where c.generation_id = gen.id),
           'lessons', (select count(*) from public.study_lessons l where l.generation_id = gen.id),
           'items', (select count(*) from public.study_items i where i.generation_id = gen.id))
    into counts;
  return counts;
end
$fn$;


create or replace function public.enqueue_study_generation(
  p_source_version_ids uuid[],
  p_goal text,
  p_mutation_id uuid,
  p_processing_consent boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  daily_fast_limit   constant int := 3;
  daily_hard_ceiling constant int := 50;
  stagger_seconds    constant int := 300;
  max_sources        constant int := 5;
  max_total_chars    constant int := 200000;

  uid        uuid := (select auth.uid());
  v_goal     text := btrim(coalesce(p_goal, ''));
  wanted     int;
  owned      int;
  total      bigint;
  used       int;
  over       boolean;
  delay_for  int;
  new_job    uuid;
  new_gen    uuid := extensions.gen_random_uuid();
  replayed   public.generation_jobs%rowtype;
begin
  if uid is null then
    raise exception 'study generation requires a signed-in reader' using errcode = '28000';
  end if;
  if not exists (select 1 from auth.users u where u.id = uid and u.is_anonymous is not true) then
    raise exception 'study generation needs an account, not a guest session'
      using errcode = '28000';
  end if;
  if not exists (select 1 from public.study_generation_access a where a.user_id = uid) then
    raise exception 'study generation is in a limited beta and is not open to this account yet'
      using errcode = '42501';
  end if;
  if p_mutation_id is null then
    raise exception 'study generation needs a mutation id' using errcode = '22023';
  end if;

  -- Per-reader serialisation first, so two presses of one submit cannot both miss the
  -- replay below and race to the unique index.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

  select * into replayed
  from public.generation_jobs gj
  where gj.requester_id = uid and gj.client_mutation_id = p_mutation_id;
  if found then
    if replayed.kind <> 'study_course' then
      raise exception 'that mutation id belongs to a different request' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'jobId', replayed.id,
      'generationId', replayed.target ->> 'generationId',
      'status', replayed.status,
      'replayed', true
    );
  end if;

  if p_processing_consent is not true then
    raise exception 'study generation sends your text to the model provider; confirm that first'
      using errcode = '22023';
  end if;
  if char_length(v_goal) not between 1 and 300 then
    raise exception 'the study goal must be 1 to 300 characters' using errcode = '22023';
  end if;

  select count(distinct v) into wanted
  from unnest(coalesce(p_source_version_ids, '{}'::uuid[])) as v
  where v is not null;
  if wanted < 1 or wanted > max_sources
     or wanted <> cardinality(coalesce(p_source_version_ids, '{}'::uuid[])) then
    raise exception 'choose one to % different source versions', max_sources
      using errcode = '22023';
  end if;

  select count(*), coalesce(sum(char_length(v.extracted_text)), 0) into owned, total
  from public.study_source_versions v
  where v.id = any (p_source_version_ids) and v.owner_id = uid;
  if owned <> wanted then
    raise exception 'a chosen source version is unavailable' using errcode = '42501';
  end if;
  if total > max_total_chars then
    raise exception 'the chosen sources total % characters; the limit is %', total, max_total_chars
      using errcode = '22023';
  end if;

  if public.spend_today() + public.study_min_job_cents() > public.daily_spend_cap_cents() then
    raise exception 'the daily generation budget is spent. Study generation resumes at 00:00 UTC.'
      using errcode = '53400';
  end if;
  if public.study_requester_spend_today(uid) + public.study_min_job_cents()
     > public.study_requester_daily_cap_cents() then
    raise exception 'your share of today''s study generation budget is spent. It resets at 00:00 UTC.'
      using errcode = '53400';
  end if;

  select count(*) into used
  from public.generation_jobs
  where requester_id = uid
    and created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';
  if used >= daily_hard_ceiling then
    raise exception 'daily generation ceiling reached (% jobs); try again tomorrow',
      daily_hard_ceiling using errcode = 'check_violation';
  end if;
  over := used >= daily_fast_limit;
  delay_for := case when over then (used - daily_fast_limit + 1) * stagger_seconds else 0 end;

  insert into public.generation_jobs
    (requester_id, kind, target, status, current_step, client_mutation_id)
  values
    (uid, 'study_course', jsonb_build_object('generationId', new_gen), 'queued',
     'study_prepare', p_mutation_id)
  returning id into new_job;

  insert into public.study_generations (id, owner_id, job_id, goal, processing_consent_at)
  values (new_gen, uid, new_job, v_goal, now());

  insert into public.study_generation_sources (generation_id, owner_id, source_version_id, position)
  select new_gen, uid, v.id, v.ord::smallint
  from unnest(p_source_version_ids) with ordinality as v(id, ord);

  perform pgmq.send('generation',
                    jsonb_build_object('jobId', new_job, 'step', 'study_prepare'),
                    delay_for);

  return jsonb_build_object(
    'jobId', new_job,
    'generationId', new_gen,
    'status', 'queued',
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for,
    'remainingToday', daily_hard_ceiling - used - 1,
    'replayed', false
  );
end
$fn$;


revoke all on function public.record_study_stage(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_study_stage(uuid, text, jsonb, jsonb) to service_role;

revoke all on function public.persist_study_course(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.persist_study_course(uuid, jsonb) to service_role;

revoke all on function public.enqueue_study_generation(uuid[], text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.enqueue_study_generation(uuid[], text, uuid, boolean)
  to authenticated;
