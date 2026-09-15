-- A wait knows what it is waiting for.
--
-- `requeue_generation_message` (20260902200000) re-sends a step with a delay and a count,
-- so a job waiting on a source another job is synthesising does not spend the same
-- `MAX_ATTEMPTS` budget a real failure does. It carries ONE counter, because when it was
-- written there was one thing to wait for.
--
-- 8b adds a second. A step that cannot reserve against the daily spend cap
-- (20260914010000) is also waiting rather than failing -- the budget returns at 00:00 UTC
-- and the job is early, not broken -- but it waits on a completely different timescale:
-- thirty minutes is longer than any source claim survives, and sixteen hours is the worst
-- case for a day that filled at 08:00.
--
-- Sharing the counter couples them, and the coupling is a real bug rather than an
-- inelegance: `synthesize` claims the source BEFORE it reserves, so one job can meet both
-- states, and a budget wait that bumped the shared count would make the next source hold
-- fail terminally after fewer waits than it is allowed. Each kind of waiting gets its own
-- count, and each is bounded by its own reason.
--
-- The five-argument form is dropped rather than left beside the six: a defaulted parameter
-- creates an overload, and an overload of a function whose whole job is to be the ONE
-- place a message is archived and re-sent is precisely the shape that lets a caller keep
-- using the version that forgets half the state. `supabase/functions/worker` is the only
-- caller, and it is updated in the same change.

drop function if exists public.requeue_generation_message(bigint, uuid, text, int, int);

create function public.requeue_generation_message(
  p_msg_id         bigint,
  p_job_id         uuid,
  p_step           text,
  p_delay_seconds  int,
  p_waits          int,
  p_budget_waits   int default 0
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  -- The archive is the guard. A delivery that outlived its visibility timeout is
  -- redelivered under the same msg_id, and both deliveries can reach `held`; the
  -- second finds nothing to archive and must send nothing, or the job has two
  -- live messages for one step -- and both would be granted the claim (same job)
  -- and both would pay. Null tells the worker the wait is already queued.
  if not pgmq.archive('generation', p_msg_id) then
    return null;
  end if;
  select pgmq.send('generation',
                   jsonb_build_object('jobId', p_job_id,
                                      'step', p_step,
                                      'waits', greatest(coalesce(p_waits, 0), 0),
                                      'budgetWaits', greatest(coalesce(p_budget_waits, 0), 0)),
                   greatest(coalesce(p_delay_seconds, 0), 0))
    into new_id;
  return new_id;
end;
$$;

comment on function public.requeue_generation_message(bigint, uuid, text, int, int, int) is
  'Archive a message and re-send it with a delay, carrying both wait counts. A wait on a '
  'held source and a wait on the daily budget are bounded separately: see 20260914020000.';

revoke all on function public.requeue_generation_message(bigint, uuid, text, int, int, int)
  from public, anon, authenticated;
grant execute on function public.requeue_generation_message(bigint, uuid, text, int, int, int)
  to service_role;
