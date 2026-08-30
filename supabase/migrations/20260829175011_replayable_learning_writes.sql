-- Make the two learning writes safe to replay.
--
-- Both can now be queued for retry, and a queued write is replayed whenever its
-- response was lost rather than its effect. Without an idempotency story that
-- turns one submission into two ledger entries, which is worse than the dropped
-- write it was meant to prevent: a duplicate is indistinguishable from the
-- reader having genuinely said the same thing twice.

-- An explanation is identified by a mutation id the browser mints once per
-- submission and reuses for both the immediate insert and any retry, so the
-- second arrival collides instead of duplicating. Nullable because rows written
-- before this migration have none, and unique only where present.
alter table public.explanations
  add column if not exists client_mutation_id uuid;

comment on column public.explanations.client_mutation_id is
  'Client-minted, once per submission. Lets a queued retry collide with the write it is replaying instead of creating a second explanation.';

create unique index if not exists explanations_client_mutation_key
  on public.explanations (user_id, client_mutation_id)
  where client_mutation_id is not null;

-- A conviction needs no new column: the ledger already records stances, so
-- re-submitting the one already on record is by definition a no-op. Making it
-- return the existing row rather than superseding it with an identical copy is
-- both what replay safety requires and what the ledger means -- an entry should
-- mark a change of mind, not a retry.
create or replace function public.set_conviction(
  p_pull_id uuid,
  p_stance public.stance,
  p_confidence real default 0.6,
  p_rationale text default null
) returns public.convictions
language plpgsql
set search_path to ''
as $$
declare
  uid      uuid := (select auth.uid());
  fresh    public.convictions;
  existing public.convictions;
begin
  if uid is null then
    raise exception 'set_conviction requires an authenticated user';
  end if;

  -- Single-bigint overload over a combined key. There is no (bigint, bigint)
  -- form, and the (int, int) form would need both halves narrowed to 32 bits.
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(uid::text || ':' || p_pull_id::text, 0)
  );

  select * into existing
  from public.convictions
  where user_id = uid and pull_id = p_pull_id and superseded_by is null;

  -- Identical submission, including confidence and rationale: nothing changed,
  -- so nothing is appended. A real change in any of the three still records.
  if existing.id is not null
     and existing.stance = p_stance
     and existing.confidence is not distinct from p_confidence
     and existing.rationale is not distinct from p_rationale
  then
    return existing;
  end if;

  -- The partial unique index allows only one un-superseded stance per pull, so
  -- the old row must leave that index before the new one can enter it. Point it
  -- at itself first, then at the replacement once it exists.
  if existing.id is not null then
    update public.convictions set superseded_by = id where id = existing.id;
  end if;

  insert into public.convictions (user_id, pull_id, stance, confidence, rationale)
  values (uid, p_pull_id, p_stance, p_confidence, p_rationale)
  returning * into fresh;

  if existing.id is not null then
    update public.convictions set superseded_by = fresh.id where id = existing.id;
  end if;

  return fresh;
end;
$$;
