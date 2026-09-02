-- `job_step_outputs(uuid, text[])` returns only what was asked for, and only to the
-- worker.
--
-- The one-argument form aggregated every succeeded step's output on every call, so a
-- worker resuming at step nine fetched the 200 kB of source text `acquire` wrote and
-- the copy `chunk` wrote, to read a summary id. The overload narrows it. What has to
-- stay true, in order of how expensive it is to get wrong:
--
--   * the latest SUCCEEDED attempt wins, so a step that failed and then succeeded
--     resumes from the good run and not the failed one;
--   * a step still `running` never appears, or a redelivered message would read an
--     output that was never committed as final;
--   * an unrequested key never appears, which is the whole point;
--   * a reader cannot call it. Their own rows are visible through RLS already; this
--     is `security definer` and must not become a way to read anybody else's.
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on

begin;

do $$
declare
  job_id   uuid;
  outputs  jsonb;
  refused  boolean := false;
begin
  -- Staged as the owner: a reader has no INSERT on either table, and the worker
  -- writes these rows as service_role through `record_job_step`.
  insert into public.generation_jobs (requester_id, target, status)
  values (null, '{"text":"a source long enough to summarise"}'::jsonb, 'running')
  returning id into job_id;

  insert into public.job_steps (job_id, step, attempt, status, output) values
    (job_id, 'resolve_identity', 1, 'succeeded', '{"kind":"essay"}'::jsonb),
    (job_id, 'acquire',          1, 'failed',    null),
    (job_id, 'acquire',          2, 'succeeded', '{"hash":"h","text":"second attempt"}'::jsonb),
    (job_id, 'acquire',          3, 'succeeded', '{"hash":"h","text":"third attempt"}'::jsonb),
    (job_id, 'chunk',            1, 'running',   '{"sections":["not final"]}'::jsonb),
    (job_id, 'synthesize',       1, 'succeeded', '{"title":"t"}'::jsonb);

  perform set_config('role', 'service_role', true);

  -- ------------------------------------------------ 1. only the requested keys
  outputs := public.job_step_outputs(job_id, array['acquire']);
  if outputs ?| array['resolve_identity', 'synthesize', 'chunk'] then
    raise exception 'asked for acquire alone and received %', outputs;
  end if;
  if not (outputs ? 'acquire') then
    raise exception 'asked for acquire and did not receive it: %', outputs;
  end if;

  -- ------------------------------------------------ 2. latest succeeded attempt
  if outputs -> 'acquire' ->> 'text' <> 'third attempt' then
    raise exception 'expected the latest succeeded attempt, got %', outputs -> 'acquire';
  end if;

  -- ------------------------------------------------ 3. several keys, unordered
  outputs := public.job_step_outputs(job_id, array['synthesize', 'resolve_identity']);
  if not (outputs ? 'synthesize' and outputs ? 'resolve_identity') or outputs ? 'acquire' then
    raise exception 'two-key request returned %', outputs;
  end if;

  -- ------------------------------------------------ 4. a running step is not an output
  outputs := public.job_step_outputs(job_id, array['chunk']);
  if outputs <> '{}'::jsonb then
    raise exception 'a step still running was returned as an output: %', outputs;
  end if;

  -- ------------------------------------------------ 5. nothing asked, nothing returned
  if public.job_step_outputs(job_id, '{}'::text[]) <> '{}'::jsonb then
    raise exception 'an empty step list returned something';
  end if;
  if public.job_step_outputs(job_id, array['no_such_step']) <> '{}'::jsonb then
    raise exception 'an unknown step name returned something';
  end if;

  -- ------------------------------------------------ 6. the old form is unchanged
  -- A worker deployed before the overload existed keeps working, and gets the
  -- same everything-succeeded view it always did.
  outputs := public.job_step_outputs(job_id);
  if not (outputs ? 'resolve_identity' and outputs ? 'acquire' and outputs ? 'synthesize') then
    raise exception 'the one-argument form no longer returns every succeeded step: %', outputs;
  end if;
  if outputs ? 'chunk' then
    raise exception 'the one-argument form returned a running step';
  end if;

  -- ------------------------------------------------ 7. not for readers
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'authenticated', 'sub', extensions.gen_random_uuid())::text,
                     true);
  begin
    perform public.job_step_outputs(job_id, array['acquire']);
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader was able to call job_step_outputs(uuid, text[]).';
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'step outputs: ok';
end $$;

rollback;
