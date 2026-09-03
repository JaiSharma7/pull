-- One generation per source at a time.
--
-- Two jobs fingerprinting the same text can both pay a provider. `acquire` asks
-- whether the source is already summarised, and `synthesize` asks again immediately
-- before calling the provider -- but they are separate invocations minutes apart on
-- a queue, so both can miss and both can pay. The adopt-on-23505 in `createSummary`
-- means that no longer ends in a crash; what remains is a duplicated bill, which is
-- a law 2 failure whether or not anything throws, because the whole cost argument
-- is that a source is generated once. docs/roadmap.md has carried this as an open
-- risk since round 2.
--
-- It was deferred because the lease was the hard part: a crashed job holding a
-- claim would block every later request for the same source, turning a duplicated
-- bill into a stalled queue, which is the worse failure. So the claim expires, and
-- three things can take it over: the same job (renewal), a claim past its lease, or
-- a claim whose job is no longer queued or running.
--
-- The waiter does not spend a retry to wait. The first draft let a `held` job throw
-- and be redelivered at the 180 s visibility timeout, which is bounded by the same
-- `MAX_ATTEMPTS`/`read_ct` guard as a real failure -- so a holder retrying a slow
-- provider could make the waiter fail terminally after nine minutes of doing nothing
-- wrong. Instead `requeue_generation_message` archives the delivered message and sends
-- a fresh one with a delay and a `waits` counter: no `job_steps` row, no `read_ct`,
-- one cheap invocation a minute, and the worker bounds the count of waits itself.
--
-- The lease is thirty minutes, and it is not what protects against a dead holder.
-- A job that is `failed` -- by the worker's retry guard or by the stranded-job
-- sweeper -- loses its claim by the status rule at once, whatever the lease says.
-- The lease exists for a holder that is *alive* but slow: a summary is not reusable
-- until `publish`, and the six nodes between `synthesize` and `publish` can spend
-- more than five minutes in a queue, so a five-minute lease let a second job take
-- the claim and pay for the same source (Codex, on the first pass). `template`
-- renews the claim once the summary is committed, and thirty minutes covers the
-- rest of a live pipeline with room to spare.
--
-- The claim is taken in `synthesize`, not `acquire`, because that is where the money
-- is spent and the window that matters is the one in front of the call. Released at
-- `publish`.
create table public.generation_hash_claims (
  content_hash text primary key,
  job_id       uuid not null references public.generation_jobs (id) on delete cascade,
  claimed_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);

-- Every foreign key carries a non-partial index (CI check 4, invariant 3).
create index generation_hash_claims_job_idx on public.generation_hash_claims (job_id);

-- Law 5. Worker bookkeeping, written through the functions below as service_role;
-- nothing reads it through the API, and a content hash is exactly the value
-- 20260831013500 went to some trouble to keep from readers.
alter table public.generation_hash_claims enable row level security;
create policy generation_hash_claims_no_api_access on public.generation_hash_claims
  for select using (false);

comment on table public.generation_hash_claims is
  'Which job is currently synthesising which source. One row per content hash; the lease is what stops a crashed job holding it forever.';

create or replace function public.claim_source_hash(
  p_job_id uuid,
  p_hash   text,
  p_lease  interval default interval '30 minutes'
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  taken boolean;
begin
  if p_lease < interval '3 minutes' then
    raise exception
      'claim_source_hash: lease % is under the three-minute floor; a synthesis may take 100 s '
      'and a lease that expires mid-call hands the source to a second payer',
      p_lease;
  end if;

  -- One statement, so two jobs asking at the same instant are serialised by the
  -- primary key: the second insert waits on the first's row lock and then sees it.
  insert into public.generation_hash_claims (content_hash, job_id, expires_at)
  values (p_hash, p_job_id, now() + p_lease)
  on conflict (content_hash) do update
    set job_id = excluded.job_id, claimed_at = now(), expires_at = excluded.expires_at
    where public.generation_hash_claims.job_id = excluded.job_id
       or public.generation_hash_claims.expires_at < now()
       or not exists (
         select 1 from public.generation_jobs j
         where j.id = public.generation_hash_claims.job_id
           and j.status in ('queued', 'running')
       );
  taken := found;

  return case when taken then 'claimed' else 'held' end;
end;
$$;

comment on function public.claim_source_hash(uuid, text, interval) is
  'Reserve a source for one job''s synthesis. claimed: this job holds it (new, renewed, or taken from an expired or finished holder). held: another live job is synthesising it; retry later.';

create or replace function public.release_source_hash(p_job_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  delete from public.generation_hash_claims where job_id = p_job_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.release_source_hash(uuid) is
  'Release every claim a job holds. Called at publish; a failed job''s claim is takeable without this.';

-- Wait without spending a retry: archive the delivered message and send a fresh one,
-- delayed, carrying how many times this step has waited. One statement, so the queue
-- never holds both or neither.
create or replace function public.requeue_generation_message(
  p_msg_id        bigint,
  p_job_id        uuid,
  p_step          text,
  p_delay_seconds int,
  p_waits         int
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  -- The archive is the guard. A delivery that outlived its visibility timeout is
  -- redelivered under the same msg_id, and both deliveries can reach `held`; the
  -- second finds nothing to archive and must send nothing, or the job has two
  -- live messages for one step -- and both would be granted the claim (same job)
  -- and both would pay. Null tells the worker the wait is already queued.
  if not pgmq.archive('generation', p_msg_id) then
    return null;
  end if;
  select pgmq.send('generation',
                   jsonb_build_object('jobId', p_job_id, 'step', p_step, 'waits', p_waits),
                   greatest(coalesce(p_delay_seconds, 0), 0))
    into new_id;
  return new_id;
end;
$$;

comment on function public.requeue_generation_message(bigint, uuid, text, int, int) is
  'Archive a delivered message and re-send its step with a delay and a wait count, so a job can wait on a source claim without consuming its retry budget. Null when the message was already gone, in which case nothing is sent. Service role only.';

revoke all on function public.requeue_generation_message(bigint, uuid, text, int, int)
  from public, anon, authenticated;
grant execute on function public.requeue_generation_message(bigint, uuid, text, int, int) to service_role;

revoke all on function public.claim_source_hash(uuid, text, interval) from public, anon, authenticated;
revoke all on function public.release_source_hash(uuid) from public, anon, authenticated;
grant execute on function public.claim_source_hash(uuid, text, interval) to service_role;
grant execute on function public.release_source_hash(uuid) to service_role;
