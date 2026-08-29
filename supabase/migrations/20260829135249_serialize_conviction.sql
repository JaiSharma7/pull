-- Codex review: two concurrent set_conviction calls for the same (user, pull)
-- could both read the same prior row, or both see none. One insert then wins
-- the partial unique index and the other raises — silently losing a stance the
-- reader meant to record, which is the one thing an append-only ledger must not
-- do.
--
-- Serialise on an advisory lock keyed to (user, pull). It is transaction-scoped,
-- so it releases automatically, and it only ever contends with another write to
-- the same reader's stance on the same idea.
create or replace function public.set_conviction(
  p_pull_id    uuid,
  p_stance     public.stance,
  p_confidence real default 0.6,
  p_rationale  text default null
)
returns public.convictions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  fresh public.convictions;
  prior uuid;
begin
  if uid is null then
    raise exception 'set_conviction requires an authenticated user';
  end if;

  -- hashtextextended keeps the two halves independent, so the lock is specific
  -- to this reader's stance on this idea rather than to either alone.
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(uid::text, 0),
    pg_catalog.hashtextextended(p_pull_id::text, 0)
  );

  select id into prior
  from public.convictions
  where user_id = uid and pull_id = p_pull_id and superseded_by is null;

  -- The partial unique index allows only one un-superseded stance per pull, so
  -- the old row has to leave that index before the new one can enter it. Point
  -- it at itself first, then at the replacement once it exists.
  if prior is not null then
    update public.convictions set superseded_by = id where id = prior;
  end if;

  insert into public.convictions (user_id, pull_id, stance, confidence, rationale)
  values (uid, p_pull_id, p_stance, p_confidence, p_rationale)
  returning * into fresh;

  if prior is not null then
    update public.convictions set superseded_by = fresh.id where id = prior;
  end if;

  return fresh;
end;
$$;

comment on function public.set_conviction is
  'Record a stance, superseding the previous one. Serialised per (user, pull) so a concurrent change cannot be lost.';
