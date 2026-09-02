-- One generation per source at a time, and never a source held by the dead.
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on

begin;

do $$
declare
  job_a   uuid;
  job_b   uuid;
  verdict text;
  refused boolean := false;
  floored boolean := false;
begin
  insert into public.generation_jobs (target, status, current_step)
  values ('{"text":"x"}'::jsonb, 'running', 'synthesize') returning id into job_a;
  insert into public.generation_jobs (target, status, current_step)
  values ('{"text":"x"}'::jsonb, 'running', 'synthesize') returning id into job_b;

  perform set_config('role', 'service_role', true);

  -- ------------------------------------------------ 1. first claim wins
  verdict := public.claim_source_hash(job_a, 'hash-1');
  if verdict <> 'claimed' then raise exception 'first claim was %', verdict; end if;

  -- ------------------------------------------------ 2. a live holder is not displaced
  verdict := public.claim_source_hash(job_b, 'hash-1');
  if verdict <> 'held' then raise exception 'a second job displaced a live holder: %', verdict; end if;
  if (select job_id from public.generation_hash_claims where content_hash = 'hash-1') <> job_a then
    raise exception 'the claim row changed hands on a held answer';
  end if;

  -- ------------------------------------------------ 3. the holder may renew
  verdict := public.claim_source_hash(job_a, 'hash-1');
  if verdict <> 'claimed' then raise exception 'the holder could not renew: %', verdict; end if;

  -- ------------------------------------------------ 4. a different source is free
  verdict := public.claim_source_hash(job_b, 'hash-2');
  if verdict <> 'claimed' then raise exception 'an unrelated hash was refused: %', verdict; end if;

  -- ------------------------------------------------ 5. a finished holder is displaced
  perform set_config('role', 'postgres', true);
  update public.generation_jobs set status = 'failed' where id = job_a;
  perform set_config('role', 'service_role', true);
  verdict := public.claim_source_hash(job_b, 'hash-1');
  if verdict <> 'claimed' then raise exception 'a failed job kept its claim: %', verdict; end if;
  if (select job_id from public.generation_hash_claims where content_hash = 'hash-1') <> job_b then
    raise exception 'the claim did not move to the new holder';
  end if;

  -- ------------------------------------------------ 6. an expired lease is displaced
  perform set_config('role', 'postgres', true);
  update public.generation_jobs set status = 'running' where id = job_a;
  update public.generation_hash_claims set expires_at = now() - interval '1 second'
   where content_hash = 'hash-1';
  perform set_config('role', 'service_role', true);
  verdict := public.claim_source_hash(job_a, 'hash-1');
  if verdict <> 'claimed' then raise exception 'an expired lease was honoured: %', verdict; end if;

  -- ------------------------------------------------ 7. release frees exactly the job's claims
  if public.release_source_hash(job_a) <> 1 then
    raise exception 'release did not remove exactly one claim';
  end if;
  if not exists (select 1 from public.generation_hash_claims where content_hash = 'hash-2') then
    raise exception 'release removed another job''s claim';
  end if;
  verdict := public.claim_source_hash(job_b, 'hash-1');
  if verdict <> 'claimed' then raise exception 'a released source was not free: %', verdict; end if;

  -- ------------------------------------------------ 8. waiting spends no retry
  -- The delivered message is archived and a fresh, delayed one carries the count.
  declare
    old_id bigint;
    new_id bigint;
    body   jsonb;
  begin
    old_id := pgmq.send('generation', jsonb_build_object('jobId', job_b, 'step', 'synthesize'), 0);
    new_id := public.requeue_generation_message(old_id, job_b, 'synthesize', 60, 3);
    if new_id = old_id then raise exception 'requeue returned the same message'; end if;
    if exists (select 1 from pgmq.q_generation where msg_id = old_id) then
      raise exception 'the delivered message was not archived';
    end if;
    select q.message into body from pgmq.q_generation q where q.msg_id = new_id;
    if body is null then raise exception 'no fresh message was sent'; end if;
    if (body ->> 'waits')::int <> 3 or body ->> 'step' <> 'synthesize' then
      raise exception 'the fresh message does not carry the step and wait count: %', body;
    end if;
    if (select vt from pgmq.q_generation where msg_id = new_id) <= now() + interval '30 seconds' then
      raise exception 'the fresh message is not delayed';
    end if;
  end;

  -- ------------------------------------------------ 9. the floor
  begin
    perform public.claim_source_hash(job_b, 'hash-3', interval '30 seconds');
  exception when others then
    floored := true;
  end;
  if not floored then raise exception 'a lease under the synthesis budget was accepted'; end if;

  -- ------------------------------------------------ 10. not for readers
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'authenticated', 'sub', extensions.gen_random_uuid())::text,
                     true);
  begin
    perform public.claim_source_hash(job_b, 'hash-9');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a reader could claim a source.'; end if;
  refused := false;
  begin
    perform public.requeue_generation_message(1, job_b, 'synthesize', 60, 1);
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a reader could requeue a message.'; end if;
  if exists (select 1 from public.generation_hash_claims) then
    raise exception 'a reader can see generation_hash_claims.';
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'hash claims: ok';
end $$;

rollback;
