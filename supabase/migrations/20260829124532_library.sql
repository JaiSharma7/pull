create table public.stashes (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  parent_id   uuid references public.stashes (id) on delete cascade,
  name        text not null,
  description text,
  visibility  public.visibility not null default 'private',
  cover_path  text,
  is_smart    boolean not null default false,
  query       jsonb,
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint stashes_smart_has_query check (not is_smart or query is not null),
  constraint stashes_no_self_parent check (parent_id is null or parent_id <> id)
);

create index stashes_user_idx   on public.stashes (user_id, position);
create index stashes_parent_idx on public.stashes (parent_id);

create trigger stashes_updated_at
  before update on public.stashes
  for each row execute function public.set_updated_at();

create table public.saved_items (
  id         uuid primary key default extensions.gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  stash_id   uuid references public.stashes (id) on delete set null,
  pull_id    uuid references public.pulls (id) on delete cascade,
  summary_id uuid references public.summaries (id) on delete cascade,
  note       text,
  archived   boolean not null default false,
  read_later boolean not null default false,
  created_at timestamptz not null default now(),
  constraint saved_items_one_target check (
    (pull_id is not null)::int + (summary_id is not null)::int = 1
  )
);

create index saved_items_user_idx    on public.saved_items (user_id, created_at desc);
create index saved_items_stash_idx   on public.saved_items (stash_id);
create index saved_items_pull_idx    on public.saved_items (pull_id);
create index saved_items_summary_idx on public.saved_items (summary_id);

create unique index saved_items_unique_pull
  on public.saved_items (user_id, pull_id) where pull_id is not null;
create unique index saved_items_unique_summary
  on public.saved_items (user_id, summary_id) where summary_id is not null;

create table public.notes (
  id         uuid primary key default extensions.gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  pull_id    uuid references public.pulls (id) on delete cascade,
  summary_id uuid references public.summaries (id) on delete cascade,
  body       text not null,
  visibility public.visibility not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_user_idx    on public.notes (user_id, created_at desc);
create index notes_pull_idx    on public.notes (pull_id);
create index notes_summary_idx on public.notes (summary_id);

create trigger notes_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

create table public.highlights (
  id         uuid primary key default extensions.gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  pull_id    uuid not null references public.pulls (id) on delete cascade,
  field      text not null default 'body',
  start_offset int not null,
  end_offset   int not null,
  text       text not null,
  created_at timestamptz not null default now(),
  constraint highlights_range_valid check (end_offset > start_offset)
);

create index highlights_user_idx on public.highlights (user_id, created_at desc);
create index highlights_pull_idx on public.highlights (pull_id);

create table public.history_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null,
  pull_id    uuid references public.pulls (id) on delete cascade,
  summary_id uuid references public.summaries (id) on delete cascade,
  work_id    uuid references public.works (id) on delete cascade,
  dwell_ms   int,
  created_at timestamptz not null default now()
);

create index history_user_time_idx on public.history_events (user_id, created_at desc);
create index history_pull_idx      on public.history_events (pull_id);
create index history_summary_idx   on public.history_events (summary_id);
create index history_work_idx      on public.history_events (work_id);

create table public.progress (
  user_id      uuid not null references auth.users (id) on delete cascade,
  summary_id   uuid not null references public.summaries (id) on delete cascade,
  last_ordinal int  not null default 0,
  percent      real not null default 0,
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (user_id, summary_id),
  constraint progress_percent_range check (percent between 0 and 1)
);

create index progress_summary_idx on public.progress (summary_id);

create trigger progress_updated_at
  before update on public.progress
  for each row execute function public.set_updated_at();
