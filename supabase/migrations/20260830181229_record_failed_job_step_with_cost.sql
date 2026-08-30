-- A provider call that failed validation still cost money.
--
-- `record_job_step` records a succeeded step and, when the step called a provider, its
-- `cost_ledger` row — atomically, so spend can never be lost behind a successful step.
-- The failure path had no equivalent: the worker inserted a `job_steps` row with
-- status 'failed' directly and wrote nothing to the ledger.
--
-- That is fine when the failure is "the provider did not answer", because nothing was
-- billed. It is wrong when the provider answered, charged for the tokens, and returned
-- something the pipeline then rejected — a summary with a blank title or no Pulls. The
-- call is metered by the provider and invisible to us, and because the step retries,
-- every retry adds another unrecorded charge. Spend reports would understate exactly
-- the runs that are burning money without producing anything, which is the opposite of
-- the direction an error should fall in.
--
-- Law 2 is that every model call writes to `cost_ledger`. Not every *successful* one.
--
-- Mirrors `record_job_step` deliberately: same argument order, same atomicity, same
-- `p_billable` meaning. A free or local provider must stay distinguishable from
-- accounting that never happened, so a zero-cost call is still recorded as a call.

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

  return step_id;
end;
$$;

comment on function public.record_failed_job_step is
  'Records a failed generation step and, when a provider was billed before the failure, its ledger entry — atomically. Law 2 counts every model call, not only the successful ones.';

revoke all on function public.record_failed_job_step(
  uuid, text, int, text, int, text, text, int, int, numeric, boolean
) from anon, authenticated, public;
