-- ---------------------------------------------------------------------------
-- Extensions and shared enums.
--
-- Supabase installs extensions into `extensions`, which is already on the API
-- search_path. pgmq and pg_cron insist on their own schemas.
-- ---------------------------------------------------------------------------

create extension if not exists "uuid-ossp"  with schema extensions;
create extension if not exists pgcrypto     with schema extensions;
create extension if not exists pg_trgm      with schema extensions;
create extension if not exists citext       with schema extensions;
create extension if not exists vector       with schema extensions;

-- Queue + scheduler for the generation step-machine. Edge Functions cap at
-- 150s wall clock, so generation runs one step per invocation and re-enqueues.
create extension if not exists pgmq;
create extension if not exists pg_cron;
create extension if not exists pg_net       with schema extensions;

-- --- shared enums ----------------------------------------------------------
-- These are mirrored in packages/schemas/src/index.ts. Change both together.

create type public.work_kind as enum (
  'book', 'film', 'documentary', 'podcast', 'paper',
  'essay', 'lecture', 'video', 'interview', 'other'
);

create type public.rights_status as enum (
  'public_domain',      -- our launch corpus lives here
  'licensed',
  'user_owned',         -- a user's own upload; private by default
  'public_reference',
  'community',
  'review_required'     -- the safe default: not publishable
);

create type public.publish_status as enum ('draft', 'published', 'retired');
create type public.visibility     as enum ('private', 'unlisted', 'public');
create type public.spoiler_level  as enum ('none', 'mild', 'full');

create type public.relation_kind as enum (
  'related',
  'opposes',       -- powers Counterpull
  'elaborates',
  'ancestor',      -- powers Idea Lineage
  'descendant'
);

create type public.stance as enum ('agree', 'disagree', 'unsure');

create type public.acquisition as enum (
  'read', 'saved', 'explained', 'quizzed', 'probed'
);

create type public.interrupt_kind as enum (
  'recall', 'say_it_back', 'conviction', 'counterpull', 'delta_probe'
);

create type public.interrupt_response as enum (
  'answered', 'dismissed', 'expired'
);

create type public.recall_grade as enum ('forgot', 'hard', 'good', 'easy');

create type public.locator_type as enum (
  'page', 'chapter', 'timestamp', 'section', 'url'
);

create type public.job_status as enum (
  'queued', 'running', 'succeeded', 'failed', 'cancelled'
);

create type public.curator_kind as enum ('editorial', 'community', 'algorithmic');

-- --- shared helpers --------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at is
  'Trigger helper: stamps updated_at on write.';
