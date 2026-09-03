-- A job that has already been closed is not reopened by a step that outlived it.
--
-- `dispatch_generation_step` (20260902190000) guards its update with
-- `status in ('queued','running')` and returns `closed`, and its comment explains why the
-- fan-out made that necessary: once `chunk` fans out, "the job failed while a sibling step
-- was still live" stopped being unreachable. `advance_generation_job` is the *other* half
-- of the same transition — it is what the worker calls to close a job, and to move a
-- linear step — and it never got the same guard.
--
-- The sequence, which the graph makes reachable:
--
--   1. `chunk` fans out to `extract_evidence` and `synthesize`.
--   2. `synthesize` finds the source already published and jumps to `publish`.
--   3. The publish worker records its step succeeded and dies before archiving.
--   4. `extract_evidence` exhausts its attempts; the worker sets the job `failed`,
--      with `error` and `finished_at`, and tells the requester so.
--   5. Publish's message is redelivered. The resume branch skips `runStep`, and with it
--      the `JobClosedError` check, and calls `advance_generation_job(job,'publish',null)`.
--      `current_step` is still `publish`, so the CAS matched.
--
-- The job flipped from `failed` to `succeeded`, keeping the error text that said why it
-- had failed, after the requester had already been told. Both branches are guarded here,
-- and the close clears `error` so a succeeded row cannot carry one.
--
-- A new migration rather than an edit: 20260829165502 has been applied (law 6).
create or replace function public.advance_generation_job(
  p_job_id    uuid,
  p_from_step text,
  p_to_step   text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  moved int;
begin
  if p_to_step is null then
    update public.generation_jobs
       set status = 'succeeded', finished_at = now(), error = null
     where id = p_job_id
       and current_step = p_from_step
       and status in ('queued', 'running');
    return found;
  end if;

  update public.generation_jobs
     set current_step = p_to_step, status = 'running'
   where id = p_job_id
     and current_step = p_from_step
     and status in ('queued', 'running');
  get diagnostics moved = row_count;

  if moved = 0 then
    -- Already advanced and its send committed with it, or the job is closed and this
    -- step is the late one. Either way there is nothing to enqueue.
    return false;
  end if;

  perform pgmq.send('generation',
                    jsonb_build_object('jobId', p_job_id, 'step', p_to_step),
                    0);
  return true;
end;
$$;

comment on function public.advance_generation_job(uuid, text, text) is
  'Advances a generation job and enqueues its next step in one transaction, or closes it. Refuses either on a job that is no longer queued or running, so a step that outlives a failure cannot reopen it.';

revoke all on function public.advance_generation_job(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.advance_generation_job(uuid, text, text) to service_role;
