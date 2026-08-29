-- Codex review round 2.
--
-- 1. P1: pg_advisory_xact_lock has exactly two overloads — (bigint) and
--    (integer, integer). The two-key call was passing two bigints from
--    hashtextextended, so set_conviction raised on EVERY call before recording
--    anything. Verified against pg_proc. Use the single-bigint overload on a
--    combined key.
--
-- 2. P2: the shortlist could be entirely consumed by cards the reader already
--    knows, and `diversified` then removed all of them, returning an empty feed
--    while unread cards remained — showing "Enough" prematurely. Directly-known
--    cards are now excluded during the cheap phase, where it costs an index
--    lookup rather than vector work, so only semantically-covered cards can eat
--    into the shortlist. The shortlist also scales with the page size.
--
-- 3. P1 (supporting): job_steps and cost_ledger were two separate writes, so a
--    ledger failure after a succeeded step left the cost permanently unrecorded
--    and unretryable. This RPC makes them one transaction.

create or replace function public.set_conviction(
  p_pull_id    uuid,
  p_stance     public.stance,
  p_confidence real default 0.6,
  p_rationale  text default null
)
returns public.convictions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  fresh public.convictions;
  prior uuid;
begin
  if uid is null then
    raise exception 'set_conviction requires an authenticated user';
  end if;

  -- Single-bigint overload over a combined key. There is no (bigint, bigint)
  -- form, and the (int, int) form would need both halves narrowed to 32 bits.
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(uid::text || ':' || p_pull_id::text, 0)
  );

  select id into prior
  from public.convictions
  where user_id = uid and pull_id = p_pull_id and superseded_by is null;

  -- The partial unique index allows only one un-superseded stance per pull, so
  -- the old row must leave that index before the new one can enter it. Point it
  -- at itself first, then at the replacement once it exists.
  if prior is not null then
    update public.convictions set superseded_by = id where id = prior;
  end if;

  insert into public.convictions (user_id, pull_id, stance, confidence, rationale)
  values (uid, p_pull_id, p_stance, p_confidence, p_rationale)
  returning * into fresh;

  if prior is not null then
    update public.convictions set superseded_by = fresh.id where id = prior;
  end if;

  return fresh;
end;
$$;

comment on function public.set_conviction is
  'Record a stance, superseding the previous one. Serialised per (user, pull) so a concurrent change cannot be lost.';

-- Atomic step + cost accounting for the generation worker.
create or replace function public.record_job_step(
  p_job_id       uuid,
  p_step         text,
  p_attempt      int,
  p_model        text,
  p_prompt_version text,
  p_input_tokens  int,
  p_output_tokens int,
  p_cost_cents    numeric,
  p_duration_ms   int,
  p_provider      text
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
    input_tokens, output_tokens, cost_cents, duration_ms, finished_at
  )
  values (
    p_job_id, p_step, p_attempt, 'succeeded', p_model, p_prompt_version,
    p_input_tokens, p_output_tokens, p_cost_cents, p_duration_ms, now()
  )
  returning id into step_id;

  -- Same transaction: a step can never be recorded as succeeded without its
  -- cost, which would leave the spend permanently unaccounted and unretryable.
  if p_cost_cents > 0 then
    insert into public.cost_ledger (job_id, step_id, provider, operation, unit, quantity, cost_cents)
    values (p_job_id, step_id, p_provider, p_step, 'tokens',
            coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0), p_cost_cents);
  end if;

  return step_id;
end;
$$;

comment on function public.record_job_step is
  'Records a succeeded generation step and its cost atomically. Service role only.';

revoke all on function public.record_job_step(uuid, text, int, text, text, int, int, numeric, int, text)
  from anon, authenticated, public;
