create extension if not exists "uuid-ossp"  with schema extensions;
create extension if not exists pgcrypto     with schema extensions;
create extension if not exists pg_trgm      with schema extensions;
create extension if not exists citext       with schema extensions;
create extension if not exists vector       with schema extensions;

create extension if not exists pgmq;
create extension if not exists pg_cron;
create extension if not exists pg_net       with schema extensions;

create type public.work_kind as enum (
  'book', 'film', 'documentary', 'podcast', 'paper',
  'essay', 'lecture', 'video', 'interview', 'other'
);

create type public.rights_status as enum (
  'public_domain',
  'licensed',
  'user_owned',
  'public_reference',
  'community',
  'review_required'
);

create type public.publish_status as enum ('draft', 'published', 'retired');
create type public.visibility     as enum ('private', 'unlisted', 'public');
create type public.spoiler_level  as enum ('none', 'mild', 'full');

create type public.relation_kind as enum (
  'related', 'opposes', 'elaborates', 'ancestor', 'descendant'
);

create type public.stance as enum ('agree', 'disagree', 'unsure');

create type public.acquisition as enum (
  'read', 'saved', 'explained', 'quizzed', 'probed'
);

create type public.interrupt_kind as enum (
  'recall', 'say_it_back', 'conviction', 'counterpull', 'delta_probe'
);

create type public.interrupt_response as enum ('answered', 'dismissed', 'expired');

create type public.recall_grade as enum ('forgot', 'hard', 'good', 'easy');

create type public.locator_type as enum ('page', 'chapter', 'timestamp', 'section', 'url');

create type public.job_status as enum (
  'queued', 'running', 'succeeded', 'failed', 'cancelled'
);

create type public.curator_kind as enum ('editorial', 'community', 'algorithmic');

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
