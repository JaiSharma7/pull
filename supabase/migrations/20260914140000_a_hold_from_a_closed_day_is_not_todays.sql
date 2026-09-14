/*
 * Three corrections from the fifteenth review round, all in the budget machinery.
 *
 * 1. `reserve_budget`'s stacking test asked only about the TTL while the sum that
 *    decides whether there is room asks about the TTL AND the UTC day. So a hold taken
 *    at 23:58 by a worker that died was excluded from the total at 00:05 and then
 *    stacked onto by the first reserve of the new day -- twelve cents charged against a
 *    cap that had counted none of it, re-stamped with today's date and a fresh
 *    `created_at` that also put it out of the TTL's reach. Both halves now ask the same
 *    question.
 *
 * 2. The sweep's terminal-hold pass had no `p_limit`, unlike the stranded-job selection
 *    directly above it that is bounded so one tick cannot run past `statement_timeout`.
 *    After an outage leaves thousands of open holds, a tick that times out aborts the
 *    whole function and rolls back the pass above it, so no tick ever completes and the
 *    holds stay open until the TTL -- the state the sweep exists to shorten.
 *
 * 3. `record_mute_impression` overwrote the impression a READ had already written for
 *    that card and day. `feed_impressions` is one row per `(user, pull, shown_on)`, and
 *    `record_read` puts the position the card was read at in it; a mute further down the
 *    feed then replaced both the action and the position, so the read event was gone and
 *    the only surviving telemetry said the card was muted. A mute is a second event
 *    about a card, not a correction of the first.
 */

-- ------------------------------------------------------------- 1. the day bound
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

  /*
   * Every open hold, INCLUDING this step's own.
   *
   * It used to exclude `(p_job_id, p_step)`, on the reading that a step re-reserving is
   * refreshing what it already holds rather than asking for more. The only way to reach
   * that line with an unsettled row is the concurrent redelivery above -- every other
   * path settles before it re-reserves -- so the exclusion did not describe a refresh,
   * it described a second call and then hid it.
   *
   * Both day bounds stay: a hold belongs to the day it was taken in, and one older than
   * the TTL is a worker that died rather than money in flight.
   */
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

  /*
   * Added to an unsettled hold inside the TTL AND inside today, replacing anything else.
   *
   * WHICH IS NOT THE SAME AS "a live call", and the comment here used to claim it was.
   * Nothing in the row can tell a call still inside its provider from one whose worker
   * was killed before it could settle: both leave an unsettled row, and the redelivery
   * that follows arrives at the same 180 s visibility timeout either way. So this has to
   * choose which way to be wrong, and stacking is the safe direction --
   *
   *   stack:   a dead call's money is held twice, and the day is short by that much
   *            until the job goes terminal (the sweep settles every hold it has) or the
   *            one-hour TTL stops counting it. The cap refuses work it could have run.
   *   replace: a LIVE second call holds nothing, the first settle releases everything,
   *            and the cap is overshot by real money that has already been spent.
   *
   * A cap that occasionally refuses too much is a cap. One that occasionally spends
   * past itself is not, which is why this stacks and the sweep and the TTL are what
   * clear up after a crash.
   *
   * THE DAY BOUND IS THE ADDITION. The stacking test asked only about the TTL, while the
   * sum above -- which decides whether there is room at all -- also requires the hold to
   * belong to today. So a 6-cent hold taken at 23:58 by a worker that died was excluded
   * from the total at 00:05 and then STACKED ONTO by the first reserve of the new day:
   * twelve cents charged against a cap that had counted none of it, stamped with today's
   * date and given a fresh `created_at`, which also put it out of the TTL's reach. Both
   * halves now ask the same question, so a hold from a closed day is replaced rather
   * than adopted.
   */
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

-- ----------------------------------------------------------- 2. a bounded sweep
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
   *
   * AND BOUNDED BY `p_limit`, like the selection above and for the same reason. This
   * joined every open hold to every terminal job in one statement: after an outage
   * leaves thousands of them, a tick that runs past `statement_timeout` aborts the whole
   * function, which rolls back the stranded-job pass with it -- so no tick ever
   * completes and the holds the sweep exists to release stay open until the TTL. Oldest
   * first, so the ones nearest to being forgotten go first and the rest follow on the
   * next tick.
   */
  update public.budget_reservations br
     set settled_at = now()
   where (br.job_id, br.step) in (
     select b.job_id, b.step
     from public.budget_reservations b
     join public.generation_jobs gj on gj.id = b.job_id
     where b.settled_at is null
       and b.created_at < now() - p_older_than
       and gj.status in ('succeeded', 'failed', 'cancelled')
     order by b.created_at
     limit greatest(coalesce(p_limit, 0), 0)
   );

  return swept;
end;
$$;

revoke all on function public.sweep_stranded_generation_jobs(interval, integer)
  from public, anon, authenticated;
grant execute on function public.sweep_stranded_generation_jobs(interval, integer) to postgres;

-- ------------------------------------------- 3. a mute does not erase the read
create or replace function public.record_mute_impression(p_pull_id uuid, p_position int default 0)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.feed_impressions (user_id, pull_id, position, action)
  select (select auth.uid()), p_pull_id, coalesce(p_position, 0), 'muted'
  where (select auth.uid()) is not null
  on conflict (user_id, pull_id, shown_on) do update
    -- The action moves and the POSITION DOES NOT. `record_read` writes this row with the
    -- position the card was read at, and a mute reached further down the feed was
    -- overwriting it -- so the one place that recorded where the reader actually met the
    -- card said instead where they were when they muted it. The position on the insert
    -- path is still the mute's, because there no read was recorded to keep.
    set action = 'muted';
$$;

comment on function public.record_mute_impression is
  'Mark the card a reader muted from, on the server''s clock, without erasing where the read that preceded it happened. See 20260914030000, 20260914110000 and 20260914140000.';

revoke all on function public.record_mute_impression(uuid, int) from public, anon;
grant execute on function public.record_mute_impression(uuid, int) to authenticated;
