-- A closed job stays closed, whichever way a late step tries to move it.
--
-- The fan-out in 20260902190000 makes "a step commits after the job has already failed"
-- reachable: one branch can exhaust its retries and fail the job while another branch is
-- still in flight. `dispatch_generation_step` already refuses in that state. This asserts
-- the same of `advance_generation_job`, whose close path had no status filter at all and
-- would flip a failed job to succeeded with its error text still attached.
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on

begin;

do $$
declare
  failed_id uuid;
  live_id   uuid;
  moved     boolean;
  st        text;
  err       text;
begin
  perform set_config('role', 'postgres', true);

  insert into public.generation_jobs (kind, target, current_step, status, error, finished_at)
  values ('summary', '{}'::jsonb, 'publish', 'failed',
          'step extract_evidence exhausted retries', now())
  returning id into failed_id;

  -- Seeded WITH an error, or the "a succeeded job carries no error" assertion below is
  -- vacuous: `error` would be null before the close either way, and dropping
  -- `error = null` from the migration would leave db:test green.
  insert into public.generation_jobs (kind, target, current_step, status, error)
  values ('summary', '{}'::jsonb, 'publish', 'running', 'a transient provider timeout')
  returning id into live_id;

  perform set_config('role', 'service_role', true);

  -- 1. The close path refuses a job that has already failed.
  moved := public.advance_generation_job(failed_id, 'publish', null);
  if moved then
    raise exception 'advance_generation_job closed a job that had already failed.';
  end if;

  perform set_config('role', 'postgres', true);
  select status, error into st, err from public.generation_jobs where id = failed_id;
  if st <> 'failed' then
    raise exception 'a failed job became %, after the requester was told it failed.', st;
  end if;
  if err is null then
    raise exception 'the failure reason was cleared from a job that is still failed.';
  end if;

  -- 2. The advance path refuses it too.
  perform set_config('role', 'service_role', true);
  moved := public.advance_generation_job(failed_id, 'publish', 'moderate');
  if moved then
    raise exception 'advance_generation_job advanced a failed job to another step.';
  end if;

  -- 3. A live job still closes, and does not keep a stale error.
  moved := public.advance_generation_job(live_id, 'publish', null);
  if not moved then
    raise exception 'advance_generation_job refused to close a running job.';
  end if;

  perform set_config('role', 'postgres', true);
  select status, error into st, err from public.generation_jobs where id = live_id;
  if st <> 'succeeded' then
    raise exception 'a running job did not close; it is %.', st;
  end if;
  if err is not null then
    raise exception 'a succeeded job is carrying an error: %', err;
  end if;

  -- 4. Not for readers. `advance_generation_job` is `security definer` and takes the job
  -- id with no ownership check, and `generation_jobs` has a SELECT policy and no UPDATE
  -- policy — so this function is the only way to write one, and the revoke is what stops
  -- a signed-in reader closing somebody else's job by uuid. Asserted here for the same
  -- reason graph_dispatch, hash_claims and stranded_jobs assert it of theirs.
  declare
    refused boolean := false;
  begin
    perform set_config('role', 'authenticated', true);
    begin
      perform public.advance_generation_job(live_id, 'publish', null);
    exception when insufficient_privilege then
      refused := true;
    end;
    if not refused then
      raise exception 'a reader was able to call advance_generation_job.';
    end if;
  end;

  perform set_config('role', 'postgres', true);
  raise notice 'closed job: ok';
end $$;

rollback;
