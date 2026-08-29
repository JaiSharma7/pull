create table public.works (
  id            uuid primary key default extensions.gen_random_uuid(),
  kind          public.work_kind not null,
  title         text not null,
  subtitle      text,
  slug          citext unique not null,
  year          int,
  description   text,
  rights_status public.rights_status not null default 'review_required',
  external_ids  jsonb not null default '{}'::jsonb,
  quality_score real not null default 0.5,
  trust_score   real not null default 0.5,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint works_year_sane     check (year is null or year between -3000 and 2200),
  constraint works_quality_range check (quality_score between 0 and 1),
  constraint works_trust_range   check (trust_score   between 0 and 1)
);

create index works_kind_idx  on public.works (kind);
create index works_title_trgm on public.works using gin (title extensions.gin_trgm_ops);
create index works_external_ids_idx on public.works using gin (external_ids jsonb_path_ops);

create trigger works_updated_at
  before update on public.works
  for each row execute function public.set_updated_at();

create table public.editions (
  id               uuid primary key default extensions.gen_random_uuid(),
  work_id          uuid not null references public.works (id) on delete cascade,
  label            text not null,
  isbn13           text,
  publisher        text,
  year             int,
  language         text not null default 'en',
  duration_seconds int,
  page_count       int,
  url              text,
  is_primary       boolean not null default false,
  created_at       timestamptz not null default now()
);

create index editions_work_idx on public.editions (work_id);
create unique index editions_one_primary_per_work
  on public.editions (work_id) where is_primary;

create table public.contributors (
  id         uuid primary key default extensions.gen_random_uuid(),
  name       text not null,
  slug       citext unique not null,
  bio        text,
  created_at timestamptz not null default now()
);

create index contributors_name_trgm
  on public.contributors using gin (name extensions.gin_trgm_ops);

create table public.work_contributors (
  work_id        uuid not null references public.works (id) on delete cascade,
  contributor_id uuid not null references public.contributors (id) on delete cascade,
  role           text not null default 'author',
  ordinal        int  not null default 0,
  primary key (work_id, contributor_id, role)
);

create index work_contributors_contributor_idx
  on public.work_contributors (contributor_id);

create table public.topics (
  id         uuid primary key default extensions.gen_random_uuid(),
  slug       citext unique not null,
  label      text not null,
  parent_id  uuid references public.topics (id) on delete set null,
  created_at timestamptz not null default now()
);

create index topics_parent_idx on public.topics (parent_id);

create table public.work_topics (
  work_id  uuid not null references public.works (id) on delete cascade,
  topic_id uuid not null references public.topics (id) on delete cascade,
  weight   real not null default 1.0,
  primary key (work_id, topic_id),
  constraint work_topics_weight_range check (weight between 0 and 1)
);

create index work_topics_topic_idx on public.work_topics (topic_id);
