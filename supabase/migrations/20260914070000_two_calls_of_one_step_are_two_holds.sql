/*
 * A redelivered step holds its own money.
 *
 * `budget_reservations` is keyed `(job_id, step)`, and `reserve_budget` upserted onto
 * that key while EXCLUDING the same `(job, step)` from the total it checked -- so a
 * second call of one step was free by construction. That is right for a retry, where the
 * earlier hold is already settled, and wrong for the case pgmq actually produces: the
 * worker holds a message for 180 s, a long `synthesize` runs past it, the message is
 * redelivered, and a second worker runs the same step while the first is still inside its
 * provider call. There is no `succeeded` row yet, so the resume guard does not fire. Two
 * six-cent calls were counted as one six-cent hold, and then the first one to return
 * settled it -- leaving the second call's spend held by nothing at all, which is the
 * overshoot the whole reservation exists to prevent.
 *
 * Counting the calls is what fixes it, rather than re-keying the table: a hold now knows
 * how many calls are standing behind it, a second reserve ADDS to it, and a settle takes
 * one call's share away and stamps the row only when the last one is gone. The exclusion
 * clause goes with it -- it was the line that made the double spend invisible.
 *
 * What this does NOT claim to fix: the double spend itself. Two concurrent calls of one
 * step cost twice, both reach `cost_ledger` through their own `record_job_step`, and that
 * is a property of an at-least-once queue rather than of the cap. What the cap has to do
 * is see the money while it is in flight, and now it does.
 */

alter table public.budget_reservations
  add column if not exists open_calls int not null default 1;

alter table public.budget_reservations
  drop constraint if exists budget_reservations_calls_positive;
alter table public.budget_reservations
  add constraint budget_reservations_calls_positive check (open_calls >= 0);

comment on column public.budget_reservations.open_calls is
  'How many provider calls are standing behind this hold. More than one means a step was redelivered while its first call was still running; the hold is released a share at a time.';

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
   * Added to a live hold, replacing a dead one.
   *
   * "Live" is unsettled AND inside the TTL: a row left behind by a worker that died is
   * not a call this one should be stacking onto, and treating it as one would hold its
   * money twice until the sweep or the TTL cleared it.
   */
  insert into public.budget_reservations (job_id, step, reserved_cents, open_calls)
  values (p_job_id, p_step, want, 1)
  on conflict (job_id, step) do update
    set reserved_cents =
          case
            when budget_reservations.settled_at is null
             and budget_reservations.created_at >= now() - public.budget_reservation_ttl()
            then budget_reservations.reserved_cents + excluded.reserved_cents
            else excluded.reserved_cents
          end,
        open_calls =
          case
            when budget_reservations.settled_at is null
             and budget_reservations.created_at >= now() - public.budget_reservation_ttl()
            then budget_reservations.open_calls + 1
            else 1
          end,
        created_at = now(),
        settled_at = null;

  return cap - (committed + held + want);
end;
$$;

comment on function public.reserve_budget(uuid, text, numeric) is
  'Holds money against the daily cap for one provider call, under a global advisory lock. A second call of the same step while the first is still open adds to the hold rather than replacing it.';

create or replace function public.settle_budget(p_job_id uuid, p_step text)
returns void
language sql
security definer
set search_path = ''
as $$
  /*
   * ONE CALL'S SHARE, and the row is stamped only when the last call is gone.
   *
   * Every call of a step reserves the same amount -- `RESERVE_CENTS` in `pipeline.ts` is
   * per step -- so an equal share is the right amount to give back, and the last settle
   * zeroes whatever rounding left behind. Stamping on the first settle is what let a
   * concurrent second call spend against money nobody was holding.
   */
  update public.budget_reservations br
     set open_calls     = greatest(br.open_calls - 1, 0),
         reserved_cents = case
                            when br.open_calls <= 1 then 0
                            else br.reserved_cents - (br.reserved_cents / br.open_calls)
                          end,
         settled_at     = case when br.open_calls <= 1 then now() else null end
   where br.job_id = p_job_id and br.step = p_step and br.settled_at is null;
$$;

comment on function public.settle_budget(uuid, text) is
  'Releases one provider call''s share of a step''s hold, and stamps the hold settled when the last outstanding call releases it.';

revoke all on function public.reserve_budget(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_budget(uuid, text, numeric) to service_role;
revoke all on function public.settle_budget(uuid, text) from public, anon, authenticated;
grant execute on function public.settle_budget(uuid, text) to service_role;
