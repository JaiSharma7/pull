-- Let a generation step persist what it produced.
--
-- `job_steps.output jsonb` has existed since round 1 and nothing has ever written
-- it, because `record_job_step` takes no output parameter. That is fine while
-- every step is a stub returning nothing, and blocking the moment they are real:
-- the twelve steps are a pipeline, and `acquire` has to hand text to `chunk`,
-- which hands boundaries to `extract_evidence`, and so on. Without somewhere to
-- put that, each step can only start from the job row again.
--
-- Stored per step rather than accumulated on `generation_jobs` so the record stays
-- append-only and attributable: when a summary comes out wrong, the question is
-- which step produced the bad intermediate, and a single merged blob cannot answer
-- it. This is the same reason the ledger is per step rather than per job.
--
-- Recreated rather than overloaded. `p_output` has a default, so the existing
-- eleven-argument calls still resolve here and a worker mid-deploy does not break.

drop function if exists public.record_job_step(uuid, text, int, text, text, int, int, numeric, int, text, boolean);

create function public.record_job_step(
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

  return step_id;
end;
$$;

comment on function public.record_job_step is
  'Records a succeeded generation step with its output and, for steps that called a provider, its ledger entry — atomically.';

revoke all on function public.record_job_step(uuid, text, int, text, text, int, int, numeric, int, text, boolean, jsonb)
  from anon, authenticated, public;

-- Read the outputs of a job's succeeded steps.
--
-- The worker runs exactly one step per invocation and holds no memory between
-- them, so resuming a pipeline means reading back what earlier steps produced.
-- Latest attempt per step wins: a step that failed once and succeeded on retry
-- has two rows, and the successful one is the state the pipeline continued from.
create or replace function public.job_step_outputs(p_job_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(jsonb_object_agg(s.step, s.output), '{}'::jsonb)
  from (
    select distinct on (step) step, output
    from public.job_steps
    where job_id = p_job_id
      and status = 'succeeded'
      and output is not null
    order by step, attempt desc
  ) s;
$$;

comment on function public.job_step_outputs is
  'Outputs of a job''s succeeded steps, keyed by step name. Service role only.';

revoke all on function public.job_step_outputs(uuid) from anon, authenticated, public;
grant execute on function public.job_step_outputs(uuid) to service_role;
