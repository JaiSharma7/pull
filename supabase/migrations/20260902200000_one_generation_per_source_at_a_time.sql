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
-- a claim whose job is no longer queued or running. The waiter needs no new
-- machinery at all -- it throws an unbilled error, its message stays in the queue,
-- and pgmq redelivers it at the 180 s visibility timeout. Three deliveries at 180 s
-- is nine minutes, and a five-minute lease is three times the 100 s synthesis
-- budget, so by the third delivery a dead holder's claim is takeable and a live
-- holder has long since published -- in which case the re-check in `synthesize`
-- adopts its summary and no provider is called at all.
--
-- The claim is taken in `synthesize`, not `acquire`, because that is where the money
-- is spent and the window that matters is the one in front of the call. Released at
-- `publish`; a failed job's claim is takeable by the status rule above, and the lease
-- is the net under both.
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
  p_lease  interval default interval '5 minutes'
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

revoke all on function public.claim_source_hash(uuid, text, interval) from public, anon, authenticated;
revoke all on function public.release_source_hash(uuid) from public, anon, authenticated;
grant execute on function public.claim_source_hash(uuid, text, interval) to service_role;
grant execute on function public.release_source_hash(uuid) to service_role;
