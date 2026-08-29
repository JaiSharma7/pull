create table public.feed_recipes (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  is_public   boolean not null default false,
  forked_from uuid references public.feed_recipes (id) on delete set null,
  spec        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index feed_recipes_user_idx   on public.feed_recipes (user_id);
create index feed_recipes_forked_idx on public.feed_recipes (forked_from);
create unique index feed_recipes_one_default_per_user
  on public.feed_recipes (user_id) where is_default;

create trigger feed_recipes_updated_at
  before update on public.feed_recipes
  for each row execute function public.set_updated_at();

create table public.feed_impressions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  pull_id    uuid not null references public.pulls (id) on delete cascade,
  recipe_id  uuid references public.feed_recipes (id) on delete set null,
  position   int not null default 0,
  action     text,
  shown_at   timestamptz not null default now()
);

create index feed_impressions_user_time_idx
  on public.feed_impressions (user_id, shown_at desc);
create index feed_impressions_user_pull_idx
  on public.feed_impressions (user_id, pull_id);
create index feed_impressions_pull_idx   on public.feed_impressions (pull_id);
create index feed_impressions_recipe_idx on public.feed_impressions (recipe_id);

create table public.daily_pulls (
  day        date not null,
  ordinal    int  not null,
  pull_id    uuid not null references public.pulls (id) on delete cascade,
  curator    public.curator_kind not null default 'editorial',
  blurb      text,
  created_at timestamptz not null default now(),
  primary key (day, ordinal)
);

create index daily_pulls_pull_idx on public.daily_pulls (pull_id);
create index daily_pulls_day_idx  on public.daily_pulls (day desc);
