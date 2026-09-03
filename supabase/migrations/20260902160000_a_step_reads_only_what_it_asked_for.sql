-- Every step has been reading every earlier step's output, source text included.
--
-- `job_step_outputs(uuid)` aggregates the outputs of ALL of a job's succeeded steps
-- into one jsonb, and the worker calls it once per invocation -- there was no way to
-- ask for less. `acquire` stores up to MAX_SOURCE_CHARS (200,000) characters of text
-- in its output, and `chunk` stores the same text again as an array of sections. So
-- from the fourth step onward every invocation pulled roughly 400 kB out of Postgres,
-- through PostgREST, into an isolate, to run a step that in most cases reads one small
-- field of it. `moderate` reads the job row and nothing else; `artwork` reads nothing.
--
-- For a 200 kB source that is about 3 MB of transfer per job that no step needed, and
-- the aggregate is materialised by a `security definer` function on every call. It
-- has been invisible because the hosted project has run one verified job.
--
-- This overload takes the list of steps the caller actually reads. The worker passes
-- `NEEDS[step]` from `_shared/steps.ts`, which declares each step's inputs next to the
-- step order. The one-argument form is kept unchanged: a worker deployed before this
-- migration keeps working, and `prune_operational_logs` and the resume path do not
-- care which shape they read.
--
-- What this does NOT fix, so nobody reads it as finished: `acquire`'s output carries
-- the text and the reuse marker in one object, and `template`, `critic` and `publish`
-- need the marker. They therefore still receive the text. Ten steps fetching it
-- becomes five; the remaining five go when the reuse marker is written somewhere the
-- text is not, which is the graph work in docs/plans/2026-09-02-fable-5.1.md.
create or replace function public.job_step_outputs(p_job_id uuid, p_steps text[])
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
      and step = any (p_steps)
      and status = 'succeeded'
      and output is not null
    order by step, attempt desc
  ) s;
$$;

comment on function public.job_step_outputs(uuid, text[]) is
  'Outputs of the named succeeded steps of a job, keyed by step name; latest attempt per step wins. Service role only.';

-- Same posture as the one-argument form: a reader can already see their own job_steps
-- rows through RLS, but this function is `security definer` and must not become a way
-- to read somebody else's.
revoke all on function public.job_step_outputs(uuid, text[]) from anon, authenticated, public;
grant execute on function public.job_step_outputs(uuid, text[]) to service_role;
