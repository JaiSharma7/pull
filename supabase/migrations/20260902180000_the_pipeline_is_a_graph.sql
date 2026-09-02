-- The pipeline is a graph, and this is the one piece of it the database holds.
--
-- `advance_generation_job` moves a job from one step to the next under a
-- compare-and-set on `current_step`, then sends one message. That is exactly right
-- for a line and exactly wrong for a graph: once `extract_evidence` and `synthesize`
-- both follow `chunk`, `current_step` is not a scalar, and the CAS that used to stop
-- a redelivered message sending twice now stops the second of two legitimate
-- successors from being sent at all.
--
-- The graph itself stays in `_shared/graph.ts`, where it is data with tests. The
-- worker passes each successor's `after` list here; this function verifies the rows
-- and guards the send. Two things it must get right:
--
--   READINESS is read from `job_steps`, not from the worker's belief. A node with
--   several predecessors is dispatched by whichever finishes last, and "last" is
--   decided by what has COMMITTED: each worker records its own step (a committed
--   transaction) and then asks whether all of the successor's `after` rows exist.
--   Two predecessors finishing in the same instant both see the other's row, both
--   answer "ready", and the next line decides.
--
--   THE SEND IS GUARDED BY A UNIQUE INDEX, not by a timestamp. `generation_dispatches`
--   is keyed on (job_id, step); the insert is `on conflict do nothing`, and only an
--   insert that actually happened sends. So the pair above produces one message, by
--   construction rather than by luck, and a message redelivered after a crash cannot
--   enqueue a successor twice either -- the dispatch row from the first attempt is
--   still there.
--
-- What it returns is the reason, because the worker logs it and a reader of that
-- log should be able to tell "waiting on a sibling" from "already sent" from "sent".
--
-- The join can now strand a job by design: if one of `moderate`'s two predecessors
-- fails permanently, nothing ever dispatches `moderate`. That is why
-- 20260902170000's sweeper exists and lands before this file.
create table public.generation_dispatches (
  job_id     uuid not null references public.generation_jobs (id) on delete cascade,
  step       text not null,
  created_at timestamptz not null default now(),
  primary key (job_id, step)
);

-- Law 5. Nothing reads this through the API: it is bookkeeping for the worker, which
-- writes it through the function below as service_role. The policy exists so the
-- table is not silently unreadable by its owner's own tooling and so CI's second
-- invariant holds; it grants nothing.
alter table public.generation_dispatches enable row level security;
create policy generation_dispatches_no_api_access on public.generation_dispatches
  for select using (false);

comment on table public.generation_dispatches is
  'One row per (job, step) the worker has enqueued. The unique key is what makes a join dispatch exactly once.';

create or replace function public.dispatch_generation_step(
  p_job_id  uuid,
  p_to_step text,
  p_after   text[]
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  missing text;
  sent    boolean;
begin
  -- Every predecessor must have a succeeded row. Checked before the dispatch row is
  -- taken, so a "waiting" answer leaves nothing behind and the last predecessor to
  -- commit finds the slot free.
  select a.step into missing
  from unnest(p_after) as a(step)
  where not exists (
    select 1 from public.job_steps s
    where s.job_id = p_job_id and s.step = a.step and s.status = 'succeeded'
  )
  limit 1;

  if missing is not null then
    return 'waiting';
  end if;

  insert into public.generation_dispatches (job_id, step)
  values (p_job_id, p_to_step)
  on conflict do nothing;
  sent := found;

  if not sent then
    return 'already';
  end if;

  -- `current_step` is advisory now -- the frontier of a graph is a set, and this
  -- column holds one member of it, the most recently dispatched. It is kept because
  -- `advance_generation_job(…, null)` still closes the job under a CAS on it, and
  -- because a reader looking at a job row deserves a step name rather than a null.
  --
  -- Guarded on liveness, and that guard exists because of the fan-out. On the line
  -- a job could not be failed and still have a step running; with two branches it
  -- can: `extract_evidence` exhausts its attempts and the worker marks the job
  -- failed while `synthesize` is still queued, succeeds a moment later, and asks
  -- for `template`. An unconditional update would flip the job back to `running`
  -- with `error` and `finished_at` still set, and then pay for `artwork` and
  -- `embed` on a job the requester was already told had failed. The dispatch row
  -- stays either way, so a replayed message still answers `already` rather than
  -- trying again.
  update public.generation_jobs
     set current_step = p_to_step, status = 'running'
   where id = p_job_id
     and status in ('queued', 'running');

  if not found then
    return 'closed';
  end if;

  perform pgmq.send('generation',
                    jsonb_build_object('jobId', p_job_id, 'step', p_to_step),
                    0);
  return 'sent';
end;
$$;

comment on function public.dispatch_generation_step(uuid, text, text[]) is
  'Enqueues a job''s next node once every node in p_after has succeeded, exactly once per (job, step), and only while the job is queued or running. Returns waiting | already | closed | sent.';

revoke all on function public.dispatch_generation_step(uuid, text, text[])
  from public, anon, authenticated;
grant execute on function public.dispatch_generation_step(uuid, text, text[]) to service_role;
