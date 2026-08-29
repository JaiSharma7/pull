-- Expose pgmq's delivery count so the worker has a retry bound it cannot lose.
--
-- The attempt number is derived from the newest `job_steps` row, which assumes
-- every failed attempt manages to record itself. When that insert is the thing
-- that fails -- a dropped connection, the database refusing writes -- no row
-- appears, the next tick derives the same attempt number again, and the job
-- retries forever without ever crossing MAX_ATTEMPTS. Once the stub providers
-- are real, each of those cycles is a billable call with no ceiling.
--
-- `read_ct` is pgmq's own counter: it increments on every delivery, before the
-- worker runs and regardless of what the worker succeeds in writing. That makes
-- it the one bound that survives exactly the failures the ledger cannot record.

drop function if exists public.claim_generation_messages(integer, integer);

create function public.claim_generation_messages(
  p_count integer default 5,
  p_visibility_seconds integer default 180
) returns table (msg_id bigint, message jsonb, read_ct integer)
language plpgsql
security definer
set search_path to ''
as $$
begin
  return query
  select r.msg_id, r.message, r.read_ct
  from pgmq.read('generation', p_visibility_seconds, p_count) r;
end;
$$;

-- Service role only: the queue is not something a reader reaches.
revoke all on function public.claim_generation_messages(integer, integer) from public, anon, authenticated;
