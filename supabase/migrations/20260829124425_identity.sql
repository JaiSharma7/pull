create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  handle       citext unique not null,
  display_name text,
  bio          text,
  avatar_path  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_handle_format check (handle ~ '^[a-z0-9_]{3,30}$')
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.preference_profiles (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  topic_weights   jsonb  not null default '{}'::jsonb,
  excluded_topics text[] not null default '{}',
  media_kinds     public.work_kind[] not null default
                    '{book,film,documentary,podcast,paper,essay}'::public.work_kind[],
  daily_minutes   int  not null default 10,
  technical_level real not null default 0.5,
  novelty         real not null default 0.6,
  spoilers        public.spoiler_level not null default 'none',
  counter_rate    real not null default 0.15,
  interrupt_rate  real not null default 1.0,
  onboarded_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint pref_daily_minutes_sane check (daily_minutes between 1 and 240),
  constraint pref_technical_range    check (technical_level between 0 and 1),
  constraint pref_novelty_range      check (novelty         between 0 and 1),
  constraint pref_counter_range      check (counter_rate    between 0 and 1),
  constraint pref_interrupt_range    check (interrupt_rate  between 0 and 2)
);

create trigger preference_profiles_updated_at
  before update on public.preference_profiles
  for each row execute function public.set_updated_at();

create table public.follows (
  follower_id uuid not null references auth.users (id) on delete cascade,
  followee_id uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint follows_no_self check (follower_id <> followee_id)
);

create index follows_followee_idx on public.follows (followee_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  candidate citext;
begin
  candidate := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-zA-Z0-9_]', '', 'g'));
  if candidate is null or length(candidate) < 3 then
    candidate := 'reader';
  end if;
  candidate := left(candidate, 24);

  if exists (select 1 from public.profiles p where p.handle = candidate) then
    candidate := candidate || '_' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;

  insert into public.profiles (id, handle, display_name)
  values (new.id, candidate, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;

  insert into public.preference_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
