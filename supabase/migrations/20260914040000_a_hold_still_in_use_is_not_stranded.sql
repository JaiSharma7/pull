/*
 * Three corrections from the fifth review round, all on the day's budget.
 *
 * 1. THE SWEEP'S TERMINAL PASS RELEASED HOLDS FOR CHARGES THAT WERE STILL COMING.
 *    20260914030000 settles every open reservation on a job whose status is terminal,
 *    on the reasoning that nothing will record for a finished job. `graph.ts` runs
 *    `extract_evidence` beside `synthesize` and `artwork` beside `embed` in separate
 *    invocations, so the moment one step fails the job, a sibling can still be inside
 *    its provider call holding a live reservation -- and its charge arrives after the
 *    money was given back. Concurrent workers then reserve against a total short by
 *    exactly the amount about to be spent, which is the overshoot the reservation
 *    exists to prevent. A hold younger than the worker's own message hold is not
 *    stranded, it is in use, so the pass now leaves it alone. Ten minutes, the same
 *    interval the stranded-job pass uses and for the same reason: three times the 180 s
 *    a worker may hold a message.
 *
 * 2. A MALFORMED TARGET RAISED FROM THE INTERNALS RATHER THAN REFUSING.
 *    `enqueue_generation_job` is built out of sentences a caller can act on, and a
 *    jsonb scalar slipped past all of them to `target - 'visibility'`, where Postgres
 *    raises `cannot delete from scalar`.
 *
 * 3. SETTLED RESERVATIONS HAD NO RETENTION.
 *    One row per provider step per job, stamped and never deleted, on a table whose
 *    only reader is bounded to the last twenty-four hours. It joins the operational
 *    prune, behind the same window as the step payloads.
 *
 * Restated in full rather than patched, because law 6 makes migrations append-only and
 * a `create or replace` needs the whole body.
 */

-- ------------------------------------------------------------------ 1. the sweep
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
   * Every terminal job's holds, not only the ones failed above -- and only the ones
   * old enough that nothing can still be spending against them.
   *
   * Nothing will ever record for a job that has finished, so an open hold on one is
   * money held against the cap for a charge that cannot arrive. Keyed on the job's
   * status rather than on this tick's array, which is what makes this cover the
   * exhausted-retries path and a worker that died holding one.
   *
   * THE AGE PREDICATE IS THE CORRECTION. A job goes terminal the moment one step
   * exhausts its retries, and its siblings do not stop: `extract_evidence` runs beside
   * `synthesize` and `artwork` beside `embed`, each in its own invocation, so a pass
   * keyed on status alone releases a reservation whose provider call is still open.
   * The charge lands afterwards, against a total this pass just made short by exactly
   * that amount, and the cap is overshot by the money it was holding. `p_older_than`
   * is at least three minutes by the check above and ten by default, which is longer
   * than a worker may hold a message, so a hold younger than that is in use rather
   * than stranded and the next tick will take it.
   */
  update public.budget_reservations br
     set settled_at = now()
    from public.generation_jobs gj
   where gj.id = br.job_id
     and br.settled_at is null
     and br.created_at < now() - p_older_than
     and gj.status in ('succeeded', 'failed', 'cancelled');

  return swept;
end;
$$;

comment on function public.sweep_stranded_generation_jobs(interval, integer) is
  'Fails jobs with no queue message left, and settles the open holds of terminal jobs once they are older than the sweep threshold -- a younger hold belongs to a sibling step that is still running.';

-- --------------------------------------------------------------- 2. the front door
create or replace function public.enqueue_generation_job(p_target jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  daily_fast_limit   constant int := 3;
  daily_hard_ceiling constant int := 50;
  stagger_seconds    constant int := 300;
  max_text_length    constant int := 200000;
  max_title_length   constant int := 200;
  -- What one job will reserve before it can do anything: synthesize plus embed.
  min_job_cents      constant numeric := 7;

  uid        uuid := (select auth.uid());
  used       int;
  over       boolean;
  job_id     uuid;
  delay_for  int;
  job_kind   text;
  target     jsonb := coalesce(p_target, '{}'::jsonb);
  work_ref   text;
  spent      numeric;
  cap        numeric := public.daily_spend_cap_cents();
begin
  if uid is null then
    raise exception 'enqueue_generation_job requires an authenticated user';
  end if;

  if not exists (
    select 1 from auth.users u where u.id = uid and u.is_anonymous is not true
  ) then
    raise exception
      'Generating a summary needs an account. Sign in with an email address and try again.'
      using errcode = '28000';
  end if;

  /*
   * An OBJECT, or nothing.
   *
   * `coalesce(p_target, '{}')` covers a missing target and not a malformed one: a
   * client that posts `{"p_target": "hello"}` sends a jsonb STRING, which survives
   * every `->>` below as NULL without complaint and then reaches `target - 'visibility'`
   * -- where `jsonb - text` raises `cannot delete from scalar`, an unhandled 22023 with
   * a message about the internals of a function the caller cannot see. Every other
   * refusal in here is a sentence; this was the one shape that got a stack trace.
   */
  if jsonb_typeof(target) <> 'object' then
    raise exception 'the generation target must be an object, not %', jsonb_typeof(target)
      using errcode = '22023';
  end if;

  job_kind := coalesce(nullif(target ->> 'jobKind', ''), 'canonical_summary');
  if job_kind not in ('canonical_summary', 'private_summary') then
    raise exception 'unknown job kind %; expected canonical_summary or private_summary',
      job_kind
      using errcode = '22023';
  end if;

  if length(coalesce(target ->> 'text', '')) > max_text_length then
    raise exception 'the submitted text is % characters; the limit is %',
      length(target ->> 'text'), max_text_length
      using errcode = 'check_violation';
  end if;

  if length(coalesce(target ->> 'title', '')) > max_title_length then
    raise exception 'the title is % characters; the limit is %',
      length(target ->> 'title'), max_title_length
      using errcode = 'check_violation';
  end if;

  target := target - 'visibility';
  work_ref := target ->> 'work_id';
  if work_ref is null
     or work_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not exists (
       select 1 from public.summaries s
       where s.work_id = work_ref::uuid and s.author_id = uid
     )
  then
    target := target - 'work_id';
  end if;

  /*
   * REFUSED WHERE A JOB COULD NOT RUN, not only where the budget is exactly gone.
   *
   * `spent >= cap` let a job in at 196 of 200 and told the reader it had started, and
   * `reserve_budget` then refused it at `196 + 6 > 200` -- so it parked in the 24-hour
   * budget wait while the screen said "Started. 46 more today." The door and the
   * reservation have to agree, so the door asks for what a job actually needs: the
   * worst case of the two provider steps it will reserve for (`RESERVE_CENTS` in
   * `supabase/functions/_shared/pipeline.ts`, 6 for synthesize and 1 for embed).
   *
   * Stated here rather than imported because SQL cannot read that file. If those
   * constants move, this moves with them -- and the failure if it does not is a job
   * accepted into a wait, which is visible rather than silent.
   */
  spent := public.spend_today();
  if spent + min_job_cents > cap then
    raise exception
      'the daily generation budget is spent. Summaries resume at 00:00 UTC.'
      using errcode = '53400';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

  select count(*) into used
  from public.generation_jobs
  where requester_id = uid
    and created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

  if used >= daily_hard_ceiling then
    raise exception 'daily generation ceiling reached (% jobs); try again tomorrow',
      daily_hard_ceiling
      using errcode = 'check_violation';
  end if;

  over := used >= daily_fast_limit;

  delay_for := case
                 when over then (used - daily_fast_limit + 1) * stagger_seconds
                 else 0
               end;

  insert into public.generation_jobs (requester_id, kind, target, status)
  values (uid, job_kind, target, 'queued')
  returning id into job_id;

  perform pgmq.send('generation',
                    jsonb_build_object('jobId', job_id, 'step', 'resolve_identity'),
                    delay_for);

  return jsonb_build_object(
    'jobId', job_id,
    'kind', job_kind,
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for,
    'remainingToday', daily_hard_ceiling - used - 1,
    'budget', public.generation_budget_state()
  );
end;
$$;

-- ------------------------------------------------------------------ 3. retention
create or replace function public.prune_operational_logs(
  p_cron_days     int default 2,
  p_response_hours int default 1,
  p_output_days   int default 7
)
returns jsonb
language plpgsql
-- SECURITY DEFINER because `cron.job_run_details` and `net._http_response`
-- belong to the extensions rather than to any application role, and the
-- scheduled caller must not need ownership of them in its own right.
-- `search_path` is pinned, which CI check 4's fourth invariant requires and
-- which matters more here than usual: this function deletes.
security definer
set search_path = ''
as $$
declare
  cron_rows     bigint := 0;
  response_rows bigint := 0;
  output_rows   bigint := 0;
  reservation_rows bigint := 0;
begin
  -- Two days keeps enough history to explain a failure that happened overnight,
  -- which is the only thing anyone has ever wanted this table for.
  delete from cron.job_run_details
  where end_time < now() - make_interval(days => greatest(p_cron_days, 1));
  get diagnostics cron_rows = row_count;

  -- pg_net keeps its own TTL and would eventually clear these; an hour is
  -- shorter than its default and saves several megabytes of steady state. A
  -- response older than an hour has already been read or already timed out.
  delete from net._http_response
  where created < now() - make_interval(hours => greatest(p_response_hours, 1));
  get diagnostics response_rows = row_count;

  -- The step ledger is the audit trail and stays: cost, model, provider, timing,
  -- attempt. Only the bulky `output` payload is dropped, and only for jobs that
  -- have finished, because `job_step_outputs` is what a resuming worker reads to
  -- recover the state it does not hold between invocations. Dropping it from a
  -- live job would strand it.
  update public.job_steps js
     set output = null
    from public.generation_jobs gj
   where gj.id = js.job_id
     and js.output is not null
     and gj.status in ('succeeded', 'failed', 'cancelled')
     and gj.updated_at < now() - make_interval(days => greatest(p_output_days, 1));
  get diagnostics output_rows = row_count;

  /*
   * Settled reservations, which nothing reads once the day they belonged to is over.
   *
   * 20260914010000 writes one row per provider step per job and every path that ends a
   * step only STAMPS it -- so the table grows for the life of the project while its
   * only reader, `spend_today()`, looks at the last twenty-four hours. The ledger is
   * the audit trail and is never touched here; a hold that was settled a week ago is
   * bookkeeping for a charge `cost_ledger` already records.
   *
   * Settled only, and never an open one: an open row is money held against today's
   * cap, and deleting it would release it as surely as stamping it. The same
   * `p_output_days` window as the step payloads above, since both answer the same
   * question -- how far back is anyone going to look.
   */
  delete from public.budget_reservations br
  where br.settled_at is not null
    and br.settled_at < now() - make_interval(days => greatest(p_output_days, 1));
  get diagnostics reservation_rows = row_count;

  return jsonb_build_object(
    'cronRuns', cron_rows,
    'httpResponses', response_rows,
    'jobStepOutputs', output_rows,
    'budgetReservations', reservation_rows,
    'databaseBytes', pg_catalog.pg_database_size(pg_catalog.current_database())
  );
end;
$$;

comment on function public.prune_operational_logs(int, int, int) is
  'Retention for the rows nobody reads: pg_cron run history, pg_net responses, the payloads of finished generation steps, and settled budget reservations. The step ledger and cost_ledger are never deleted -- reconciliation depends on them.';

/*
 * Grants, restated.
 *
 * `create or replace function` keeps the ones a function already has, so none of this
 * is load-bearing today. It is here because CI check 4 asserts the END STATE on a
 * database replayed from zero, and a reader of this file should be able to see what
 * each of these three may be called by without walking back through four migrations.
 */
revoke all on function public.sweep_stranded_generation_jobs(interval, integer)
  from public, anon, authenticated;
grant execute on function public.sweep_stranded_generation_jobs(interval, integer) to postgres;

revoke all on function public.enqueue_generation_job(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_generation_job(jsonb) to authenticated;

revoke all on function public.prune_operational_logs(int, int, int)
  from public, anon, authenticated;
grant execute on function public.prune_operational_logs(int, int, int) to postgres;
