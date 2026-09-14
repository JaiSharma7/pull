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
-- One more, from the same round: `spend_today()` and `reserve_budget` counted every
-- open reservation inside the one-hour TTL WITHOUT bounding it to the UTC day. A hold
-- taken at 23:58 for a call that stalls is still inside its TTL at 00:05, so the new
-- day opened with cents spent on it that belong to a day already closed out -- and a
-- provider stall at the boundary is exactly what produces several of them at once.
-- Both are restated here with the day bound the ledger half already had. The charge, if
-- it ever lands, writes its `cost_ledger` row on the day it lands, so nothing is lost by
-- letting yesterday's holds expire with yesterday.
--
-- And one disclosure, from the same round: 20260914010000 argued that a readable
-- budget number "tells them exactly how much to spend to close the door on everyone
-- else", admitted one account can close that door, and then granted `spend_today()`
-- and `daily_spend_cap_cents()` to every signed-in reader. `generation_budget_state()`
-- replaces both for the client with `open | low | spent`, and the figures go back
-- behind the service role.
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

/*
 * `spend_today()`, restated from 20260914010000 with the day bound on both halves.
 *
 * The ledger half was already bounded to the UTC day; the reservation half was bounded
 * only by the TTL, so a hold taken minutes before midnight was charged against the
 * morning. `least(day start, now - ttl)` is not the answer -- a hold must satisfy BOTH,
 * so the two predicates stand together and the tighter one wins whenever they disagree,
 * which is the first hour of every day.
 */
create or replace function public.spend_today()
returns numeric
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(
           (select sum(cl.cost_cents)
              from public.cost_ledger cl
             where cl.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc'),
           0)
       + coalesce(
           (select sum(br.reserved_cents)
              from public.budget_reservations br
             where br.settled_at is null
               and br.created_at >= now() - public.budget_reservation_ttl()
               and br.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc'),
           0);
$$;

comment on function public.spend_today is
  'Provider spend so far in this UTC day: the cost_ledger plus open reservations TAKEN '
  'TODAY. Never generation_jobs.cost_cents, which is a second copy of every ledgered '
  'charge. See 20260914010000 and 20260914030000.';

revoke all on function public.spend_today() from public, anon;
grant execute on function public.spend_today() to authenticated, service_role;

/*
 * `reserve_budget`, restated from 20260914010000 with the same day bound.
 *
 * Every other line is that migration's verbatim: the global advisory lock, the
 * exclusion of the (job, step) being replaced, the 53400, the on-conflict reuse.
 * A cap that refused a worker at 00:05 for a hold belonging to yesterday would stall
 * the first generations of every day.
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
begin
  if p_job_id is null or p_step is null or p_step = '' then
    raise exception 'reserve_budget needs a job and a step' using errcode = '22023';
  end if;

  -- One lock for the whole budget. The constant is arbitrary and only has to be
  -- the same one every caller uses.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('what-a-pull:budget', 0));

  select coalesce(sum(cl.cost_cents), 0) into committed
  from public.cost_ledger cl
  where cl.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

  select coalesce(sum(br.reserved_cents), 0) into held
  from public.budget_reservations br
  where br.settled_at is null
    and br.created_at >= now() - public.budget_reservation_ttl()
    and br.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc'
    and not (br.job_id = p_job_id and br.step = p_step);

  if committed + held + want > cap then
    raise exception
      'the daily generation budget is spent (% of % cents held or charged); this step '
      'needs % more', round(committed + held, 4), cap, round(want, 4)
      using errcode = '53400';
  end if;

  insert into public.budget_reservations (job_id, step, reserved_cents)
  values (p_job_id, p_step, want)
  on conflict (job_id, step) do update
    set reserved_cents = excluded.reserved_cents,
        created_at     = now(),
        settled_at     = null;

  return cap - (committed + held + want);
end;
$$;

revoke all on function public.reserve_budget(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_budget(uuid, text, numeric) to service_role;

-- ------------------------------------- a reader is told THAT, not HOW MUCH

/*
 * Whether there is budget left, without saying how much.
 *
 * 20260914010000 rejected a settings table on the grounds that "a number a reader
 * could read tells them exactly how much to spend to close the door on everyone
 * else", admitted in the same header that one account CAN close that door, and then
 * granted `spend_today()` and `daily_spend_cap_cents()` to `authenticated` — which
 * hands every signed-in reader both halves of exactly that number, with a live
 * progress read to confirm the attempt is working. The review of this PR put the two
 * halves of the contradiction side by side.
 *
 * Studio needs one sentence: can I start something now, or is today done. This is
 * that sentence and nothing more. `low` exists because "spent" arriving with no
 * warning reads as a fault, and a fifth of a day's budget is not a targeting number:
 * it moves in steps of whole generations and says nothing about where the line is.
 *
 * `stable`, not `immutable` -- it reads two tables.
 */
create function public.generation_budget_state()
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select case
           when public.spend_today() >= public.daily_spend_cap_cents() then 'spent'
           when public.spend_today() >= public.daily_spend_cap_cents() * 0.8 then 'low'
           else 'open'
         end;
$$;

comment on function public.generation_budget_state is
  'open | low | spent. What a reader may be told about the daily generation budget: '
  'whether there is room, never how much. See 20260914030000.';

revoke all on function public.generation_budget_state() from public, anon;
grant execute on function public.generation_budget_state() to authenticated, service_role;

/*
 * And the exact figures go back behind the service role.
 *
 * `spend_today()` is what the worker and the cap check read; nothing a reader can
 * reach needs the number itself now that `generation_budget_state()` exists.
 * `daily_spend_cap_cents()` is the other half of the same subtraction, so it goes with
 * it -- a cap alone is harmless, a cap beside a spend is a countdown.
 */
revoke execute on function public.spend_today() from authenticated;
revoke execute on function public.daily_spend_cap_cents() from authenticated;

/*
 * `enqueue_generation_job`, restated from 20260914010000 without the two figures.
 *
 * Every bound is that migration's verbatim -- the authenticated check, the positive
 * `is_anonymous` assertion, the job-kind and payload validation, the `work_id` guard,
 * the cap check, the per-requester lock, the UTC-day count, the ceiling, the stagger.
 * What changes is the RETURN: `spentTodayCents` and `dailyCapCents` handed the caller
 * the same countdown `generation_budget_state()` exists to withhold, and a payload is a
 * disclosure like any other. `budget` carries the coarse state instead, so the client
 * still has its sentence.
 */
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

  spent := public.spend_today();
  if spent >= cap then
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
