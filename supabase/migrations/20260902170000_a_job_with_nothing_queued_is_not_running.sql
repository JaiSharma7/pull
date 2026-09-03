-- A job with nothing queued is not running, whatever its status says.
--
-- The step-machine's liveness rests on one invariant: a job in `queued` or `running`
-- always has exactly one message in `pgmq.q_generation` naming its next step. Every
-- transition today keeps it -- `enqueue_generation_job` inserts and sends in one
-- transaction, `advance_generation_job` updates and sends in one transaction, and the
-- worker archives a message only after the writes it covers have committed. So today
-- a stranded job is nearly unreachable, and there is nothing that would notice if one
-- happened: it would sit at `running` forever, invisible to the dispatcher (which
-- reads the queue, not the jobs table) and to the requester (who sees "running").
--
-- Fable 5.1 makes it reachable on purpose. Fanning `embed`, `relations` and `artwork`
-- out from `cards` and joining them at `moderate` means a join that only fires once
-- all three have succeeded -- and if one of them fails permanently, nothing is ever
-- queued for the join, and the job is stranded by design rather than by accident.
-- That is a strictly worse failure than the line it replaces, so the thing that
-- catches it lands BEFORE the fan-out, not after. docs/plans/2026-09-02-fable-5.1.md
-- says the same in more words.
--
-- What "stranded" means here, precisely, because a sweeper that is wrong in the
-- other direction fails jobs that were about to succeed:
--
--   * status is `queued` or `running`;
--   * `updated_at` is older than the threshold. The `before update` trigger stamps
--     it on every transition, so this is "nothing has happened to this job for a
--     while", not "this job is old";
--   * and there is NO row in `pgmq.q_generation` naming it. Not "no visible row":
--     a message whose visibility timeout is in the future is in flight, and one
--     enqueued with a delay is an over-quota job waiting its turn. Both are alive.
--     Only the absence of any row at all means nothing will ever pick the job up.
--
-- The threshold has a floor of three minutes and defaults to ten. The worker claims
-- with a 180 s visibility timeout, and a message being processed is still a row, so
-- the floor is not about the in-flight case -- it is a margin against sweeping a job
-- in the same instant its transition commits, and against a clock skew nobody has
-- measured. Ten minutes is the default because being slow to notice a stranded job
-- costs nothing (it is already stuck) while being fast to misjudge one costs a
-- generation that may have been paid for.
--
-- SECURITY DEFINER for the reason `prune_operational_logs` is: `pgmq.q_generation`
-- belongs to the extension, and the scheduled caller should not need rights on it in
-- its own name. `search_path` pinned; revoked from every API role; granted to
-- `postgres`, which is what pg_cron runs as.
create or replace function public.sweep_stranded_generation_jobs(
  p_older_than interval default interval '10 minutes',
  p_limit      int      default 200
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  stranded uuid[];
  swept    int;
begin
  if p_older_than < interval '3 minutes' then
    raise exception
      'sweep_stranded_generation_jobs: threshold % is under the three-minute floor; '
      'the worker holds a message for 180 s and a sweep inside that window would race it',
      p_older_than;
  end if;

  -- Selected with the lock and then updated by id, so two overlapping ticks cannot
  -- both fail the same job and so a job locked by a worker mid-transition is skipped
  -- rather than waited on. Bounded so one tick cannot run past `statement_timeout`.
  select array_agg(j.id) into stranded
  from (
    select gj.id
    from public.generation_jobs gj
    where gj.status in ('queued', 'running')
      and gj.updated_at < now() - p_older_than
      and not exists (
        select 1 from pgmq.q_generation q
        where q.message ->> 'jobId' = gj.id::text
      )
    order by gj.updated_at asc, gj.id
    limit greatest(coalesce(p_limit, 0), 0)
    for update skip locked
  ) j;

  if stranded is null then
    return 0;
  end if;

  update public.generation_jobs gj
     set status      = 'failed',
         error       = format('stranded: nothing queued for step %s since %s',
                              gj.current_step, gj.updated_at),
         finished_at = now()
   where gj.id = any (stranded);
  get diagnostics swept = row_count;

  return swept;
end;
$$;

comment on function public.sweep_stranded_generation_jobs(interval, int) is
  'Fails queued/running jobs with no message in the generation queue and no transition for the threshold. Liveness for the step-machine; required before any step may wait on more than one predecessor.';

revoke all on function public.sweep_stranded_generation_jobs(interval, int)
  from public, anon, authenticated;
grant execute on function public.sweep_stranded_generation_jobs(interval, int) to postgres;

-- Scheduling is a function an operator calls, not something the migration does, for
-- the reason every `enable_*` here gives: CI replays every migration from zero on a
-- fresh stack, and a migration that calls `cron.schedule` makes the replay depend on
-- pg_cron being not merely installed but running.
create or replace function public.enable_generation_sweeper(p_cron text default '*/5 * * * *')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_id bigint;
begin
  -- `cron.schedule` upserts by name, so calling this twice reschedules rather than
  -- stacking a second sweeper.
  select cron.schedule(
    'sweep-stranded-generation-jobs',
    p_cron,
    'select public.sweep_stranded_generation_jobs();'
  ) into job_id;
  return job_id;
end;
$$;

comment on function public.enable_generation_sweeper(text) is
  'Schedules the stranded-job sweep. Separate from the migration so a from-zero replay never depends on pg_cron running, and idempotent because cron.schedule upserts by job name.';

revoke all on function public.enable_generation_sweeper(text) from public, anon, authenticated;
grant execute on function public.enable_generation_sweeper(text) to postgres;
