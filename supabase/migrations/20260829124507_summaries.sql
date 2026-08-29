create table public.summaries (
  id             uuid primary key default extensions.gen_random_uuid(),
  work_id        uuid not null references public.works (id) on delete cascade,
  edition_id     uuid references public.editions (id) on delete set null,
  version        int  not null default 1,
  status         public.publish_status not null default 'draft',
  visibility     public.visibility     not null default 'public',
  author_id      uuid references auth.users (id) on delete set null,
  forked_from    uuid references public.summaries (id) on delete set null,
  title           text not null,
  elevator_pitch  text,
  why_it_matters  text,
  sections        jsonb not null default '[]'::jsonb,
  spoiler_level   public.spoiler_level not null default 'none',
  difficulty      real not null default 0.5,
  reading_minutes int  not null default 3,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  published_at    timestamptz,
  unique (work_id, version, author_id),
  constraint summaries_difficulty_range check (difficulty between 0 and 1),
  constraint summaries_reading_minutes  check (reading_minutes between 1 and 600),
  constraint summaries_published_has_time
    check (status <> 'published' or published_at is not null)
);

create index summaries_work_idx      on public.summaries (work_id);
create index summaries_edition_idx   on public.summaries (edition_id);
create index summaries_author_idx    on public.summaries (author_id);
create index summaries_forked_idx    on public.summaries (forked_from);
create index summaries_published_idx on public.summaries (status, published_at desc)
  where status = 'published';

create trigger summaries_updated_at
  before update on public.summaries
  for each row execute function public.set_updated_at();

create table public.pulls (
  id         uuid primary key default extensions.gen_random_uuid(),
  summary_id uuid not null references public.summaries (id) on delete cascade,
  ordinal    int  not null,
  headline       text not null,
  body           text not null,
  explanation    text,
  example        text,
  why_it_matters text,
  estimated_read_seconds int not null default 20,
  spoiler_level  public.spoiler_level not null default 'none',
  image_asset_id uuid,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (summary_id, ordinal),
  constraint pulls_read_seconds_sane check (estimated_read_seconds between 3 and 900)
);

create index pulls_summary_idx  on public.pulls (summary_id);
create index pulls_headline_trgm
  on public.pulls using gin (headline extensions.gin_trgm_ops);
create index pulls_embedding_hnsw
  on public.pulls using hnsw (embedding extensions.vector_cosine_ops);

create trigger pulls_updated_at
  before update on public.pulls
  for each row execute function public.set_updated_at();

create table public.citation_anchors (
  id           uuid primary key default extensions.gen_random_uuid(),
  pull_id      uuid not null references public.pulls (id) on delete cascade,
  edition_id   uuid references public.editions (id) on delete set null,
  locator_type public.locator_type not null,
  locator      text not null,
  quote        text,
  note         text,
  confidence   real not null default 0.8,
  created_at   timestamptz not null default now(),
  constraint citation_confidence_range check (confidence between 0 and 1)
);

create index citation_anchors_pull_idx    on public.citation_anchors (pull_id);
create index citation_anchors_edition_idx on public.citation_anchors (edition_id);

create table public.pull_relations (
  from_pull_id uuid not null references public.pulls (id) on delete cascade,
  to_pull_id   uuid not null references public.pulls (id) on delete cascade,
  kind         public.relation_kind not null,
  weight       real not null default 0.5,
  rationale    text,
  created_at   timestamptz not null default now(),
  primary key (from_pull_id, to_pull_id, kind),
  constraint pull_relations_no_self check (from_pull_id <> to_pull_id),
  constraint pull_relations_weight_range check (weight between 0 and 1)
);

create index pull_relations_to_idx   on public.pull_relations (to_pull_id);
create index pull_relations_kind_idx on public.pull_relations (kind, from_pull_id);

create table public.quiz_questions (
  id         uuid primary key default extensions.gen_random_uuid(),
  pull_id    uuid not null references public.pulls (id) on delete cascade,
  prompt     text not null,
  answer     text not null,
  distractors jsonb not null default '[]'::jsonb,
  kind       text not null default 'recall',
  created_at timestamptz not null default now()
);

create index quiz_questions_pull_idx on public.quiz_questions (pull_id);

create table public.artworks (
  id           uuid primary key default extensions.gen_random_uuid(),
  summary_id   uuid not null references public.summaries (id) on delete cascade,
  scope        text not null default 'hero',
  storage_path text not null,
  alt_text     text not null default '',
  prompt       text,
  model        text,
  cost_cents   numeric(10, 4) not null default 0,
  created_at   timestamptz not null default now()
);

create index artworks_summary_idx on public.artworks (summary_id);

alter table public.pulls
  add constraint pulls_image_asset_fk
  foreign key (image_asset_id) references public.artworks (id) on delete set null;

create index pulls_image_asset_idx on public.pulls (image_asset_id);
