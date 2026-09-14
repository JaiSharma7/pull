-- A hold is released by whatever ends the step, not only by the ledger.
--
-- 20260914010000 settles a budget reservation from `record_job_step` and
-- `record_failed_job_step`, on the reasoning that the ledger row is what replaces the
-- hold. That is true of every step that reaches either function, and the review of this
-- PR found the two paths that do not:
--
--   1. AN UNBILLED FAILURE. `worker/index.ts` routes a failure through
--      `record_failed_job_step` only when it carries usage (`BilledStepError`); a plain
--      failure -- a network reset, a 503, a provider returning the wrong number of
--      vectors -- writes `job_steps` directly and calls nothing. `synthesize` has
--      already reserved by then, so the hold stands.
--   2. EXHAUSTED RETRIES. The worker marks the job `failed` itself and archives the
--      message. Nothing settles, and `sweep_stranded_generation_jobs` cannot: it
--      selects `status in ('queued','running')`, so the job it would have settled is
--      no longer selectable.
--
-- Both leave money held against a cap for a charge that never happened, and the second
-- is the most common terminal failure the pipeline has. During a provider outage ~34
-- such failures inside an hour fill a 200-cent cap entirely, `reserve_budget` refuses
-- every worker with 53400, and `enqueue_generation_job` tells every reader the day's
-- budget is spent -- while nothing has been spent at all. The one-hour TTL is the only
-- thing that ends it, which is exactly the state 20260914010000 says the sweep exists to
-- make ten minutes rather than sixty.
--
-- So the hold is released by whatever ENDS the step rather than by the one path that
-- bills it. Two changes, and the worker calls the first on both paths it owns:
--
--   * `settle_job_budget(job)` closes every open hold a job is carrying, by job rather
--     than by (job, step). The caller that is failing a job does not always know which
--     steps reserved -- the exhausted-retries path knows only the step it was handed --
--     and settling a step that never reserved is already a no-op.
--   * `sweep_stranded_generation_jobs` settles the holds of jobs that have ALREADY
--     reached a terminal status, not only the ones it fails itself. That is the backstop
--     for a worker that died between reserving and calling anything, which is the case
--     no client-side call can cover.
--
-- Law 2 holds: arithmetic over two tables. No model runs in here.

/*
 * Release everything one job is holding.
 *
 * Idempotent, and silent about a job that holds nothing: a step that did not reserve
 * still ends, and making that an error would put a branch in every caller for the
 * case that means nothing went wrong.
 *
 * `service_role` only, like `settle_budget` beside it. A caller who can settle can
 * release a hold somebody else is relying on, which is the same authority as being
 * able to take one.
 */
create function public.settle_job_budget(p_job_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  closed int;
begin
  update public.budget_reservations
     set settled_at = now()
   where job_id = p_job_id and settled_at is null;
  get diagnostics closed = row_count;
  return closed;
end;
$$;

comment on function public.settle_job_budget is
  'Close every open budget hold a job carries. Called by the worker on both failure '
  'paths that do not reach record_failed_job_step. See 20260914030000.';

revoke all on function public.settle_job_budget(uuid) from public, anon, authenticated;
grant execute on function public.settle_job_budget(uuid) to service_role;

/*
 * `sweep_stranded_generation_jobs`, restated from 20260914010000.
 *
 * The selection, the three-minute floor, the `for update skip locked` and the failure
 * update are that migration's verbatim. What changes is the settlement at the end: it
 * used to close the holds of the jobs this tick FAILED, which misses every job that
 * reached a terminal status some other way -- the exhausted-retries path, a sibling
 * branch closing the job, or a worker that died after reserving.
 *
 * So it now also closes the holds of any job that is already terminal, whatever ended
 * it and whenever. That set is small (a hold is only open for the seconds a provider
 * call takes, unless something went wrong) and the predicate is on `settled_at is
 * null`, so a tick with nothing to clean up does nothing.
 */
create or replace function public.sweep_stranded_generation_jobs(
  p_older_than interval default interval '10 minutes',
  p_limit integer default 200
)
returns integer
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

  if stranded is not null then
    update public.generation_jobs gj
       set status      = 'failed',
           error       = format('stranded: nothing queued for step %s since %s',
                                gj.current_step, gj.updated_at),
           finished_at = now()
     where gj.id = any (stranded);
    get diagnostics swept = row_count;
  else
    swept := 0;
  end if;

  /*
   * Every terminal job's holds, not only the ones failed above.
   *
   * Nothing will ever record for a job that has finished, so an open hold on one is
   * money held against the cap for a charge that cannot arrive. Keyed on the job's
   * status rather than on this tick's array, which is what makes this cover the
   * exhausted-retries path and a worker that died holding one.
   */
  update public.budget_reservations br
     set settled_at = now()
    from public.generation_jobs gj
   where gj.id = br.job_id
     and br.settled_at is null
     and gj.status in ('succeeded', 'failed', 'cancelled');

  return swept;
end;
$$;
