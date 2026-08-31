-- `generation_jobs.cost_cents` has never been written.
--
-- The column has existed since round 1 with a `0` default and nothing incrementing
-- it. The verified end-to-end job is the evidence: its twelve `job_steps` rows sum to
-- 0.3855 cents and two `cost_ledger` rows account for every provider call, while the
-- job itself still reads 0.0000.
--
-- Harmless while one job existed. Not harmless across a corpus: "what did this job
-- cost" is the question law 2's whole argument is settled by, and the obvious place to
-- ask it is the column named for it. A number that is always zero is worse than an
-- absent one — it answers, and the answer is wrong.
--
-- Rolled up here rather than computed on read. A view over `job_steps` would also be
-- correct, but the increment belongs in the same transaction as the ledger insert:
-- that is what makes "the ledger and the job agree" a property of the write rather
-- than something a reader has to reconcile afterwards.
--
-- Both entry points, because law 2 counts every model call and not only the ones that
-- produced something. A `synthesize` that was billed and then rejected for returning
-- no pulls costs exactly what a good one costs.
--
-- Append-only per law 6: these supersede 20260830160437 and 20260830181229.

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
  p_provider      text,
  p_billable      boolean default false,
  p_output        jsonb default null
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

  return step_id;
end;
$$;

comment on function public.record_job_step is
  'Records a succeeded generation step with its output, its ledger entry when a provider was called, and its contribution to the job total — atomically.';

revoke all on function public.record_job_step(uuid, text, int, text, text, int, int, numeric, int, text, boolean, jsonb)
  from anon, authenticated, public;
grant execute on function public.record_job_step(
  uuid, text, int, text, text, int, int, numeric, int, text, boolean, jsonb
) to service_role;

create or replace function public.record_failed_job_step(
  p_job_id        uuid,
  p_step          text,
  p_attempt       int,
  p_error         text,
  p_duration_ms   int,
  p_model         text default null,
  p_provider      text default null,
  p_input_tokens  int default 0,
  p_output_tokens int default 0,
  p_cost_cents    numeric default 0,
  p_billable      boolean default false
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

  return step_id;
end;
$$;

comment on function public.record_failed_job_step is
  'Records a failed generation step, its ledger entry when a provider was billed before the failure, and its contribution to the job total — atomically. Law 2 counts every model call, not only the successful ones.';

revoke all on function public.record_failed_job_step(
  uuid, text, int, text, int, text, text, int, int, numeric, boolean
) from anon, authenticated, public;
grant execute on function public.record_failed_job_step(
  uuid, text, int, text, int, text, text, int, int, numeric, boolean
) to service_role;

-- Backfill what the missing increment already lost. Idempotent by construction: it
-- assigns the sum rather than adding to it, so replaying changes nothing.
update public.generation_jobs j
   set cost_cents = coalesce(
         (select sum(coalesce(s.cost_cents, 0)) from public.job_steps s where s.job_id = j.id),
         0
       )
 where exists (select 1 from public.job_steps s where s.job_id = j.id);
