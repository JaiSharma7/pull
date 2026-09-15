-- A budget for the day.
--
-- Law 2 caps spend per requester: three fast jobs a day, a stagger past that, and a
-- ceiling of fifty (20260829171514, 20260901190000). Every one of those bounds counts
-- rows belonging to ONE identity, which is the right shape for stopping one reader
-- running away with the budget and no shape at all for stopping a hundred readers each
-- spending their allowance on the same afternoon. Fifty jobs at ~$0.056 is $2.80 for
-- one account; it is $280 for a hundred, and nothing in the schema notices.
--
-- Package 8 is what makes that worth fixing rather than theoretical: Studio lets a
-- reader generate a private summary of their own text, so the number of people who can
-- spend goes from "whoever asks for a canonical work" to "everyone". So this adds the
-- bound the per-requester quotas cannot express -- a GLOBAL ceiling on what the product
-- spends in a UTC day.
--
-- WHAT IT DOES NOT DO, stated because the first draft of this comment claimed it did:
-- the two bounds do not compose into "no one reader can exhaust the budget". The
-- per-requester ceiling is 50 jobs and a job reserves 7 cents across `synthesize` and
-- `embed`, so roughly 28 jobs fill a 200-cent cap -- the ceiling never binds before the
-- shared cap does, and one account with a mailbox can spend the day's budget and have
-- every other reader refused with 53400 until 00:00 UTC. The cap bounds the PRODUCT's
-- spend, which is what it is for; it is not a fairness mechanism and there is no
-- per-requester share of it. Adding one is a product decision rather than a patch, so it
-- is named here rather than invented.
--
-- CHECKING A NUMBER BEFORE SPENDING IS NOT A CAP, and this is the whole design. Two
-- workers reading `spend_today()` at the same moment both see the same figure, both
-- decide they are under the cap, and both spend -- and the overshoot is unbounded in the
-- number of workers, not by one job. A cap is a RESERVATION: under a global lock, the
-- worst case of the step about to run is written down, counted against the cap by
-- everyone who looks, and replaced by the real charge when the ledger row lands. A step
-- that never reaches the ledger leaves a reservation, which is why one older than an
-- hour is ignored and why the stranded-job sweep settles what it fails.
--
-- WHAT COUNTS AS SPENT, exactly: today's `cost_ledger` rows plus today's open
-- reservations, and nothing else. Never `generation_jobs.cost_cents` --
-- `record_job_step` already rolls every ledgered charge into that column
-- (20260830214412:64-77, 123-135), so a sum over both reports double the real spend and
-- slams the cap at half of it. That is not a conservative error; it is a cap of $1 that
-- claims to be $2, which is worse than either.
--
-- `generation_jobs` also loses INSERT from the API roles. A reader-inserted row must
-- never be able to carry a `cost_cents` of its own choosing, and `enqueue_generation_job`
-- is the only legitimate writer. This is defence in depth rather than the fix: RLS is on
-- and `generation_jobs_insert_own` was dropped by
-- 20260830200114_close_generation_write_and_read_leaks.sql and never recreated, so with
-- no permissive INSERT policy the grant is already moot. Revoking it means the next
-- person to add a policy has to also add a grant, deliberately.
--
-- Law 2 holds throughout: arithmetic over two tables and an advisory lock. No model runs
-- anywhere in here.

-- ---------------------------------------------------------------- 1. the cap

/*
 * The cap, as a function rather than a row.
 *
 * A settings table would be one more thing with RLS to get wrong, and a number a
 * reader could read tells them exactly how much to spend to close the door on
 * everyone else. `immutable` so the planner can fold it, and changing it is a
 * migration -- which is the right amount of friction for the number that decides
 * whether the product can afford to stay up.
 *
 * 200 cents is a day. One canonical generation is ~5.6 cents, so the cap is
 * roughly thirty-five generations a day across everybody, which is comfortably
 * above the current corpus's rate and far below a runaway.
 */
create function public.daily_spend_cap_cents()
returns numeric
language sql
immutable
set search_path = ''
as $$ select 200::numeric $$;

comment on function public.daily_spend_cap_cents is
  'The global ceiling on provider spend in one UTC day, in cents. See 20260914010000.';

revoke all on function public.daily_spend_cap_cents() from public;
grant execute on function public.daily_spend_cap_cents() to authenticated, service_role;

-- ------------------------------------------------- 2. reservations, and spend

create table public.budget_reservations (
  job_id         uuid           not null references public.generation_jobs (id) on delete cascade,
  step           text           not null,
  reserved_cents numeric(12, 4) not null,
  created_at     timestamptz    not null default now(),
  settled_at     timestamptz,
  primary key (job_id, step),
  constraint budget_reservations_positive check (reserved_cents >= 0)
);

comment on table public.budget_reservations is
  'What a step is about to spend, in cents, held against the daily cap until the '
  'cost_ledger row for it lands. Keyed (job_id, step) so a redelivered message reuses '
  'its reservation rather than opening a second one. See 20260914010000.';

-- The primary key leads on `job_id`, which is the foreign key's column, so invariant 3
-- is satisfied without a second index. An index on `settled_at` would not pay for
-- itself: the open set is bounded by the number of steps in flight.

-- Law 5: RLS and a policy in the table's own migration. Nobody reading through the API
-- may see this, for the same reason `cost_ledger` is `using (false)` -- what the product
-- spends, and on which jobs, is not a reader's business. `service_role` bypasses RLS, so
-- the two functions below still work.
alter table public.budget_reservations enable row level security;

create policy budget_reservations_no_api_access on public.budget_reservations
  for select using (false);

/*
 * How long an unsettled reservation is believed.
 *
 * A step that dies between reserving and recording leaves money held against a
 * cap for a charge that never happened. The sweep settles what it fails, but a
 * crash the sweep has not reached yet would otherwise hold the cap down until
 * somebody noticed. An hour is far longer than any step takes (the worker holds a
 * message for 180 s) and far shorter than a day, so the worst case is a cap that
 * is briefly tighter than it should be -- which fails in the safe direction.
 */
create function public.budget_reservation_ttl()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '1 hour' $$;

revoke all on function public.budget_reservation_ttl() from public;
grant execute on function public.budget_reservation_ttl() to service_role;

/*
 * What has been spent today, and what is about to be.
 *
 * The ledger for what actually happened, plus the reservations for what is in
 * flight, both bounded to the UTC day -- and nothing else. See the header on why
 * `generation_jobs.cost_cents` is excluded.
 *
 * Granted to `authenticated` so Studio can tell a reader there is no budget left
 * today rather than letting them submit into a refusal. Refused to `anon`: a
 * signed-out visitor cannot enqueue, so the number tells them nothing they can
 * act on and tells anyone else how close the product is to its own ceiling.
 */
create function public.spend_today()
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
               and br.created_at >= now() - public.budget_reservation_ttl()),
           0);
$$;

comment on function public.spend_today is
  'Provider spend so far in this UTC day: the cost_ledger plus open reservations. '
  'Never generation_jobs.cost_cents, which is a second copy of every ledgered charge.';

revoke all on function public.spend_today() from public, anon;
grant execute on function public.spend_today() to authenticated, service_role;

-- ----------------------------------------------- 3. reserve, and settle again

/*
 * Hold the worst case of one step against the cap, or refuse.
 *
 * GLOBAL lock, not per job. The whole point is that two DIFFERENT jobs must not
 * both read the same total and both proceed; a per-job lock would serialise the
 * one case that was never in contention and leave the one that was. It is an
 * xact lock, so it is released by commit or rollback with nothing to clean up.
 *
 * The reservation for (job, step) is excluded from the total it is measured
 * against, so a redelivered message re-reserving the same step is not counted
 * against itself and pushed over a cap it already fits inside.
 *
 * 53400 is `configuration_limit_exceeded`, which is what the worker matches on to
 * requeue rather than fail: a job that arrives when the day's budget is gone is
 * not a broken job, it is an early job.
 */
create function public.reserve_budget(p_job_id uuid, p_step text, p_cents numeric)
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

comment on function public.reserve_budget is
  'Hold p_cents against the daily cap for one step, or raise 53400. Returns what is '
  'left. service_role only -- a caller who can reserve can also starve the budget.';

revoke all on function public.reserve_budget(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_budget(uuid, text, numeric) to service_role;

/*
 * Release a hold, because the real charge has landed or never will.
 *
 * Idempotent, and deliberately silent about a reservation that was never made: a
 * step that did not reserve (a free provider, a local stub) still settles, and
 * making that an error would put a branch in the two recorders below for a case
 * that means nothing went wrong.
 */
create function public.settle_budget(p_job_id uuid, p_step text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.budget_reservations
     set settled_at = now()
   where job_id = p_job_id and step = p_step and settled_at is null;
$$;

comment on function public.settle_budget is
  'Close the hold for one step. Called by record_job_step and record_failed_job_step, '
  'so the ledger row replaces the reservation in the same transaction.';

revoke all on function public.settle_budget(uuid, text) from public, anon, authenticated;
grant execute on function public.settle_budget(uuid, text) to service_role;

-- --------------------------------- 4. the recorders settle what they replace

/*
 * `record_job_step`, restated from 20260830214412 with one statement added.
 *
 * The body is that migration's verbatim -- the step insert, the conditional ledger
 * row, the unconditional roll-up into `generation_jobs.cost_cents` and the comment
 * explaining why it is unconditional -- plus `settle_budget` at the end. Settling
 * here rather than in the worker is what makes the swap ATOMIC: the ledger row and
 * the release of the hold are one transaction, so there is no instant in which the
 * charge is counted twice and none in which it is counted not at all.
 *
 * Unconditional on `p_billable`, like the roll-up above it and for the same reason.
 * A step that reserved and then turned out to cost nothing still has to let go.
 */
create or replace function public.record_job_step(
  p_job_id uuid,
  p_step text,
  p_attempt integer,
  p_model text,
  p_prompt_version text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost_cents numeric,
  p_duration_ms integer,
  p_provider text,
  p_billable boolean default false,
  p_output jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  step_id uuid;
begin
  insert into public.job_steps (
    job_id, step, attempt, status, model, prompt_version,
    input_tokens, output_tokens, cost_cents, duration_ms, output, finished_at
  )
  values (
    p_job_id, p_step, p_attempt, 'succeeded', p_model, p_prompt_version,
    p_input_tokens, p_output_tokens, p_cost_cents, p_duration_ms, p_output, now()
  )
  returning id into step_id;

  if p_billable then
    insert into public.cost_ledger (job_id, step_id, provider, operation, unit, quantity, cost_cents)
    values (p_job_id, step_id, p_provider, p_step, 'tokens',
            coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0),
            coalesce(p_cost_cents, 0));
  end if;

  -- Unconditional, not gated on `p_billable`. A free or local provider spends zero
  -- and adding zero is correct; skipping the update would make the job's total
  -- depend on which provider happened to run, which is the distinction the ledger
  -- already draws and this column should not re-litigate.
  update public.generation_jobs
     set cost_cents = coalesce(cost_cents, 0) + coalesce(p_cost_cents, 0)
   where id = p_job_id;

  -- The hold this step took is replaced by the charge above, in this transaction.
  perform public.settle_budget(p_job_id, p_step);

  return step_id;
end;
$$;

/*
 * `record_failed_job_step`, restated from 20260830214412, same one addition.
 *
 * A failed step that was billed still spent the money and still has to release
 * what it held; a failed step that was not billed held money for a charge that
 * will never arrive, and releasing it is the only thing standing between a
 * provider outage and a cap pinned shut for an hour.
 */
create or replace function public.record_failed_job_step(
  p_job_id uuid,
  p_step text,
  p_attempt integer,
  p_error text,
  p_duration_ms integer,
  p_model text default null,
  p_provider text default null,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0,
  p_cost_cents numeric default 0,
  p_billable boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  step_id uuid;
begin
  insert into public.job_steps (
    job_id, step, attempt, status, model,
    input_tokens, output_tokens, cost_cents, duration_ms, error, finished_at
  )
  values (
    p_job_id, p_step, p_attempt, 'failed', p_model,
    p_input_tokens, p_output_tokens, p_cost_cents, p_duration_ms, p_error, now()
  )
  returning id into step_id;

  if p_billable then
    insert into public.cost_ledger (job_id, step_id, provider, operation, unit, quantity, cost_cents)
    values (p_job_id, step_id, p_provider, p_step, 'tokens',
            coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0),
            coalesce(p_cost_cents, 0));
  end if;

  -- A failed step that was billed still spent the money, and a retry spends more.
  -- A job total that counted only successes would understate exactly the runs
  -- someone is investigating because they cost more than they should have.
  update public.generation_jobs
     set cost_cents = coalesce(cost_cents, 0) + coalesce(p_cost_cents, 0)
   where id = p_job_id;

  perform public.settle_budget(p_job_id, p_step);

  return step_id;
end;
$$;

-- ------------------------------------- 5. the sweep releases what it abandons

/*
 * `sweep_stranded_generation_jobs`, restated from 20260902170000.
 *
 * The selection, the three-minute floor, the `for update skip locked` and the
 * failure update are that migration's verbatim. What is added is the settlement:
 * a job this sweep declares dead is a job whose steps will never record, so every
 * hold it is carrying has to be released here or it sits until the TTL expires.
 *
 * The TTL means a missed settlement is recoverable rather than permanent, and this
 * means the common case is recovered in ten minutes rather than sixty.
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

  -- Nothing will ever record for these steps, so nothing else will release them.
  update public.budget_reservations br
     set settled_at = now()
   where br.job_id = any (stranded)
     and br.settled_at is null;

  return swept;
end;
$$;

-- ------------------------------------------------- 6. what may be enqueued

/*
 * `generation_jobs` is written by one function and no other.
 *
 * RLS is on with no permissive INSERT policy -- `generation_jobs_insert_own` was
 * dropped by 20260830200114 and never recreated -- so this grant has been moot for
 * a fortnight. Revoking it is defence in depth: it makes recreating a policy
 * insufficient on its own, so a future migration has to say out loud that it wants
 * readers inserting rows that carry a `cost_cents` and a `visibility`.
 */
revoke insert on public.generation_jobs from anon, authenticated;

/*
 * `enqueue_generation_job`, restated from 20260901190000.
 *
 * Every bound that migration established is verbatim: the authenticated check, the
 * positive `is_anonymous is not true` assertion and the reason it is positive, the
 * per-requester advisory lock, the UTC-day count with its cast, the hard ceiling,
 * the free allowance and the stagger. Four things are added, and nothing is removed:
 *
 *   * THE GLOBAL CAP. Checked here as well as in the worker, so a day whose budget
 *     is gone refuses at the door rather than queueing work that will sit in
 *     `BUDGET_WAIT` until the day turns over. 53400, which the client renders as a
 *     sentence about today rather than as an error.
 *   * THE JOB KIND. `generation_jobs.kind` has existed since the table was created
 *     and has been written by nothing, so every row says `canonical_summary`
 *     whatever it actually was. Studio needs the two to be distinguishable --
 *     `private_summary` publishes nothing and is readable only by its requester --
 *     and a column that already exists is where that belongs. Narrowed to the two
 *     values the pipeline implements, so a typo is a refusal rather than a job
 *     nothing will ever pick up.
 *   * BOUNDS ON THE PAYLOAD. `acquire` already refuses text under 200 characters;
 *     the ceiling is what stops one call carrying a novel into the hash and the
 *     provider. 200,000 matches the pipeline's own truncation, and 200 for a title
 *     matches `works.title`.
 *   * `work_id`, KEPT ONLY WHERE IT IS THE CALLER'S. The pipeline adopts
 *     `target.work_id` so an imported book gains a summary rather than a second
 *     `works` row, and the guard is the one 8b relies on: the requester must have
 *     authored a summary on that work. Anything else -- absent, malformed, or
 *     somebody else's -- is stripped rather than refused, because a target the
 *     caller could not have meant is not worth an error the client has to explain.
 *
 * `visibility` is stripped for the same reason: `generation_jobs.visibility`
 * defaults to private and the pipeline reads the column, but the target is stored
 * verbatim and a key that looks like an instruction should not be sitting in it.
 */
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

  -- Asserted positively, so an absent row refuses rather than proceeds. `exists(... and
  -- is_anonymous)` is false when the row is missing or the column is null, and false
  -- means "not a guest, carry on" -- which is the fail-open direction this function must
  -- not take. A caller with no row is reachable: an account deleted by
  -- `delete_my_account`, or swept by section 4 of 20260901190000, still holds an
  -- unexpired access token for up to `jwt_expiry`.
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

  -- Stripped unless the caller authored a summary on that work. Matched against the
  -- uuid shape first: a malformed value would raise 22P02 from the cast, which is an
  -- error about a key the caller should simply not have sent.
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

  -- The global cap, before the per-requester quota: a day that has no budget left
  -- refuses everybody, and saying so here is cheaper than queueing work that would
  -- wait sixteen hours for midnight.
  spent := public.spend_today();
  if spent >= cap then
    raise exception
      'the daily generation budget is spent (% of % cents). Summaries resume at '
      '00:00 UTC.', round(spent, 4), cap
      using errcode = '53400';
  end if;

  -- Serialise per requester, so two concurrent calls cannot both read the same
  -- pre-insert count and both decide they are under the limit.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

  -- `date_trunc('day', now() at time zone 'utc')` is a NAIVE timestamp, and comparing a
  -- `timestamptz` against one coerces it using the session's TimeZone rather than UTC.
  -- The explicit `at time zone 'utc'` is what keeps the boundary in UTC on a connection
  -- that is set to something else.
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

  -- Staggered, not fixed: each job past the allowance is scheduled a further
  -- interval out, so the queue drains at a bounded rate instead of all at once.
  delay_for := case
                 when over then (used - daily_fast_limit + 1) * stagger_seconds
                 else 0
               end;

  insert into public.generation_jobs (requester_id, kind, target, status)
  values (uid, job_kind, target, 'queued')
  returning id into job_id;

  -- Same transaction as the insert, so there is no half-created state.
  perform pgmq.send('generation',
                    jsonb_build_object('jobId', job_id, 'step', 'resolve_identity'),
                    delay_for);

  return jsonb_build_object(
    'jobId', job_id,
    'kind', job_kind,
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for,
    'remainingToday', daily_hard_ceiling - used - 1,
    'spentTodayCents', round(spent, 4),
    'dailyCapCents', cap
  );
end;
$$;
