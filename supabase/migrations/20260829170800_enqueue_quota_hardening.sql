-- Codex review round 4, two findings on enqueue_generation_job.
--
-- 1. P1: the quota was configurable by its caller. `authenticated` holds EXECUTE
--    on this function, so a signed-in client can bypass the Edge Function
--    entirely and call it through PostgREST with p_daily_fast_limit = 999999 or
--    p_slow_delay_seconds = 0. The safeguard was optional to the very party it
--    exists to bound. The limits are now constants inside the function, and the
--    client-callable signature takes the target only.
--
-- 2. P2: the quota count was not serialised. Concurrent calls each counted the
--    same committed rows before any competing insert landed, so a coordinated
--    burst could classify far more than three jobs as fast. Making the insert
--    and send atomic did not help — that is a later write, not this earlier
--    read. Take a per-requester advisory lock first.

drop function if exists public.enqueue_generation_job(jsonb, int, int);

create function public.enqueue_generation_job(p_target jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Server-owned. Not parameters: this function is reachable by any signed-in
  -- caller, so anything tunable here is tunable by the person being limited.
  daily_fast_limit   constant int := 3;
  slow_delay_seconds constant int := 300;

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
  -- pre-insert count and both decide they are under the limit. Transaction
  -- scoped, and only ever contended by the same user's own bursts.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

  select count(*) into used
  from public.generation_jobs
  where requester_id = uid
    and created_at >= date_trunc('day', (now() at time zone 'utc'));

  over := used >= daily_fast_limit;

  -- Over quota is not a refusal: the work still happens, just later. The quota
  -- protects provider spend; it does not sell anything.
  delay_for := case when over then slow_delay_seconds else 0 end;

  insert into public.generation_jobs (requester_id, target, status)
  values (uid, p_target, 'queued')
  returning id into job_id;

  -- Same transaction as the insert, so there is no half-created state and no
  -- cleanup path to get wrong.
  perform pgmq.send('generation',
                    jsonb_build_object('jobId', job_id, 'step', 'resolve_identity'),
                    delay_for);

  return jsonb_build_object(
    'jobId', job_id,
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for
  );
end;
$$;

comment on function public.enqueue_generation_job is
  'Creates a generation job and queues its first step atomically. Quota is server-owned and serialised per requester; over-quota jobs are delayed, never refused.';

revoke all on function public.enqueue_generation_job(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_generation_job(jsonb) to authenticated;
