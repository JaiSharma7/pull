-- A join dispatches once, and only once every predecessor has succeeded.
--
-- The two properties the graph's liveness and its cost rest on. Dispatched early
-- and `moderate` runs before `embed` has written vectors -- a published summary the
-- Delta cannot see. Dispatched twice and the join runs twice; if it were a provider
-- node, that is a second bill for the same work (law 2).
--
-- Read-only in effect: everything below rolls back, `pgmq.send` included.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.queued_for(p_job uuid, p_step text) returns int
language sql as $fn$
  select count(*)::int from pgmq.q_generation q
  where q.message ->> 'jobId' = p_job::text and q.message ->> 'step' = p_step;
$fn$;

do $$
declare
  the_job uuid;
  verdict text;
  refused boolean := false;
begin
  insert into public.generation_jobs (target, status, current_step)
  values ('{"text":"x"}'::jsonb, 'running', 'cards')
  returning id into the_job;

  -- ------------------------------------------- 1. one of two predecessors: wait
  insert into public.job_steps (job_id, step, attempt, status, output)
  values (the_job, 'artwork', 1, 'succeeded', '{"generated":false}'::jsonb);

  verdict := public.dispatch_generation_step(the_job, 'moderate', array['artwork', 'embed']);
  if verdict <> 'waiting' then
    raise exception 'expected waiting with embed unfinished, got %', verdict;
  end if;
  if pg_temp.queued_for(the_job, 'moderate') <> 0 then
    raise exception 'a waiting dispatch sent a message';
  end if;
  if exists (select 1 from public.generation_dispatches d where d.job_id = the_job and d.step = 'moderate') then
    raise exception 'a waiting dispatch left a dispatch row behind, which would block the real one';
  end if;

  -- A failed attempt is not a succeeded predecessor.
  insert into public.job_steps (job_id, step, attempt, status, error)
  values (the_job, 'embed', 1, 'failed', 'provider returned 3 vectors for 4 pulls');
  verdict := public.dispatch_generation_step(the_job, 'moderate', array['artwork', 'embed']);
  if verdict <> 'waiting' then
    raise exception 'a failed predecessor counted as succeeded: %', verdict;
  end if;

  -- ------------------------------------------- 2. both predecessors: send once
  insert into public.job_steps (job_id, step, attempt, status, output)
  values (the_job, 'embed', 2, 'succeeded', '{"embedded":4}'::jsonb);

  verdict := public.dispatch_generation_step(the_job, 'moderate', array['artwork', 'embed']);
  if verdict <> 'sent' then
    raise exception 'expected sent with both predecessors done, got %', verdict;
  end if;
  if pg_temp.queued_for(the_job, 'moderate') <> 1 then
    raise exception 'expected exactly one moderate message, found %', pg_temp.queued_for(the_job, 'moderate');
  end if;
  if (select current_step from public.generation_jobs where id = the_job) <> 'moderate' then
    raise exception 'current_step was not advanced to the dispatched node';
  end if;

  -- ------------------------------------------- 3. the other predecessor asks too
  -- This is the race, replayed in series: the sibling that finished a moment later
  -- also sees both rows and also asks. The unique key answers it.
  verdict := public.dispatch_generation_step(the_job, 'moderate', array['artwork', 'embed']);
  if verdict <> 'already' then
    raise exception 'expected already on the second dispatch, got %', verdict;
  end if;
  if pg_temp.queued_for(the_job, 'moderate') <> 1 then
    raise exception 'a second dispatch sent a second message';
  end if;

  -- ------------------------------------------- 4. a redelivered message replays
  -- The resume path re-dispatches successors without a step result to read. Same
  -- answer, same single message.
  verdict := public.dispatch_generation_step(the_job, 'moderate', array['artwork', 'embed']);
  if verdict <> 'already' or pg_temp.queued_for(the_job, 'moderate') <> 1 then
    raise exception 'a replayed dispatch was not idempotent';
  end if;

  -- ------------------------------------------- 5. a node with no predecessors
  -- `after` empty means ready. Nothing dispatches the root this way today, but the
  -- function must not treat an empty list as "waiting on nothing forever".
  verdict := public.dispatch_generation_step(the_job, 'resolve_identity', '{}'::text[]);
  if verdict <> 'sent' then
    raise exception 'an empty after-list did not dispatch: %', verdict;
  end if;

  -- ------------------------------------------- 6. a failed job stays failed
  -- The fan-out's own hazard: one branch exhausts its attempts and the worker
  -- fails the job while the other branch is still queued. When that branch finishes
  -- and asks for its successor, the answer is no -- not a revived job that goes on
  -- to pay for two provider nodes and then strands at the join.
  update public.generation_jobs
     set status = 'failed', error = 'step extract_evidence exhausted retries', finished_at = now()
   where id = the_job;
  insert into public.job_steps (job_id, step, attempt, status, output)
  values (the_job, 'synthesize', 1, 'succeeded', '{"title":"t","pulls":[]}'::jsonb);

  verdict := public.dispatch_generation_step(the_job, 'template', array['synthesize']);
  if verdict <> 'closed' then
    raise exception 'expected closed on a failed job, got %', verdict;
  end if;
  if pg_temp.queued_for(the_job, 'template') <> 0 then
    raise exception 'a closed dispatch sent a message';
  end if;
  if (select status from public.generation_jobs where id = the_job) <> 'failed' then
    raise exception 'a dispatch revived a failed job';
  end if;
  -- And a replay of that dispatch is still `already`: the row was taken, so the
  -- job cannot be revived by asking twice either.
  verdict := public.dispatch_generation_step(the_job, 'template', array['synthesize']);
  if verdict <> 'already' then
    raise exception 'expected already on a replayed closed dispatch, got %', verdict;
  end if;

  update public.generation_jobs set status = 'running', error = null, finished_at = null
   where id = the_job;

  -- ------------------------------------------- 7. not for readers
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'authenticated', 'sub', extensions.gen_random_uuid())::text,
                     true);
  begin
    perform public.dispatch_generation_step(the_job, 'publish', '{}'::text[]);
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader was able to call dispatch_generation_step.';
  end if;
  if exists (select 1 from public.generation_dispatches) then
    raise exception 'a reader can see generation_dispatches.';
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'graph dispatch: ok';
end $$;

rollback;
