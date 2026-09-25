-- Study generation, after the third review round.
--
-- 20260925010000 to 20260925030000 are pushed, so they are superseded here (law 6).
--
-- 1. THE SHARE IS THE SCHEMA'S, NOT THE CALLER'S. `reserve_study_budget` checked a
--    reader's share and then called `reserve_budget`, which accepted a study job without
--    it -- so the share held only because the worker happened to call the wrapper, and a
--    refactor that reached for the summary path's reservation would have dropped it
--    without a test noticing. Law 2 says these bounds are capped in the schema. The check
--    now lives in `reserve_budget`, under the same global lock, for every study job;
--    `reserve_study_budget` stays, as the entry point that refuses a job that is not one.
--
-- 2. A CORRECTED PREMISE, NOT A NEW NUMBER. 20260925030000 says a share must exceed "one
--    call's ceiling (about 16 cents at default prices)". Sixteen is the SMALLEST
--    assembly. A ceiling is priced from the prompt's bytes, and the assembly's prompt
--    carried every selected claim in full, so its ceiling had no bound below the share.
--    The worker now bounds the claims digest in bytes (`STUDY_LIMITS.maxDigestBytes`),
--    which puts the largest assembly near 28 cents and the largest extraction near 24,
--    and `study.test.ts` pins that the two together fit the share -- read from whichever
--    migration defines it last -- so a step can always be held on a new day. The share
--    stays 60. Raising GEMINI_MAX_OUTPUT_TOKENS or the prices far past their defaults
--    needs it raised with them, and that test is what will say so.
--
-- 3. `record_study_stage` took each cache source's version lock one insert at a time,
--    in payload order. It now takes them in one statement, in id order, NOWAIT.

-- ----------------------------------------------------------- 1. the share, in reserve_budget
/*
 * As 20260914140000 left it -- the day bound on both the sum and the stacking test, the
 * stacking itself and the reasons for both are documented there -- with one addition:
 * a study job's hold must also fit its reader's share of study spend.
 */
create or replace function public.reserve_budget(p_job_id uuid, p_step text, p_cents numeric)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap       numeric := public.daily_spend_cap_cents();
  want      numeric := greatest(coalesce(p_cents, 0), 0);
  committed numeric;
  held      numeric;
  job_kind  public.generation_jobs.kind%type;
  requester uuid;
  mine      numeric;
begin
  if p_job_id is null or p_step is null or p_step = '' then
    raise exception 'reserve_budget needs a job and a step' using errcode = '22023';
  end if;

  -- One lock for the whole budget. The constant is arbitrary and only has to be
  -- the same one every caller uses.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('what-a-pull:budget', 0));

  -- A study job is also bounded by its reader's share, under the same lock, so two of
  -- one reader's calls cannot both fit in what is left of it.
  select j.kind, j.requester_id into job_kind, requester
  from public.generation_jobs j
  where j.id = p_job_id;
  if job_kind = 'study_course' then
    mine := public.study_requester_spend_today(requester);
    if mine + want > public.study_requester_daily_cap_cents() then
      raise exception
        'this reader''s share of the day''s study budget is spent (% of % cents held or '
        'charged); this step needs % more',
        round(mine, 4), public.study_requester_daily_cap_cents(), round(want, 4)
        using errcode = '53400';
    end if;
  end if;

  select coalesce(sum(cl.cost_cents), 0) into committed
  from public.cost_ledger cl
  where cl.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

  -- Every open hold, including this step's own, inside the TTL and inside today.
  select coalesce(sum(br.reserved_cents), 0) into held
  from public.budget_reservations br
  where br.settled_at is null
    and br.created_at >= now() - public.budget_reservation_ttl()
    and br.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

  if committed + held + want > cap then
    raise exception
      'the daily generation budget is spent (% of % cents held or charged); this step '
      'needs % more', round(committed + held, 4), cap, round(want, 4)
      using errcode = '53400';
  end if;

  -- Stacked onto an unsettled hold inside the TTL and inside today; anything else is
  -- replaced. Stacking is the safe direction (20260914100000 says why).
  insert into public.budget_reservations (job_id, step, reserved_cents, open_calls)
  values (p_job_id, p_step, want, 1)
  on conflict (job_id, step) do update
    set reserved_cents =
          case
            when budget_reservations.settled_at is null
             and budget_reservations.created_at >= now() - public.budget_reservation_ttl()
             and budget_reservations.created_at >=
                 date_trunc('day', (now() at time zone 'utc')) at time zone 'utc'
            then budget_reservations.reserved_cents + excluded.reserved_cents
            else excluded.reserved_cents
          end,
        open_calls =
          case
            when budget_reservations.settled_at is null
             and budget_reservations.created_at >= now() - public.budget_reservation_ttl()
             and budget_reservations.created_at >=
                 date_trunc('day', (now() at time zone 'utc')) at time zone 'utc'
            then budget_reservations.open_calls + 1
            else 1
          end,
        created_at = now(),
        settled_at = null;

  return cap - (committed + held + want);
end;
$$;

revoke all on function public.reserve_budget(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_budget(uuid, text, numeric) to service_role;

/* The study worker's entry point: refuses a job that is not a study job; the rest is reserve_budget's. */
create or replace function public.reserve_study_budget(p_job_id uuid, p_step text, p_cents numeric)
returns numeric
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not exists (
    select 1 from public.generation_jobs j where j.id = p_job_id and j.kind = 'study_course'
  ) then
    raise exception 'reserve_study_budget: % is not a study job', p_job_id using errcode = '22023';
  end if;
  return public.reserve_budget(p_job_id, p_step, p_cents);
end
$fn$;

revoke all on function public.reserve_study_budget(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_study_budget(uuid, text, numeric) to service_role;

-- ------------------------------------------------ 3. the cache's versions, in one lock
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
      /*
       * The versions first, all at once, in id order and NOWAIT. The links below take
       * each version's key-share lock one insert at a time, in payload order; a source
       * deletion cascading over two versions of one source in the other order could
       * deadlock with that. A deletion already holding one fails this at once instead
       * (55P03, not caught here): the whole call rolls back, and the worker records the
       * attempts again, or without the cache entry, as it does for any refusal.
       */
      perform 1
      from public.study_source_versions v
      where v.id in (
        select (value #>> '{}')::uuid
        from jsonb_array_elements(coalesce(p_cache -> 'sourceVersionIds', '[]'::jsonb))
      )
      order by v.id
      for key share nowait;

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

revoke all on function public.record_study_stage(uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_study_stage(uuid, text, jsonb, jsonb) to service_role;
