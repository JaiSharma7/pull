/*
 * A hold cannot tell a crash from a call, and should say so.
 *
 * 20260914070000 made a second reserve of one step ADD to the hold rather than replace
 * it, which is right -- pgmq redelivers on a visibility timeout, so a long call can be
 * run twice and both calls spend. The comment it shipped with claimed the condition
 * distinguished a live call from a worker that died holding a reservation. It does not,
 * and nothing in the row could: both leave an unsettled row inside the TTL, and the
 * redelivery arrives at the same 180 seconds either way.
 *
 * The behaviour is unchanged and correct -- over-holding refuses work, under-holding
 * spends money that is already gone -- so this restates the function to say what it
 * actually does and why that is the direction to be wrong in. Law 6 makes migrations
 * append-only, so a comment inside a shipped function is corrected by replacing the
 * function.
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
   * Added to an unsettled hold inside the TTL, replacing anything older.
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
  'Holds money against the daily cap for one provider call, under a global advisory lock. A second call of the same step while an unsettled hold stands adds to it rather than replacing it -- a hold cannot tell a live call from a crashed one, and over-holding is the safe direction.';

revoke all on function public.reserve_budget(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_budget(uuid, text, numeric) to service_role;
