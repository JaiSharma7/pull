-- Moderation and the §512 rights workflow.
--
-- These tables exist BEFORE the UGC features that need them. Building the
-- takedown path after opening submissions is how hosts end up out of
-- compliance. See docs/content-policy.md.

create table public.reports (
  id          uuid primary key default extensions.gen_random_uuid(),
  reporter_id uuid references auth.users (id) on delete set null,
  target_type text not null,          -- pull | summary | stash | profile | note
  target_id   uuid not null,
  reason      text not null,          -- infringement | inaccuracy | abuse | spam
  detail      text,
  status      text not null default 'open',   -- open | actioned | dismissed
  created_at  timestamptz not null default now()
);

create index reports_reporter_idx on public.reports (reporter_id);
create index reports_target_idx   on public.reports (target_type, target_id);
create index reports_status_idx   on public.reports (status, created_at);

create table public.moderation_decisions (
  id           uuid primary key default extensions.gen_random_uuid(),
  report_id    uuid references public.reports (id) on delete cascade,
  moderator_id uuid references auth.users (id) on delete set null,
  action       text not null,        -- removed | restored | edited | no_action
  rationale    text,
  created_at   timestamptz not null default now()
);

create index moderation_decisions_report_idx    on public.moderation_decisions (report_id);
create index moderation_decisions_moderator_idx on public.moderation_decisions (moderator_id);

create table public.rights_requests (
  id            uuid primary key default extensions.gen_random_uuid(),
  claimant_name  text not null,
  claimant_email text not null,
  work_id        uuid references public.works (id) on delete set null,
  summary_id     uuid references public.summaries (id) on delete set null,
  notice_body    text not null,
  status         text not null default 'received',
  -- received | disabled | counter_noticed | restored | resolved
  received_at    timestamptz not null default now(),
  resolved_at    timestamptz,
  resolution     text
);

create index rights_requests_work_idx    on public.rights_requests (work_id);
create index rights_requests_summary_idx on public.rights_requests (summary_id);
create index rights_requests_status_idx  on public.rights_requests (status, received_at);
