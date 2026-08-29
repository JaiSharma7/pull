create table public.knowledge_states (
  user_id      uuid not null references auth.users (id) on delete cascade,
  pull_id      uuid not null references public.pulls (id) on delete cascade,
  stability    real not null default 1.0,
  difficulty   real not null default 0.3,
  reps         int  not null default 0,
  lapses       int  not null default 0,
  acquired_via public.acquisition not null default 'read',
  last_seen_at timestamptz not null default now(),
  next_due_at  timestamptz not null default now() + interval '1 day',
  primary key (user_id, pull_id),
  constraint knowledge_stability_positive check (stability > 0),
  constraint knowledge_difficulty_range   check (difficulty between 0 and 1)
);

create index knowledge_due_idx
  on public.knowledge_states (user_id, next_due_at)
  where next_due_at is not null;

create index knowledge_pull_idx on public.knowledge_states (pull_id);

create or replace function public.retrievability(
  stability real,
  last_seen  timestamptz,
  at_time    timestamptz default now()
)
returns real
language sql
immutable
parallel safe
set search_path = ''
as $$
  select least(1.0, greatest(0.0,
    exp(-greatest(extract(epoch from (at_time - last_seen)) / 86400.0, 0.0)
        / greatest(stability, 0.0001))
  ))::real;
$$;

comment on function public.retrievability is
  'Probability the user can recall this right now. Computed, never stored.';

create table public.user_knowledge_vectors (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  embedding  extensions.vector(1536),
  idea_count int not null default 0,
  updated_at timestamptz not null default now()
);

create index user_knowledge_vectors_hnsw
  on public.user_knowledge_vectors
  using hnsw (embedding extensions.vector_cosine_ops);

create table public.convictions (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  pull_id       uuid not null references public.pulls (id) on delete cascade,
  stance        public.stance not null,
  confidence    real not null default 0.6,
  rationale     text,
  created_at    timestamptz not null default now(),
  superseded_by uuid references public.convictions (id) on delete set null,
  constraint convictions_confidence_range check (confidence between 0 and 1)
);

create index convictions_user_idx       on public.convictions (user_id, created_at desc);
create index convictions_pull_idx       on public.convictions (pull_id);
create index convictions_superseded_idx on public.convictions (superseded_by);

create unique index convictions_one_current_per_pull
  on public.convictions (user_id, pull_id)
  where superseded_by is null;

create table public.explanations (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  pull_id       uuid not null references public.pulls (id) on delete cascade,
  text          text not null,
  audio_path    text,
  gap_score     real,
  missed_points jsonb not null default '[]'::jsonb,
  graded_at     timestamptz,
  created_at    timestamptz not null default now(),
  constraint explanations_gap_range check (gap_score is null or gap_score between 0 and 1)
);

create index explanations_user_idx on public.explanations (user_id, created_at desc);
create index explanations_pull_idx on public.explanations (pull_id);
