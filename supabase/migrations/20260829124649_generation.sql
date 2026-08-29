create table public.generation_jobs (
  id           uuid primary key default extensions.gen_random_uuid(),
  requester_id uuid references auth.users (id) on delete set null,
  kind         text not null default 'canonical_summary',
  target       jsonb not null default '{}'::jsonb,
  work_id      uuid references public.works (id) on delete cascade,
  summary_id   uuid references public.summaries (id) on delete set null,
  status       public.job_status not null default 'queued',
  current_step text not null default 'resolve_identity',
  attempts     int  not null default 0,
  visibility   public.visibility not null default 'private',
  cost_cents   numeric(12, 4) not null default 0,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index generation_jobs_requester_idx on public.generation_jobs (requester_id);
create index generation_jobs_work_idx      on public.generation_jobs (work_id);
create index generation_jobs_summary_idx   on public.generation_jobs (summary_id);
create index generation_jobs_status_idx    on public.generation_jobs (status, created_at);

create trigger generation_jobs_updated_at
  before update on public.generation_jobs
  for each row execute function public.set_updated_at();

create table public.job_steps (
  id            uuid primary key default extensions.gen_random_uuid(),
  job_id        uuid not null references public.generation_jobs (id) on delete cascade,
  step          text not null,
  attempt       int  not null default 1,
  status        public.job_status not null default 'running',
  model          text,
  prompt_version text,
  input_tokens   int,
  output_tokens  int,
  cost_cents     numeric(12, 4) not null default 0,
  duration_ms    int,
  output        jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  unique (job_id, step, attempt)
);

create index job_steps_job_idx on public.job_steps (job_id, created_at);

create table public.cost_ledger (
  id          bigint generated always as identity primary key,
  job_id      uuid references public.generation_jobs (id) on delete set null,
  step_id     uuid references public.job_steps (id) on delete set null,
  provider    text not null,
  operation   text not null,
  unit        text not null,
  quantity    numeric(14, 4) not null,
  cost_cents  numeric(12, 4) not null,
  created_at  timestamptz not null default now()
);

create index cost_ledger_job_idx  on public.cost_ledger (job_id);
create index cost_ledger_step_idx on public.cost_ledger (step_id);
create index cost_ledger_time_idx on public.cost_ledger (created_at desc);

create table public.rate_limits (
  user_id      uuid not null references auth.users (id) on delete cascade,
  bucket       text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (user_id, bucket, window_start)
);

create index rate_limits_window_idx on public.rate_limits (window_start);

select pgmq.create('generation');
