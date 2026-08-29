-- Make record_read actually idempotent, as the offline queue already assumes.
--
-- `apps/web/src/lib/offline.ts` gives "record_read is idempotent per pull and
-- day" as the reason a queued read is safe to replay. It was not: neither
-- history_events nor feed_impressions had any uniqueness, so a read whose HTTP
-- response was lost -- precisely the case the queue exists for -- was retried and
-- wrote a second row to both. Only knowledge_states was protected. The reader
-- then sees the same idea listed twice in their history from one impression, and
-- the impression count that feeds the 30-day feed exclusion is inflated.
--
-- A generated day column makes the uniqueness expressible: date_trunc on a
-- timestamptz is stable rather than immutable, so it cannot go in an index
-- expression directly, but a stored generated column computed at UTC can.
-- Reading the same card twice on different days is still two events, which is
-- what history should record; reading it twice in one day is one.

alter table public.history_events
  add column if not exists occurred_on date
    generated always as (((created_at at time zone 'UTC')::date)) stored;

alter table public.feed_impressions
  add column if not exists shown_on date
    generated always as (((shown_at at time zone 'UTC')::date)) stored;

-- Partial, because history_events also records kinds with no pull attached.
create unique index if not exists history_events_read_once_per_day
  on public.history_events (user_id, pull_id, kind, occurred_on)
  where pull_id is not null;

create unique index if not exists feed_impressions_once_per_day
  on public.feed_impressions (user_id, pull_id, shown_on);

create or replace function public.record_read(
  p_pull_id  uuid,
  p_dwell_ms int default null,
  p_position int default 0
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    return;
  end if;

  -- `do update` rather than `do nothing` for the dwell time: a replay carrying a
  -- longer dwell is better evidence than the first attempt's, and taking the
  -- larger of the two cannot lose a real measurement.
  insert into public.history_events (user_id, kind, pull_id, summary_id, work_id, dwell_ms)
  select uid, 'read', p.id, p.summary_id, s.work_id, p_dwell_ms
  from public.pulls p join public.summaries s on s.id = p.summary_id
  where p.id = p_pull_id
  on conflict (user_id, pull_id, kind, occurred_on) where pull_id is not null
  do update set dwell_ms = greatest(
    coalesce(public.history_events.dwell_ms, 0),
    coalesce(excluded.dwell_ms, 0)
  );

  insert into public.feed_impressions (user_id, pull_id, position, action)
  values (uid, p_pull_id, p_position, 'opened')
  on conflict (user_id, pull_id, shown_on) do nothing;

  -- A read starts the memory clock but claims little: stability 1 day, and the
  -- Delta will not treat it as known once that decays.
  insert into public.knowledge_states (user_id, pull_id, acquired_via, last_seen_at, next_due_at)
  values (uid, p_pull_id, 'read', now(), now() + interval '1 day')
  on conflict (user_id, pull_id) do update
    set last_seen_at = now();
end;
$$;
