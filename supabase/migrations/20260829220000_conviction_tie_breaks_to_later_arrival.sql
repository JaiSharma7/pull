-- A tie must not reject the submission that arrives second.
--
-- `<=` declined any stance whose timestamp equalled the one on record, so when
-- two submissions shared a millisecond the first to reach the database won and
-- the second was discarded -- even when it was the reader's genuinely later
-- decision. Strict `<` declines only what is actually older, so a tie resolves
-- to the later arrival rather than being thrown away.
--
-- This does not make two same-millisecond submissions *ordered*: identical
-- timestamps carry no information about which came first, and no server-side
-- rule can recover it. What it does is remove the one outcome that is clearly
-- wrong -- silently dropping a stance because another one happened to share its
-- millisecond. The client side of this pairs with it: stamps from a single tab
-- are now strictly increasing, so a tie requires two tabs acting inside the same
-- millisecond, which human input cannot produce.
--
-- Replay safety is untouched: a retry is recognised by `client_mutation_id`
-- before any timestamp is compared, so it never depends on this operator.

create or replace function public.set_conviction(
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

  -- Strictly older than the stance on record: the reader made this decision
  -- before the one they are currently on, however long its request took to
  -- arrive or to fail and be retried. An equal timestamp is a tie, not an older
  -- submission, and falls through to be applied.
  if existing.id is not null
     and p_submitted_at is not null
     and existing.submitted_at is not null
     and p_submitted_at < existing.submitted_at
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
