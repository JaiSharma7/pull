-- Daily selections are made once, on demand, in the reader's calendar day.
-- The editorial archive remains available; it is no longer today's selection.
create table public.daily_pull_selections (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  ordinal int not null check (ordinal between 1 and 5),
  pull_id uuid not null references public.pulls(id) on delete cascade,
  reason text not null check (reason in ('fading', 'unseen')),
  primary key (user_id, day, ordinal),
  unique (user_id, day, pull_id)
);
create index daily_pull_selections_pull_idx on public.daily_pull_selections(pull_id);
alter table public.daily_pull_selections enable row level security;
create policy daily_pull_selections_own on public.daily_pull_selections
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.daily_pull_selections from anon, authenticated;
grant select on public.daily_pull_selections to authenticated;

create function public.get_daily_pulls(p_day date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  utc_day date := (now() at time zone 'UTC')::date;
  result jsonb;
begin
  if uid is null then
    raise exception 'Sign in or start a guest session' using errcode = '42501';
  end if;
  -- Cover every real timezone, but never let a caller fill arbitrary dates.
  if p_day is null or p_day < utc_day - 1 or p_day > utc_day + 1 then
    raise exception 'Daily Pull requires your current calendar day' using errcode = '22023';
  end if;

  -- Account-wide: concurrent requests for adjacent local days must also see
  -- each other's selections before choosing. A day-scoped lock would not do so.
  perform pg_advisory_xact_lock(hashtextextended('daily:' || uid::text, 0));

  if not exists (
    select 1 from public.daily_pull_selections d where d.user_id = uid and d.day = p_day
  ) then
    with eligible as (
      select p.id,
        case when ks.pull_id is not null then 'fading' else 'unseen' end as reason
      from public.pulls p
      join public.summaries s on s.id = p.summary_id
      join public.works w on w.id = s.work_id
      left join public.knowledge_states ks on ks.pull_id = p.id and ks.user_id = uid
      where s.status = 'published' and s.visibility = 'public'
        and w.rights_status in ('public_domain', 'licensed')
        and (
          (ks.pull_id is not null and public.retrievability(ks.stability, ks.last_seen_at) < 0.6)
          or (ks.pull_id is null and not exists (
            select 1 from public.feed_impressions f where f.user_id = uid and f.pull_id = p.id
          ))
        )
        -- No repeats within a fortnight, including across a timezone change.
        and not exists (
          select 1 from public.daily_pull_selections d
          where d.user_id = uid and d.pull_id = p.id
            and d.day between p_day - 14 and p_day + 1
        )
    ), ranked as (
      select *, row_number() over (
        partition by reason order by md5(uid::text || p_day::text || id::text), id
      ) as bucket_rank from eligible
    ), chosen as (
      -- Reserve two fading and three unseen slots; fill missing slots from
      -- whichever pool has more. Never pad the set with well-known ideas.
      select *, case when reason = 'fading' and bucket_rank <= 2 then 0
                     when reason = 'unseen' and bucket_rank <= 3 then 0 else 1 end as overflow
      from ranked
      order by overflow, bucket_rank, reason, id
      limit 5
    )
    insert into public.daily_pull_selections(user_id, day, ordinal, pull_id, reason)
    select uid, p_day, row_number() over (order by overflow, bucket_rank, reason, id)::int,
           id, reason from chosen;
  end if;

  -- Recheck visibility every time: a saved selection cannot preserve access
  -- to an idea after its author withdraws it or its rights status changes.
  select jsonb_build_object('day', p_day, 'pulls', coalesce(jsonb_agg(
    jsonb_build_object(
      'pullId', p.id, 'ordinal', d.ordinal, 'reason', d.reason,
      'headline', p.headline, 'body', p.body, 'whyItMatters', p.why_it_matters,
      'workId', w.id, 'workTitle', w.title, 'workKind', w.kind,
      'workYear', w.year, 'summaryTitle', s.title
    ) order by d.ordinal
  ), '[]'::jsonb)) into result
  from public.daily_pull_selections d
  join public.pulls p on p.id = d.pull_id
  join public.summaries s on s.id = p.summary_id
  join public.works w on w.id = s.work_id
  where d.user_id = uid and d.day = p_day
    and s.status = 'published' and s.visibility = 'public'
    and w.rights_status in ('public_domain', 'licensed');
  return result;
end;
$$;
revoke all on function public.get_daily_pulls(date) from public, anon, authenticated;
grant execute on function public.get_daily_pulls(date) to authenticated;
