-- Reconciliation: the file that makes the repo describe what production actually ran.
--
-- `20260830160437_record_step_output.sql` defines two functions — `record_job_step`
-- and `job_step_outputs`. Production did not apply it that way. It recorded
-- `20260830160437` carrying only the `record_job_step` half, and then a second entry,
-- `20260830164343`, carrying only the `job_step_outputs` half. The resulting schema is
-- identical either way, which is why nothing ever broke; the ledgers are what diverged.
--
-- That divergence is not cosmetic. `supabase migration list` reports a remote entry with
-- no local file, and nobody reading this repo can tell whether production is ahead of it
-- or behind it. A repo that cannot answer "what is deployed" is one migration away from
-- a surprise.
--
-- Law 6 says append-only, so the fix is this file rather than a correction to `160437` —
-- editing a migration that has been applied silently diverges every environment that
-- already ran it, which is precisely the failure being repaired here.
--
-- The statement below is what production ran at `20260830164343`, byte for byte. On a
-- fresh replay `160437` creates the function and this replaces it with the same
-- definition: a genuine no-op, and the price of both ledgers finally agreeing.

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
