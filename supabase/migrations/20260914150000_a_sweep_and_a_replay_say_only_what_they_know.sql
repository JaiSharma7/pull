/*
 * Two corrections from the sixteenth review round.
 *
 * 1. The sweep's terminal-hold pass had no `settled_at is null` on the outer UPDATE and
 *    left the counters standing. Under READ COMMITTED the subquery's predicate is
 *    evaluated once, so a row the pass blocks on that a concurrent `record_job_step` has
 *    just settled is re-checked only against the outer where clause -- which names the
 *    key and nothing else. It re-stamped `settled_at` with a later `now()`, pushing the
 *    row out of `prune_operational_logs`'s retention window, and left it settled while
 *    still carrying an open call and its cents, which is a state nothing else produces.
 *
 * 2. `enqueue_generation_job`'s replay branch recomputed a queue position for a job that
 *    had already finished or failed, so it answered `queue: 'fast', delaySeconds: 0` --
 *    which `Studio.tsx` prints as "Started." directly above a job list saying the job did
 *    not finish. It reads the status now and says so, which is what the migration that
 *    added the recomputation claimed it was for.
 */

-- ------------------------------------------------------- 1. the sweep, tightened
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
   *
   * `settled_at is null` ON THE OUTER UPDATE, and the counters zeroed. The subquery's
   * predicate is evaluated once: under READ COMMITTED, a row this blocks on that a
   * concurrent `record_job_step` has just settled is re-checked only against the OUTER
   * where clause, so without this it re-stamped a settled row with a later `now()` --
   * pushing it out of `prune_operational_logs`'s retention window -- and left it settled
   * while still carrying an open call and its cents, a state nothing else produces.
   */
  update public.budget_reservations br
     set settled_at     = now(),
         open_calls     = 0,
         reserved_cents = 0
   where br.settled_at is null
     and (br.job_id, br.step) in (
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

-- ------------------------------------------ 2. a replay that knows a job is over
create or replace function public.enqueue_generation_job(
  p_target jsonb,
  p_mutation_id uuid default null
)
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
  replayed   public.generation_jobs%rowtype;
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
   * A REPLAY, answered before anything is spent or counted.
   *
   * Every other write in this app that can be retried carries a mutation id for this --
   * `explanations`, `convictions`, the recall grades -- and the one that spends money
   * did not. A submit whose response is lost (the request committed, the answer never
   * arrived) puts the screen's "that has not reached your account" in front of a reader
   * who then presses again, and the second press bought a second generation: real
   * provider spend against the day's cap, and on an adopted book a second summary of
   * one title on the reader's own shelf.
   *
   * Before the quota, the cap and the insert, so a replay costs nothing and counts for
   * nothing. The answer is the original job's, with `remainingToday` recomputed, because
   * what the caller needs is the job it already has.
   */
  if p_mutation_id is not null then
    /*
     * UNDER THE LOCK, which is the correction rather than a tidy-up.
     *
     * Read before it, two presses racing each other both saw no row -- the button
     * carries `aria-disabled` and stays clickable -- so both fell through, the first
     * inserted, and the second died on `generation_jobs_client_mutation_key` with a raw
     * constraint violation under the form while a job really had started. Taking the
     * per-requester lock first makes the second press wait, and by the time it reads,
     * the first is committed and it replays. The lock is per user and transaction-scoped,
     * and taking it here rather than further down only widens what it covers.
     */
    perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

    select * into replayed
    from public.generation_jobs gj
    where gj.requester_id = uid and gj.client_mutation_id = p_mutation_id;

    if found then
      /*
       * A job that is OVER is over, whatever its place in the queue used to be.
       *
       * This recomputed the stagger for every replay and never looked at the status, so
       * a reader replaying a submit whose job had since failed -- a provider outage, or
       * the budget wait running out -- got `queue: 'fast', delaySeconds: 0`, which the
       * Studio prints as "Started." directly above a job list saying it did not finish.
       * The row already knows; this says so and lets the screen read the job itself.
       */
      if replayed.status in ('succeeded', 'failed', 'cancelled') then
        select count(*) into used
        from public.generation_jobs
        where requester_id = uid
          and created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

        return jsonb_build_object(
          'jobId', replayed.id,
          'kind', replayed.kind,
          'queue', 'fast',
          'delaySeconds', 0,
          'replayed', true,
          'finished', true,
          'status', replayed.status,
          'remainingToday', greatest(daily_hard_ceiling - used, 0),
          'budget', public.generation_budget_state()
        );
      end if;

      /*
       * The placement it ACTUALLY got, not a cheerful default.
       *
       * This answered `queue: 'fast', delaySeconds: 0` for every replay, and the Studio
       * branches on exactly that to print "Started." -- so a reader replaying their 20th
       * job of the day was told a summary had begun that would not start for ninety
       * minutes. Nothing is stored about the delay, but everything needed to recompute it
       * is: the job's own position among that day's jobs is how many the requester had
       * queued before it, which is what decided the stagger at the time.
       */
      select count(*) into used
      from public.generation_jobs gj
      where gj.requester_id = uid
        and gj.created_at >= date_trunc('day', (replayed.created_at at time zone 'utc'))
                             at time zone 'utc'
        -- `(created_at, id)`, because `created_at` alone is not a total order: two jobs
        -- written in the same millisecond would each count the other as later and both
        -- claim the earlier slot. The pair is what the insert order actually was.
        and (gj.created_at, gj.id) < (replayed.created_at, replayed.id);

      over := used >= daily_fast_limit;
      delay_for := case
                     when over then (used - daily_fast_limit + 1) * stagger_seconds
                     else 0
                   end;

      -- What is LEFT of that wait, since some of it has already passed.
      delay_for := greatest(
        delay_for - floor(extract(epoch from (now() - replayed.created_at)))::int, 0);

      select count(*) into used
      from public.generation_jobs
      where requester_id = uid
        and created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

      return jsonb_build_object(
        'jobId', replayed.id,
        'kind', replayed.kind,
        'queue', case when delay_for > 0 then 'normal' else 'fast' end,
        'delaySeconds', delay_for,
        'replayed', true,
        'remainingToday', greatest(daily_hard_ceiling - used, 0),
        'budget', public.generation_budget_state()
      );
    end if;
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

  insert into public.generation_jobs (requester_id, kind, target, status, client_mutation_id)
  values (uid, job_kind, target, 'queued', p_mutation_id)
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

revoke all on function public.enqueue_generation_job(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_generation_job(jsonb, uuid) to authenticated;
