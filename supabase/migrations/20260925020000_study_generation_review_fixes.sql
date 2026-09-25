-- Study generation, after review.
--
-- 20260925010000 is pushed, so it is superseded here rather than edited (law 6).
--
-- 1. A charge is never rolled back because the material was deleted.
--
--    `record_study_stage` ledgered each provider attempt and THEN looked up the
--    course's owner to write the cache entry -- and raised when the course was gone.
--    The raise rolled the ledger rows back with it. Deleting a source is an ordinary
--    thing for a reader to do, and doing it while a paid call was in flight left that
--    call's journal row with no ledger row: the worker fell back to one step-level row,
--    so the cap still saw the money, but the per-attempt reconciliation reported a gap
--    the design promises never to have. The owner is now read first; when the course is
--    gone the attempts are still ledgered, and only the cache entry -- which would
--    belong to material that no longer exists -- is skipped.
--    The step then sees no cache id and stops, with nothing left unaccounted.
--
--    And when the JOB is gone -- account deletion removes a reader's jobs before the
--    account -- the attempts are still ledgered, with no job, against journal rows the
--    deletion has already detached. The charge happened whoever asked for it.
--
-- 2. It no longer settles the budget. It did, and then the worker settled the same
--    `(job, step)` again on the way out -- through `record_job_step` on success,
--    `failUnbilled` on failure -- and a replay of the recording settled a third time.
--    One settle too many releases a share of a hold another delivery of the same step
--    may still be spending under, which is the overshoot the reservation exists to stop.
--    The worker now settles exactly once per invocation, as it does for every other
--    step, including an explicit settle when a step asks to be sent again.
--
-- 3. `persist_study_course` takes its locks in the order a source deletion does (the
--    versions, then the course), which it did not, and the two could deadlock; and it
--    reads each version's text once rather than once per evidence span, which at the size
--    limits was seconds of a statement's eight.
--
-- 4. The link tables the account export pages by owner get an index led by the owner.
--
-- 5. `study_min_job_cents()` was executable by `anon`: `revoke ... from public` does not
--    remove Supabase's default grant to the API roles. Harmless, since it returns a
--    constant, and not what was intended.
--
-- 6. `study_generation_access.note` is readable by the reader it is about and is in
--    their account export. That is right -- a note about a person is their data -- and
--    it is now said where an operator writing one will see it.

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

  update public.generation_jobs
     set cost_cents = coalesce(cost_cents, 0) + added
   where id = p_job_id;

  -- No course, no cache entry: the attempts above are ledgered either way.
  if p_cache is not null and gen_owner is not null then
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
  end if;

  -- No settle: the worker settles this step's hold exactly once, on its way out.
  return cached;
end
$fn$;

revoke all on function public.record_study_stage(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_study_stage(uuid, text, jsonb, jsonb) to service_role;

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

  -- The versions first, then the course: the order a source deletion takes them (the
  -- version row, then the course through its trigger). Taken the other way round, the
  -- two deadlocked.
  perform 1
  from public.study_source_versions v
  join public.study_generation_sources s on s.source_version_id = v.id
  where s.generation_id = gen_id
  for key share of v;

  select g.* into gen
  from public.study_generations g
  where g.id = gen_id
  for update;
  if not found then
    raise exception 'persist_study_course: the study material for % was deleted', p_job_id
      using errcode = '23503';
  end if;
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


revoke all on function public.persist_study_course(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.persist_study_course(uuid, jsonb) to service_role;

create index study_generation_sources_owner_idx on public.study_generation_sources (owner_id, id);
create index study_stage_cache_sources_owner_idx on public.study_stage_cache_sources (owner_id, id);

revoke execute on function public.study_min_job_cents() from anon;

comment on column public.study_generation_access.note is
  'Readable by the reader it is about and included in their account export. Write '
  'nothing here you would not show them.';
