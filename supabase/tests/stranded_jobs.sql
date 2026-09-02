-- The stranded-job sweep fails exactly the jobs nothing will ever pick up, and no
-- others.
--
-- The property being protected is the one that costs money to get wrong in either
-- direction. Sweep too little and a job the fan-out stranded sits at `running` for
-- ever; sweep too much and a job whose message is merely delayed or in flight is
-- failed after its synthesis was paid for. So the fixture stages one job of each
-- kind and asserts which one goes.
--
-- Read-only in effect: everything below rolls back, `pgmq.send` included.
\set ON_ERROR_STOP on

begin;

do $$
declare
  stranded_id uuid;
  inflight_id uuid;
  delayed_id  uuid;
  fresh_id    uuid;
  done_id     uuid;
  swept       int;
  refused     boolean := false;
  floored     boolean := false;
  err         text;
begin
  -- Staged as the owner. Inserted with `updated_at` set directly rather than
  -- updated afterwards, because the `before update` trigger would stamp it back to
  -- now() and the fixture would be asserting the trigger instead of the sweep.

  -- 1. Running, silent for an hour, nothing queued. This is the one.
  insert into public.generation_jobs (target, status, current_step, updated_at)
  values ('{"text":"x"}'::jsonb, 'running', 'embed', now() - interval '1 hour')
  returning id into stranded_id;

  -- 2. Running, silent for an hour, but its message is in the queue (in flight or
  --    waiting for a worker). Alive.
  insert into public.generation_jobs (target, status, current_step, updated_at)
  values ('{"text":"x"}'::jsonb, 'running', 'chunk', now() - interval '1 hour')
  returning id into inflight_id;
  perform pgmq.send('generation', jsonb_build_object('jobId', inflight_id, 'step', 'chunk'), 0);

  -- 3. Queued with a delay -- an over-quota job waiting its turn. Its message has a
  --    visibility timeout in the future, which is exactly the row a naive "nothing
  --    visible" check would miss. Alive.
  insert into public.generation_jobs (target, status, updated_at)
  values ('{"text":"x"}'::jsonb, 'queued', now() - interval '1 hour')
  returning id into delayed_id;
  perform pgmq.send('generation', jsonb_build_object('jobId', delayed_id, 'step', 'resolve_identity'), 3600);

  -- 4. Running, nothing queued, but its last transition was seconds ago. Too fresh
  --    to judge; the threshold exists for this row.
  insert into public.generation_jobs (target, status, current_step)
  values ('{"text":"x"}'::jsonb, 'running', 'publish')
  returning id into fresh_id;

  -- 5. Already finished. Not the sweep's business.
  insert into public.generation_jobs (target, status, updated_at, finished_at)
  values ('{"text":"x"}'::jsonb, 'succeeded', now() - interval '1 hour', now() - interval '1 hour')
  returning id into done_id;

  -- ------------------------------------------------------------- the sweep
  swept := public.sweep_stranded_generation_jobs(interval '10 minutes');
  if swept <> 1 then
    raise exception 'expected to sweep exactly one job, swept %', swept;
  end if;

  select gj.error into err from public.generation_jobs gj where gj.id = stranded_id and gj.status = 'failed';
  if err is null then
    raise exception 'the stranded job was not failed';
  end if;
  if err not like 'stranded:%' or err not like '%embed%' then
    raise exception 'the stranded job''s error should name the step it stalled at, got %', err;
  end if;
  if (select finished_at from public.generation_jobs where id = stranded_id) is null then
    raise exception 'the stranded job was failed without a finished_at';
  end if;

  if (select status from public.generation_jobs where id = inflight_id) <> 'running' then
    raise exception 'a job with a message in the queue was swept';
  end if;
  if (select status from public.generation_jobs where id = delayed_id) <> 'queued' then
    raise exception 'a job whose message is delayed (vt in the future) was swept';
  end if;
  if (select status from public.generation_jobs where id = fresh_id) <> 'running' then
    raise exception 'a job that transitioned seconds ago was swept';
  end if;
  if (select status from public.generation_jobs where id = done_id) <> 'succeeded' then
    raise exception 'a finished job was touched';
  end if;

  -- A second tick finds nothing: the swept job is `failed` now and out of scope.
  if public.sweep_stranded_generation_jobs(interval '10 minutes') <> 0 then
    raise exception 'a second sweep found something to fail';
  end if;

  -- ------------------------------------------------------------- the floor
  begin
    perform public.sweep_stranded_generation_jobs(interval '30 seconds');
  exception when others then
    floored := true;
  end;
  if not floored then
    raise exception 'a threshold under the visibility timeout was accepted';
  end if;

  -- ------------------------------------------------------------- not for readers
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'authenticated', 'sub', extensions.gen_random_uuid())::text,
                     true);
  begin
    perform public.sweep_stranded_generation_jobs();
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader was able to call sweep_stranded_generation_jobs.';
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'stranded jobs: ok';
end $$;

rollback;
