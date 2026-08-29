-- Identify a conviction submission, not just its contents.
--
-- The previous migration made a replay safe by comparing the resubmitted stance
-- against the current row. That only recognises a replay while nothing happened
-- in between -- which is precisely the case where a duplicate would have been
-- harmless. In the case that actually hurts, the reader records a different
-- stance during the retry backoff (another tab, or a genuine change of mind);
-- the replayed stance then no longer matches, so it is appended and silently
-- supersedes the newer choice. A stale retry must never be able to undo a later
-- decision.
--
-- So a conviction now carries the same client-minted submission id an
-- explanation does, and a replay is recognised by which submission it is rather
-- than by what it happens to say.

alter table public.convictions
  add column if not exists client_mutation_id uuid;

comment on column public.convictions.client_mutation_id is
  'Client-minted, once per submission. Lets a replayed stance be recognised as one already applied, even after a later stance superseded it.';

create unique index if not exists convictions_client_mutation_key
  on public.convictions (user_id, client_mutation_id)
  where client_mutation_id is not null;

-- A defaulted parameter would create an overload rather than replace the
-- function, leaving the old four-argument form callable, so it has to go first.
-- Execute reverts to the PUBLIC default the old one also relied on; the function
-- still refuses an unauthenticated caller on its own.
drop function if exists public.set_conviction(uuid, public.stance, real, text);

create function public.set_conviction(
  p_pull_id uuid,
  p_stance public.stance,
  p_confidence real default 0.6,
  p_rationale text default null,
  p_mutation_id uuid default null
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

  -- The partial unique index allows only one un-superseded stance per pull, so
  -- the old row must leave that index before the new one can enter it. Point it
  -- at itself first, then at the replacement once it exists.
  if existing.id is not null then
    update public.convictions set superseded_by = id where id = existing.id;
  end if;

  insert into public.convictions
    (user_id, pull_id, stance, confidence, rationale, client_mutation_id)
  values
    (uid, p_pull_id, p_stance, p_confidence, p_rationale, p_mutation_id)
  returning * into fresh;

  if existing.id is not null then
    update public.convictions set superseded_by = fresh.id where id = existing.id;
  end if;

  return fresh;
end;
$$;
