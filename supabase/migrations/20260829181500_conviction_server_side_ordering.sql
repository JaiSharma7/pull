-- Order convictions in the database rather than in the browser.
--
-- Three rounds of review have now found the same shape of bug in the client-side
-- version: a scan of the pending queue cannot see a write that has not been
-- queued yet. An older request still in flight when a newer one succeeds gets
-- queued *after* the cleanup that was meant to discard it, and then supersedes
-- the newer stance on the next drain. Widening the scan cannot close that --
-- the window is between "the newer one landed" and "the older one failed", and
-- no amount of client bookkeeping observes both ends of it.
--
-- So the ordering moves to the one place that sees every submission: a stance
-- carries when the reader submitted it, and a submission older than the stance
-- already current is declined. Whatever order the requests arrive in, the
-- newest submission wins and the rest are no-ops -- which also means the client
-- needs no queue-scanning at all, and that code goes away.
--
-- The timestamp is the client's, so two submissions from the same browser --
-- including across its tabs -- are ordered by one clock. Across devices a
-- badly-skewed clock could still misorder them; that is inherent to letting the
-- client say when it acted, and it is bounded by the reader only ever competing
-- with themselves.

alter table public.convictions
  add column if not exists submitted_at timestamptz;

comment on column public.convictions.submitted_at is
  'When the reader submitted this stance, by their clock. A submission older than the current stance is declined, so a delayed retry cannot resurrect an earlier intent.';

drop function if exists public.set_conviction(uuid, public.stance, real, text, uuid);

create function public.set_conviction(
  p_pull_id uuid,
  p_stance public.stance,
  p_confidence real default 0.6,
  p_rationale text default null,
  p_mutation_id uuid default null,
  p_submitted_at timestamptz default null
) returns public.convictions
language plpgsql
set search_path to ''
as $$
declare
  uid      uuid := (select auth.uid());
  fresh    public.convictions;
  existing public.convictions;
  applied  public.convictions;
begin
  if uid is null then
    raise exception 'set_conviction requires an authenticated user';
  end if;

  -- Single-bigint overload over a combined key. There is no (bigint, bigint)
  -- form, and the (int, int) form would need both halves narrowed to 32 bits.
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(uid::text || ':' || p_pull_id::text, 0)
  );

  -- This submission already landed. Return it untouched rather than reapplying
  -- it: whatever the reader has decided since, a retry of an older submission
  -- must not resurrect it.
  if p_mutation_id is not null then
    select * into applied
    from public.convictions
    where user_id = uid and client_mutation_id = p_mutation_id;

    if applied.id is not null then
      return applied;
    end if;
  end if;

  select * into existing
  from public.convictions
  where user_id = uid and pull_id = p_pull_id and superseded_by is null;

  -- A submission the reader made before the stance already on record. It lost,
  -- however long its request took to arrive or to fail and be retried.
  if existing.id is not null
     and p_submitted_at is not null
     and existing.submitted_at is not null
     and p_submitted_at <= existing.submitted_at
  then
    return existing;
  end if;

  -- The partial unique index allows only one un-superseded stance per pull, so
  -- the old row must leave that index before the new one can enter it. Point it
  -- at itself first, then at the replacement once it exists.
  if existing.id is not null then
    update public.convictions set superseded_by = id where id = existing.id;
  end if;

  insert into public.convictions
    (user_id, pull_id, stance, confidence, rationale, client_mutation_id, submitted_at)
  values
    (uid, p_pull_id, p_stance, p_confidence, p_rationale, p_mutation_id, p_submitted_at)
  returning * into fresh;

  if existing.id is not null then
    update public.convictions set superseded_by = fresh.id where id = existing.id;
  end if;

  return fresh;
end;
$$;
