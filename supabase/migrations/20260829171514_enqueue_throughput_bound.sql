-- Codex review round 5, P1: a fixed delay is not a throughput bound.
--
-- Every job past the third got the same +300s, so a burst of ten thousand
-- simply became eligible five minutes later and the provider spend was
-- unchanged. The control shifted cost in time rather than bounding it, which is
-- exactly the abuse docs/generation.md says the quota exists to stop.
--
-- Replaced with a real bound:
--
--   jobs 1-3      no delay        the free daily allowance
--   jobs 4-N      staggered       each one 5 minutes further out than the last,
--                                 so sustained throughput past the allowance is
--                                 capped at roughly one job per 5 minutes
--   beyond N      refused         not a paywall — a ceiling no human reaches,
--                                 which is what stops a script
--
-- The stagger is what makes this a throughput limit: the delay is a function of
-- how many the requester has already queued today, not a constant.

create or replace function public.enqueue_generation_job(p_target jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Server-owned. Not parameters: this function is reachable by any signed-in
  -- caller, so anything tunable here is tunable by the person being limited.
  daily_fast_limit   constant int := 3;
  daily_hard_ceiling constant int := 50;
  stagger_seconds    constant int := 300;

  uid       uuid := (select auth.uid());
  used      int;
  over      boolean;
  job_id    uuid;
  delay_for int;
begin
  if uid is null then
    raise exception 'enqueue_generation_job requires an authenticated user';
  end if;

  -- Serialise per requester, so two concurrent calls cannot both read the same
  -- pre-insert count and both decide they are under the limit.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

  select count(*) into used
  from public.generation_jobs
  where requester_id = uid
    and created_at >= date_trunc('day', (now() at time zone 'utc'));

  if used >= daily_hard_ceiling then
    raise exception 'daily generation ceiling reached (% jobs); try again tomorrow',
      daily_hard_ceiling
      using errcode = 'check_violation';
  end if;

  over := used >= daily_fast_limit;

  -- Staggered, not fixed: each job past the allowance is scheduled a further
  -- interval out, so the queue drains at a bounded rate instead of all at once.
  delay_for := case
                 when over then (used - daily_fast_limit + 1) * stagger_seconds
                 else 0
               end;

  insert into public.generation_jobs (requester_id, target, status)
  values (uid, p_target, 'queued')
  returning id into job_id;

  -- Same transaction as the insert, so there is no half-created state.
  perform pgmq.send('generation',
                    jsonb_build_object('jobId', job_id, 'step', 'resolve_identity'),
                    delay_for);

  return jsonb_build_object(
    'jobId', job_id,
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for,
    'remainingToday', daily_hard_ceiling - used - 1
  );
end;
$$;

comment on function public.enqueue_generation_job is
  'Creates a generation job and queues its first step atomically. Quota is server-owned, serialised per requester, and staggered so throughput past the free allowance is genuinely bounded.';

revoke all on function public.enqueue_generation_job(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_generation_job(jsonb) to authenticated;
