-- Bound the bandwidth of signed-in URL previews independently of model spend.
-- Only the counter is stored; a preview never stores fetched text or URLs.
create table public.study_url_preview_daily_usage (
  owner_id uuid not null references auth.users(id) on delete cascade,
  day_utc date not null,
  preview_count integer not null check (preview_count between 1 and 20),
  primary key (owner_id, day_utc)
);

alter table public.study_url_preview_daily_usage enable row level security;
create policy study_url_preview_usage_read_own
  on public.study_url_preview_daily_usage
  for select to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.study_url_preview_daily_usage from public, anon, authenticated;
grant select on public.study_url_preview_daily_usage to authenticated;

create function public.reserve_study_url_preview()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  uid uuid := auth.uid();
  used integer;
begin
  if uid is null then
    raise exception 'URL preview requires a signed-in reader' using errcode = '28000';
  end if;
  -- A row lock serializes concurrent previews from tabs and Edge instances.
  perform 1 from auth.users
    where id = uid and is_anonymous is false
    for update;
  if not found then
    raise exception 'URL preview requires a non-guest reader' using errcode = '28000';
  end if;

  insert into public.study_url_preview_daily_usage (owner_id, day_utc, preview_count)
  values (uid, (now() at time zone 'utc')::date, 1)
  on conflict (owner_id, day_utc)
    do update set preview_count = public.study_url_preview_daily_usage.preview_count + 1
      where public.study_url_preview_daily_usage.preview_count < 20
  returning preview_count into used;

  if used is null then
    raise exception 'daily URL preview limit reached' using errcode = '54000';
  end if;
  return used;
end
$fn$;

revoke all on function public.reserve_study_url_preview() from public, anon;
grant execute on function public.reserve_study_url_preview() to authenticated;
