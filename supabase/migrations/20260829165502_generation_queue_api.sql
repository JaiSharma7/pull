-- Codex review round 3. Five findings share one root cause, so one change
-- closes all of them.
--
-- The worker and enqueue function reached pgmq through the `pgmq_public`
-- schema, which config.toml does not expose (narrowed to `public` to fix the
-- type-generation mismatch), so every queue RPC would have been rejected. And
-- the job transition and successor enqueue were two separate round trips: a
-- crash between them left a job advanced with nothing queued. The review was
-- right and my last comment was wrong — with no sweeper, that is a permanent
-- stall, not a recoverable one.
--
-- pgmq.send is itself a SQL function, so putting both writes inside one plpgsql
-- function makes them a single transaction. That is the outbox pattern for
-- free, and it means the worker only ever calls `public`, so the exposed schema
-- list can stay minimal and CI check 4 keeps passing.

create or replace function public.claim_generation_messages(
  p_count int default 5,
  p_visibility_seconds int default 120
)
returns table (msg_id bigint, message jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select r.msg_id, r.message
  from pgmq.read('generation', p_visibility_seconds, p_count) r;
end;
$$;

create or replace function public.archive_generation_message(p_msg_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  return pgmq.archive('generation', p_msg_id);
end;
$$;

-- Atomic transition + enqueue: either both happen or neither does.
--
-- The compare-and-set on current_step stops a redelivered message enqueueing
-- the successor twice, and because the send now shares the transaction, a
-- zero-row result genuinely means the successor is already queued rather than
-- merely that the row was touched.
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
       set status = 'succeeded', finished_at = now()
     where id = p_job_id and current_step = p_from_step;
    return found;
  end if;

  update public.generation_jobs
     set current_step = p_to_step, status = 'running'
   where id = p_job_id and current_step = p_from_step;
  get diagnostics moved = row_count;

  if moved = 0 then
    return false;   -- already advanced, and its send committed with it
  end if;

  perform pgmq.send('generation',
                    jsonb_build_object('jobId', p_job_id, 'step', p_to_step),
                    0);
  return true;
end;
$$;

comment on function public.advance_generation_job is
  'Advances a generation job and enqueues its next step in one transaction.';

-- Job creation, atomic with its first enqueue, and enforcing the quota by
-- actually delaying the work rather than only changing the response text.
create or replace function public.enqueue_generation_job(
  p_target jsonb,
  p_daily_fast_limit int default 3,
  p_slow_delay_seconds int default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid       uuid := (select auth.uid());
  used      int;
  over      boolean;
  job_id    uuid;
  delay_for int;
begin
  if uid is null then
    raise exception 'enqueue_generation_job requires an authenticated user';
  end if;

  select count(*) into used
  from public.generation_jobs
  where requester_id = uid
    and created_at >= date_trunc('day', (now() at time zone 'utc'));

  over := used >= p_daily_fast_limit;

  -- Over quota is not a refusal: the work still happens, just later. That is
  -- the point — the quota protects provider spend, it does not sell anything.
  -- Previously it changed only the response text, so an automated caller got
  -- unlimited generation at full priority.
  delay_for := case when over then p_slow_delay_seconds else 0 end;

  insert into public.generation_jobs (requester_id, target, status)
  values (uid, p_target, 'queued')
  returning id into job_id;

  -- Same transaction as the insert, so there is no failed-cleanup path: either
  -- the job exists and is queued, or neither happened.
  perform pgmq.send('generation',
                    jsonb_build_object('jobId', job_id, 'step', 'resolve_identity'),
                    delay_for);

  return jsonb_build_object(
    'jobId', job_id,
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for
  );
end;
$$;

comment on function public.enqueue_generation_job is
  'Creates a generation job and queues its first step atomically. Over-quota jobs are delayed, never refused.';

-- A zero-cost call is still a call. A free or local provider must stay
-- distinguishable from missing accounting, per the provenance contract in
-- docs/generation.md. Adding the defaulted parameter creates an overload rather
-- than replacing the function, so drop the previous signature explicitly.
drop function if exists public.record_job_step(uuid, text, int, text, text, int, int, numeric, int, text);

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
  p_billable      boolean default false
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
    input_tokens, output_tokens, cost_cents, duration_ms, finished_at
  )
  values (
    p_job_id, p_step, p_attempt, 'succeeded', p_model, p_prompt_version,
    p_input_tokens, p_output_tokens, p_cost_cents, p_duration_ms, now()
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
  'Records a succeeded generation step and, for steps that called a provider, its ledger entry — atomically.';

-- Worker-only surface. The service role bypasses these grants; no client has
-- any reason to reach them.
revoke all on function public.claim_generation_messages(int, int) from anon, authenticated, public;
revoke all on function public.archive_generation_message(bigint) from anon, authenticated, public;
revoke all on function public.advance_generation_job(uuid, text, text) from anon, authenticated, public;
revoke all on function public.record_job_step(uuid, text, int, text, text, int, int, numeric, int, text, boolean)
  from anon, authenticated, public;

-- This one is for clients: it is how a reader requests a generation. It runs as
-- definer only so the insert and the send share a transaction, and it derives
-- the user from auth.uid() rather than trusting a parameter.
grant execute on function public.enqueue_generation_job(jsonb, int, int) to authenticated;
