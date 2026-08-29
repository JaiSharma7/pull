-- ---------------------------------------------------------------------------
-- Interleaved Recall — the random questioning.
--
-- Questions appear INSIDE the feed at unpredictable moments rather than in a
-- Review tab users learn to skip. The randomness is bounded and seeded: without
-- bounds it is harassment, without a seed it cannot be tested.
-- ---------------------------------------------------------------------------

-- One seed per user per session. Every interrupt decision derives from it, so a
-- session is reproducible in tests and identical across devices mid-session.
create table public.session_seeds (
  id           uuid primary key default extensions.gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  seed         bigint not null,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  cards_seen   int not null default 0,
  interrupts_shown int not null default 0
);

create index session_seeds_user_idx on public.session_seeds (user_id, started_at desc);

-- The record of what was asked and what came back. Dismissals matter as much as
-- answers: they lower the user's pressure term so the system backs off.
create table public.interrupt_events (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  session_id    uuid references public.session_seeds (id) on delete set null,
  pull_id       uuid not null references public.pulls (id) on delete cascade,
  kind          public.interrupt_kind not null,
  slot_position int not null,                    -- card index within the session
  response      public.interrupt_response,
  grade         public.recall_grade,             -- recall / say_it_back only
  latency_ms    int,
  shown_at      timestamptz not null default now(),
  responded_at  timestamptz
);

create index interrupt_events_user_idx    on public.interrupt_events (user_id, shown_at desc);
create index interrupt_events_session_idx on public.interrupt_events (session_id);
create index interrupt_events_pull_idx    on public.interrupt_events (pull_id);

-- Tunables live in a table, not in code, so the rate can be adjusted from real
-- usage without a deploy. The defaults are the ones the plan specifies.
create table public.interleave_config (
  id                  boolean primary key default true,
  max_per_session     int  not null default 3,
  min_gap_cards       int  not null default 4,
  warmup_cards        int  not null default 2,   -- never interrupt before this
  base_probability    real not null default 0.08,
  pressure_multiplier real not null default 0.04,
  max_probability     real not null default 0.35,

  -- Weights must sum to 100. Recall dominates because it is the cheapest to
  -- answer and the best evidence for the knowledge model.
  weight_recall       int not null default 45,
  weight_say_it_back  int not null default 20,
  weight_conviction   int not null default 15,
  weight_counterpull  int not null default 12,
  weight_delta_probe  int not null default 8,

  updated_at timestamptz not null default now(),

  constraint interleave_singleton check (id),
  constraint interleave_weights_sum_100 check (
    weight_recall + weight_say_it_back + weight_conviction
      + weight_counterpull + weight_delta_probe = 100
  ),
  constraint interleave_probability_range check (
    base_probability between 0 and 1 and max_probability between 0 and 1
    and base_probability <= max_probability
  ),
  constraint interleave_budget_sane check (max_per_session between 0 and 10)
);

insert into public.interleave_config (id) values (true);

-- Deterministic PRNG. Postgres' random() is seeded per-session and unusable for
-- a plan that must be reproducible, so we hash the coordinates instead: the
-- same (user, day, session, page, slot) always yields the same draw.
create or replace function public.seeded_unit(
  seed bigint,
  page int,
  slot int,
  salt text default ''
)
returns double precision
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- md5 -> take 52 bits -> scale into [0,1)
  select ('x' || substr(
            md5(seed::text || ':' || page::text || ':' || slot::text || ':' || salt),
            1, 13
          ))::bit(52)::bigint::double precision
         / 4503599627370496.0;   -- 2^52
$$;

comment on function public.seeded_unit is
  'Deterministic uniform draw in [0,1). Same coordinates always give the same value.';
