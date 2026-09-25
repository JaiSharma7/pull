-- Evidence-backed study generation: a reader's own source versions become a claim
-- map with exact evidence, then a draft course of short lessons and varied questions.
--
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT.
--
-- It adds the generation half: a queued, budgeted job that calls the model twice
-- over (claims per bounded window of each source, then one course assembly from the
-- claims), a journal of every provider HTTP attempt written BEFORE the attempt is
-- sent, a ledger row per attempt keyed to that journal, an owner-scoped cache so an
-- unchanged version under an unchanged prompt/schema/model is never paid for twice,
-- and owner-scoped rows for what came back -- claims with their evidence spans
-- checked against the stored version, lessons, and questions.
--
-- It does not make anything learner-visible. Every generated row is `draft` or
-- `rejected`; validation, quarantine and correction are the next change, and the
-- guided course and practice screens come after that. Generation itself is behind
-- `study_generation_access`, an allowlist the service role manages, so deploying
-- this exposes nothing to a reader who has not been let in.
--
-- LAW 2. No model runs in a read path here. The only callers of a model are the
-- worker's study steps, each of which reserves against the global daily cap before
-- the call, and each HTTP attempt of which reaches `cost_ledger` -- including
-- retries, failures, and attempts whose cost the provider never reported.
--
-- LAW 5. Every table below enables RLS and carries its policy in this file. Readers
-- may SELECT their own rows and nothing else; there are no reader write grants. The
-- journal and the cache's cross-reader bookkeeping are invisible to the API.

-- --------------------------------------------------------- 0. version ownership key

-- Every derived row names a version AND its owner, and a composite foreign key makes
-- the database refuse a row whose owner is not the version's. That needs a unique key
-- on the pair; `id` alone is already unique, so this is an index for the FK to use,
-- not a new constraint on the data.
create unique index study_source_versions_id_owner_key
  on public.study_source_versions (id, owner_id);

-- ------------------------------------------------------------------ 1. beta access

create table public.study_generation_access (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  granted_at timestamptz not null default now(),
  note       text check (note is null or char_length(note) <= 200)
);

comment on table public.study_generation_access is
  'Readers allowed to request study generation while it is in beta. Written by the '
  'service role only. See 20260925010000.';

alter table public.study_generation_access enable row level security;
create policy study_generation_access_read_own on public.study_generation_access
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.study_generation_access from public, anon, authenticated;
grant select on public.study_generation_access to authenticated;

-- ------------------------------------------------------- 2. the provider-call journal

/*
 * One row per HTTP request to a model provider, written BEFORE it is sent.
 *
 * This is the independent inventory `docs/eval/study-quality.md` asks for. The ledger
 * is written by the pipeline's accounting after a call returns; this is written by the
 * transport underneath it, before the request leaves, and the transport refuses to
 * send if the row cannot be written. So a provider call cannot happen without a row
 * here, and a call the accounting forgot is a row here with no ledger row beside it --
 * which `study_provider_call_audit` reports. Neither is reconstructed from the other.
 *
 * No content: the endpoint names a model, never a key or a prompt.
 */
create table public.provider_calls (
  id          uuid primary key,
  job_id      uuid references public.generation_jobs (id) on delete set null,
  step        text not null check (char_length(step) between 1 and 64),
  provider    text not null check (provider in ('gemini', 'anthropic')),
  endpoint    text not null check (char_length(endpoint) between 1 and 200),
  outcome     text not null default 'open'
                check (outcome in ('open', 'responded', 'network_error', 'aborted')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,
  constraint provider_calls_closed_iff_not_open check ((outcome = 'open') = (closed_at is null)),
  constraint provider_calls_response_has_status
    check (outcome <> 'responded' or http_status is not null)
);

create index provider_calls_job_idx on public.provider_calls (job_id);
create index provider_calls_opened_idx on public.provider_calls (opened_at);

comment on table public.provider_calls is
  'Every model-provider HTTP attempt, journalled by the transport before it is sent. '
  'The independent inventory the ledger is reconciled against. See 20260925010000.';

alter table public.provider_calls enable row level security;
-- The same stance as `cost_ledger`: what the product calls, and when, is not a
-- reader's business. The service role bypasses RLS.
create policy provider_calls_no_api_access on public.provider_calls
  for select using (false);
revoke all on public.provider_calls from public, anon, authenticated;

/*
 * A ledger row per attempt, keyed to the journal.
 *
 * Nullable because every existing row predates the journal and records a whole step.
 * Unique because one attempt is charged once: `record_study_stage` inserts with
 * `on conflict do nothing`, so a replayed recording cannot double a charge.
 *
 * `usage_known` is false for an attempt the provider may have billed without saying
 * so -- an aborted or dropped connection after the request was sent. Its cost is
 * recorded as zero, because inventing a number is worse than stating that it is
 * unknown, and the audit counts these separately.
 */
alter table public.cost_ledger
  add column provider_call_id uuid references public.provider_calls (id) on delete restrict,
  add column usage_known boolean not null default true;

create unique index cost_ledger_provider_call_key on public.cost_ledger (provider_call_id);

-- ------------------------------------------------------------- 3. generations

create table public.study_generations (
  id                    uuid primary key default extensions.gen_random_uuid(),
  owner_id              uuid not null references auth.users (id) on delete cascade,
  job_id                uuid not null unique
                          references public.generation_jobs (id) on delete cascade,
  goal                  text not null check (char_length(goal) between 1 and 300),
  processing_consent_at timestamptz not null,
  title                 text check (title is null or char_length(title) between 1 and 200),
  overview              text check (overview is null or char_length(overview) <= 2000),
  objectives            text[] not null default '{}' check (cardinality(objectives) <= 6),
  recap                 text check (recap is null or char_length(recap) <= 2000),
  disagreements         jsonb not null default '[]'::jsonb
                          check (jsonb_typeof(disagreements) = 'array'),
  withheld              jsonb not null default '[]'::jsonb
                          check (jsonb_typeof(withheld) = 'array'),
  assembly_provenance   jsonb check (assembly_provenance is null
                                     or jsonb_typeof(assembly_provenance) = 'object'),
  assembled_at          timestamptz,
  created_at            timestamptz not null default now(),
  unique (id, owner_id)
);

create index study_generations_owner_idx on public.study_generations (owner_id, created_at desc);

create table public.study_generation_sources (
  -- A single-column key on every owner-scoped table, including the link tables, is what
  -- the account export pages by (`apps/web/src/lib/account-api.ts`).
  id                uuid primary key default extensions.gen_random_uuid(),
  generation_id     uuid not null,
  owner_id          uuid not null,
  source_version_id uuid not null,
  position          smallint not null check (position between 1 and 5),
  unique (generation_id, source_version_id),
  unique (generation_id, position),
  foreign key (generation_id, owner_id)
    references public.study_generations (id, owner_id) on delete cascade,
  foreign key (source_version_id, owner_id)
    references public.study_source_versions (id, owner_id) on delete cascade
);

create index study_generation_sources_version_idx
  on public.study_generation_sources (source_version_id, owner_id);

-- ------------------------------------------------------------------ 4. stage cache

/*
 * What a model returned for one stage, reusable by the same reader.
 *
 * The key is a SHA-256 over the stage, the prompt and schema hashes, the provider and
 * models it may call, and the exact input identity (a version and window, or the
 * extraction keys and the goal). `owner_id` is in the unique key as well as the row,
 * so one reader's entry can never answer another reader's lookup -- a cache hit is a
 * read of your own derivative, never a way to learn what someone else submitted.
 *
 * Each entry names the source versions it was derived from through
 * `study_stage_cache_sources`, and deleting any of those versions deletes the entry.
 */
create table public.study_stage_cache (
  id                 uuid primary key default extensions.gen_random_uuid(),
  owner_id           uuid not null references auth.users (id) on delete cascade,
  stage              text not null check (stage in ('extract', 'assemble')),
  cache_key          text not null check (cache_key ~ '^[0-9a-f]{64}$'),
  output             jsonb not null check (jsonb_typeof(output) = 'object'
                                           and octet_length(output::text) <= 400000),
  prompt_name        text not null check (char_length(prompt_name) between 1 and 100),
  prompt_hash        text not null check (prompt_hash ~ '^[0-9a-f]{64}$'),
  schema_hash        text not null check (schema_hash ~ '^[0-9a-f]{64}$'),
  provider_signature text not null check (char_length(provider_signature) between 1 and 300),
  model              text not null check (char_length(model) between 1 and 100),
  provider_call_id   uuid references public.provider_calls (id) on delete set null,
  job_id             uuid references public.generation_jobs (id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (owner_id, stage, cache_key),
  unique (id, owner_id)
);

create index study_stage_cache_provider_call_idx on public.study_stage_cache (provider_call_id);
create index study_stage_cache_job_idx on public.study_stage_cache (job_id);

create table public.study_stage_cache_sources (
  id                uuid primary key default extensions.gen_random_uuid(),
  cache_id          uuid not null,
  owner_id          uuid not null,
  source_version_id uuid not null,
  unique (cache_id, source_version_id),
  foreign key (cache_id, owner_id)
    references public.study_stage_cache (id, owner_id) on delete cascade,
  foreign key (source_version_id, owner_id)
    references public.study_source_versions (id, owner_id) on delete cascade
);

create index study_stage_cache_sources_version_idx
  on public.study_stage_cache_sources (source_version_id, owner_id);

-- ------------------------------------------------------- 5. claims and evidence

create table public.study_claims (
  id                uuid primary key default extensions.gen_random_uuid(),
  owner_id          uuid not null,
  generation_id     uuid not null,
  source_version_id uuid not null,
  claim_key         text not null check (claim_key ~ '^s[1-5]c[0-9]{1,4}$'),
  kind              text not null
                      check (kind in ('finding', 'definition', 'argument', 'method',
                                      'example', 'caveat')),
  statement         text not null check (char_length(statement) between 1 and 1000),
  qualifications    text[] not null default '{}' check (cardinality(qualifications) <= 6),
  attribution       text check (attribution is null or char_length(attribution) <= 300),
  status            text not null check (status in ('draft', 'rejected')),
  rejection_reasons text[] not null default '{}',
  prompt_hash       text not null check (prompt_hash ~ '^[0-9a-f]{64}$'),
  schema_hash       text not null check (schema_hash ~ '^[0-9a-f]{64}$'),
  model             text not null check (char_length(model) between 1 and 100),
  provider_call_id  uuid references public.provider_calls (id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint study_claims_rejected_has_reason
    check ((status = 'rejected') = (cardinality(rejection_reasons) > 0)),
  unique (generation_id, claim_key),
  unique (id, owner_id),
  foreign key (generation_id, owner_id)
    references public.study_generations (id, owner_id) on delete cascade,
  foreign key (source_version_id, owner_id)
    references public.study_source_versions (id, owner_id) on delete cascade
);

create index study_claims_owner_idx on public.study_claims (owner_id);
create index study_claims_version_idx on public.study_claims (source_version_id, owner_id);
create index study_claims_provider_call_idx on public.study_claims (provider_call_id);

/*
 * The exact span a claim rests on.
 *
 * `model_quote` is what the model said it copied. `span_text` is the text actually at
 * `[start_offset, end_offset)` of the stored version, in Unicode code points -- the
 * unit `char_length` and `substr` use -- and `persist_study_course` refuses a payload
 * in which the two disagree with the version. A quote the worker could not find is
 * kept, `unresolved`, with no span, so the audit can see what the model claimed.
 */
create table public.study_claim_evidence (
  id           uuid primary key default extensions.gen_random_uuid(),
  claim_id     uuid not null,
  owner_id     uuid not null,
  ordinal      smallint not null check (ordinal between 1 and 3),
  model_quote  text not null check (char_length(model_quote) between 1 and 1000),
  span_text    text check (span_text is null or char_length(span_text) between 1 and 2000),
  start_offset integer check (start_offset is null or start_offset >= 0),
  end_offset   integer,
  page         integer check (page is null or page > 0),
  match        text not null check (match in ('exact', 'normalized', 'unresolved')),
  unique (claim_id, ordinal),
  constraint study_claim_evidence_span_iff_resolved check (
    (match = 'unresolved') = (start_offset is null)
    and (start_offset is null) = (end_offset is null)
    and (start_offset is null) = (span_text is null)
  ),
  constraint study_claim_evidence_span_order
    check (end_offset is null or end_offset > start_offset),
  foreign key (claim_id, owner_id)
    references public.study_claims (id, owner_id) on delete cascade
);

create index study_claim_evidence_owner_idx on public.study_claim_evidence (owner_id);

-- ------------------------------------------------------------------ 6. lessons

create table public.study_lessons (
  id                uuid primary key default extensions.gen_random_uuid(),
  owner_id          uuid not null,
  generation_id     uuid not null,
  lesson_key        text not null check (lesson_key ~ '^l[0-9]{1,3}$'),
  position          smallint not null check (position between 1 and 24),
  unit_no           smallint not null check (unit_no between 1 and 6),
  unit_title        text not null check (char_length(unit_title) between 1 and 200),
  title             text not null check (char_length(title) between 1 and 200),
  objective         text not null check (char_length(objective) between 1 and 500),
  explanation       text not null check (char_length(explanation) between 1 and 6000),
  example           text check (example is null or char_length(example) <= 2000),
  recap             text not null check (char_length(recap) between 1 and 1000),
  minutes           smallint not null check (minutes between 1 and 5),
  status            text not null check (status in ('draft', 'rejected')),
  rejection_reasons text[] not null default '{}',
  prompt_hash       text not null check (prompt_hash ~ '^[0-9a-f]{64}$'),
  schema_hash       text not null check (schema_hash ~ '^[0-9a-f]{64}$'),
  model             text not null check (char_length(model) between 1 and 100),
  provider_call_id  uuid references public.provider_calls (id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint study_lessons_rejected_has_reason
    check ((status = 'rejected') = (cardinality(rejection_reasons) > 0)),
  unique (generation_id, lesson_key),
  unique (generation_id, position),
  unique (id, owner_id),
  foreign key (generation_id, owner_id)
    references public.study_generations (id, owner_id) on delete cascade
);

create index study_lessons_owner_idx on public.study_lessons (owner_id);
create index study_lessons_provider_call_idx on public.study_lessons (provider_call_id);

create table public.study_lesson_claims (
  id        uuid primary key default extensions.gen_random_uuid(),
  lesson_id uuid not null,
  claim_id  uuid not null,
  owner_id  uuid not null,
  unique (lesson_id, claim_id),
  foreign key (lesson_id, owner_id)
    references public.study_lessons (id, owner_id) on delete cascade,
  foreign key (claim_id, owner_id)
    references public.study_claims (id, owner_id) on delete cascade
);

create index study_lesson_claims_claim_idx on public.study_lesson_claims (claim_id, owner_id);
create index study_lesson_claims_owner_idx on public.study_lesson_claims (owner_id);

-- ---------------------------------------------------------------- 7. questions

create table public.study_items (
  id                uuid primary key default extensions.gen_random_uuid(),
  owner_id          uuid not null,
  generation_id     uuid not null,
  lesson_id         uuid,
  item_key          text not null check (item_key ~ '^q[0-9]{1,3}$'),
  purpose           text not null check (purpose in ('placement', 'practice', 'review')),
  kind              text not null
                      check (kind in ('multiple_choice', 'cloze', 'ordering', 'matching',
                                      'short_recall', 'comparison', 'application')),
  prompt            text not null check (char_length(prompt) between 1 and 1000),
  answer            text not null check (char_length(answer) between 1 and 1000),
  accepted_answers  text[] not null default '{}' check (cardinality(accepted_answers) <= 6),
  distractors       jsonb not null default '[]'::jsonb
                      check (jsonb_typeof(distractors) = 'array'
                             and jsonb_array_length(distractors) <= 4),
  cloze             text check (cloze is null or char_length(cloze) <= 1000),
  sequence          text[] not null default '{}' check (cardinality(sequence) <= 6),
  pairs             jsonb not null default '[]'::jsonb
                      check (jsonb_typeof(pairs) = 'array' and jsonb_array_length(pairs) <= 6),
  explanation       text not null check (char_length(explanation) between 1 and 2000),
  difficulty        smallint not null check (difficulty between 1 and 3),
  status            text not null check (status in ('draft', 'rejected')),
  rejection_reasons text[] not null default '{}',
  prompt_hash       text not null check (prompt_hash ~ '^[0-9a-f]{64}$'),
  schema_hash       text not null check (schema_hash ~ '^[0-9a-f]{64}$'),
  model             text not null check (char_length(model) between 1 and 100),
  provider_call_id  uuid references public.provider_calls (id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint study_items_rejected_has_reason
    check ((status = 'rejected') = (cardinality(rejection_reasons) > 0)),
  unique (generation_id, item_key),
  unique (id, owner_id),
  foreign key (generation_id, owner_id)
    references public.study_generations (id, owner_id) on delete cascade,
  -- MATCH SIMPLE: a course-level review question has no lesson and is not checked.
  foreign key (lesson_id, owner_id)
    references public.study_lessons (id, owner_id) on delete cascade
);

create index study_items_owner_idx on public.study_items (owner_id);
create index study_items_lesson_idx on public.study_items (lesson_id, owner_id);
create index study_items_provider_call_idx on public.study_items (provider_call_id);

create table public.study_item_claims (
  id       uuid primary key default extensions.gen_random_uuid(),
  item_id  uuid not null,
  claim_id uuid not null,
  owner_id uuid not null,
  unique (item_id, claim_id),
  foreign key (item_id, owner_id)
    references public.study_items (id, owner_id) on delete cascade,
  foreign key (claim_id, owner_id)
    references public.study_claims (id, owner_id) on delete cascade
);

create index study_item_claims_claim_idx on public.study_item_claims (claim_id, owner_id);
create index study_item_claims_owner_idx on public.study_item_claims (owner_id);

-- -------------------------------------------------------- 8. RLS: owner reads only

/*
 * One SELECT policy per table, to `authenticated`, keyed on the row's own owner. No
 * INSERT, UPDATE or DELETE grant to any API role: the worker writes through the two
 * service-role functions below, and a reader removes derived material by deleting the
 * source it came from, which cascades.
 */
alter table public.study_generations enable row level security;
create policy study_generations_read_own on public.study_generations
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_generation_sources enable row level security;
create policy study_generation_sources_read_own on public.study_generation_sources
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_stage_cache enable row level security;
create policy study_stage_cache_read_own on public.study_stage_cache
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_stage_cache_sources enable row level security;
create policy study_stage_cache_sources_read_own on public.study_stage_cache_sources
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_claims enable row level security;
create policy study_claims_read_own on public.study_claims
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_claim_evidence enable row level security;
create policy study_claim_evidence_read_own on public.study_claim_evidence
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_lessons enable row level security;
create policy study_lessons_read_own on public.study_lessons
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_lesson_claims enable row level security;
create policy study_lesson_claims_read_own on public.study_lesson_claims
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_items enable row level security;
create policy study_items_read_own on public.study_items
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_item_claims enable row level security;
create policy study_item_claims_read_own on public.study_item_claims
  for select to authenticated using (owner_id = (select auth.uid()));

revoke all on
  public.study_generations, public.study_generation_sources,
  public.study_stage_cache, public.study_stage_cache_sources,
  public.study_claims, public.study_claim_evidence,
  public.study_lessons, public.study_lesson_claims,
  public.study_items, public.study_item_claims
from public, anon, authenticated;

grant select on
  public.study_generations, public.study_generation_sources,
  public.study_stage_cache, public.study_stage_cache_sources,
  public.study_claims, public.study_claim_evidence,
  public.study_lessons, public.study_lesson_claims,
  public.study_items, public.study_item_claims
to authenticated;

-- ------------------------------------------ 9. deleting a source deletes its derivatives

/*
 * A course is derived from every source it was built from, so removing ANY of them
 * removes the whole course -- claims, lessons, questions and all -- rather than
 * leaving text derived from the deleted source behind. The same holds for a cache
 * entry. A foreign key cannot say "delete the parent when one of its children goes",
 * so a trigger does.
 *
 * `security definer` because it also runs inside the cascade from `study_sources`,
 * which the owner starts under RLS and which has no DELETE grant on these tables.
 */
create function public.study_generation_source_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  delete from public.study_generations where id = old.generation_id;
  return null;
end
$fn$;

create trigger study_generation_sources_cascade_up
  after delete on public.study_generation_sources
  for each row execute function public.study_generation_source_removed();

create function public.study_stage_cache_source_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  delete from public.study_stage_cache where id = old.cache_id;
  return null;
end
$fn$;

create trigger study_stage_cache_sources_cascade_up
  after delete on public.study_stage_cache_sources
  for each row execute function public.study_stage_cache_source_removed();

/*
 * And a job whose course is gone stops. Cancelled rather than failed: nothing went
 * wrong, the reader withdrew the material. The worker drops any message still queued
 * for it before calling a provider (`JobClosedError`).
 */
create function public.study_generation_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.generation_jobs
     set status = 'cancelled',
         error = 'the study material was deleted',
         finished_at = now()
   where id = old.job_id
     and status in ('queued', 'running');
  return null;
end
$fn$;

create trigger study_generations_cancel_job
  after delete on public.study_generations
  for each row execute function public.study_generation_removed();

revoke all on function public.study_generation_source_removed() from public, anon, authenticated;
revoke all on function public.study_stage_cache_source_removed() from public, anon, authenticated;
revoke all on function public.study_generation_removed() from public, anon, authenticated;

-- ------------------------------------------------------------- 10. the door

/*
 * The least one study job will reserve before it can finish: one claim extraction
 * and one assembly, each at the Gemini request's output ceiling (49,152 tokens at
 * $3.00/MTok) plus the smallest prompt. `study.test.ts` recomputes this from the
 * provider pricing and fails if the two disagree, which is the same arrangement
 * `min_job_cents()` has with `providers.ts`.
 */
create function public.study_min_job_cents()
returns numeric
language sql
immutable
set search_path = ''
as $$ select 31::numeric $$;

revoke all on function public.study_min_job_cents() from public;
grant execute on function public.study_min_job_cents() to authenticated, service_role;

/* Whether the caller may request study generation: signed in, not a guest, allowlisted. */
create function public.study_generation_available()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.study_generation_access a on a.user_id = u.id
    where u.id = (select auth.uid()) and u.is_anonymous is not true
  );
$$;

revoke all on function public.study_generation_available() from public, anon, authenticated;
grant execute on function public.study_generation_available() to authenticated;

/*
 * Queue a course from one to five of the caller's own source versions.
 *
 * The same door `enqueue_generation_job` keeps, counted in the same place:
 *
 *   - a mutation id, so a lost response replays the job instead of buying another;
 *   - three fast jobs a day, a five-minute stagger past that, fifty in total --
 *     counted over ALL of the requester's generation jobs, so study and summaries
 *     share one allowance rather than doubling it;
 *   - the global daily cap, refused at the door when the day cannot fund the two
 *     calls every study job needs.
 *
 * And three it adds: the versions must all be the caller's and total at most 200,000
 * characters; the reader must consent to sending that text to the model provider; and
 * the caller must be on the beta allowlist.
 *
 * The job's `target` holds only the generation id. The goal lives on
 * `study_generations` and the text on the versions, so deleting a source leaves no copy
 * of either on the job.
 */
create function public.enqueue_study_generation(
  p_source_version_ids uuid[],
  p_goal text,
  p_mutation_id uuid,
  p_processing_consent boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  daily_fast_limit   constant int := 3;
  daily_hard_ceiling constant int := 50;
  stagger_seconds    constant int := 300;
  max_sources        constant int := 5;
  max_total_chars    constant int := 200000;

  uid        uuid := (select auth.uid());
  v_goal     text := btrim(coalesce(p_goal, ''));
  wanted     int;
  owned      int;
  total      bigint;
  used       int;
  over       boolean;
  delay_for  int;
  new_job    uuid;
  new_gen    uuid := extensions.gen_random_uuid();
  replayed   public.generation_jobs%rowtype;
begin
  if uid is null then
    raise exception 'study generation requires a signed-in reader' using errcode = '28000';
  end if;
  if not exists (select 1 from auth.users u where u.id = uid and u.is_anonymous is not true) then
    raise exception 'study generation needs an account, not a guest session'
      using errcode = '28000';
  end if;
  if not exists (select 1 from public.study_generation_access a where a.user_id = uid) then
    raise exception 'study generation is in a limited beta and is not open to this account yet'
      using errcode = '42501';
  end if;
  if p_mutation_id is null then
    raise exception 'study generation needs a mutation id' using errcode = '22023';
  end if;

  -- Per-reader serialisation first, so two presses of one submit cannot both miss the
  -- replay below and race to the unique index.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

  select * into replayed
  from public.generation_jobs gj
  where gj.requester_id = uid and gj.client_mutation_id = p_mutation_id;
  if found then
    if replayed.kind <> 'study_course' then
      raise exception 'that mutation id belongs to a different request' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'jobId', replayed.id,
      'generationId', replayed.target ->> 'generationId',
      'status', replayed.status,
      'replayed', true
    );
  end if;

  if p_processing_consent is not true then
    raise exception 'study generation sends your text to the model provider; confirm that first'
      using errcode = '22023';
  end if;
  if char_length(v_goal) not between 1 and 300 then
    raise exception 'the study goal must be 1 to 300 characters' using errcode = '22023';
  end if;

  select count(distinct v) into wanted
  from unnest(coalesce(p_source_version_ids, '{}'::uuid[])) as v
  where v is not null;
  if wanted < 1 or wanted > max_sources
     or wanted <> cardinality(coalesce(p_source_version_ids, '{}'::uuid[])) then
    raise exception 'choose one to % different source versions', max_sources
      using errcode = '22023';
  end if;

  select count(*), coalesce(sum(char_length(v.extracted_text)), 0) into owned, total
  from public.study_source_versions v
  where v.id = any (p_source_version_ids) and v.owner_id = uid;
  if owned <> wanted then
    raise exception 'a chosen source version is unavailable' using errcode = '42501';
  end if;
  if total > max_total_chars then
    raise exception 'the chosen sources total % characters; the limit is %', total, max_total_chars
      using errcode = '22023';
  end if;

  if public.spend_today() + public.study_min_job_cents() > public.daily_spend_cap_cents() then
    raise exception 'the daily generation budget is spent. Study generation resumes at 00:00 UTC.'
      using errcode = '53400';
  end if;

  select count(*) into used
  from public.generation_jobs
  where requester_id = uid
    and created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';
  if used >= daily_hard_ceiling then
    raise exception 'daily generation ceiling reached (% jobs); try again tomorrow',
      daily_hard_ceiling using errcode = 'check_violation';
  end if;
  over := used >= daily_fast_limit;
  delay_for := case when over then (used - daily_fast_limit + 1) * stagger_seconds else 0 end;

  insert into public.generation_jobs
    (requester_id, kind, target, status, current_step, client_mutation_id)
  values
    (uid, 'study_course', jsonb_build_object('generationId', new_gen), 'queued',
     'study_prepare', p_mutation_id)
  returning id into new_job;

  insert into public.study_generations (id, owner_id, job_id, goal, processing_consent_at)
  values (new_gen, uid, new_job, v_goal, now());

  insert into public.study_generation_sources (generation_id, owner_id, source_version_id, position)
  select new_gen, uid, v.id, v.ord::smallint
  from unnest(p_source_version_ids) with ordinality as v(id, ord);

  perform pgmq.send('generation',
                    jsonb_build_object('jobId', new_job, 'step', 'study_prepare'),
                    delay_for);

  return jsonb_build_object(
    'jobId', new_job,
    'generationId', new_gen,
    'status', 'queued',
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for,
    'remainingToday', daily_hard_ceiling - used - 1,
    'replayed', false
  );
end
$fn$;

revoke all on function public.enqueue_study_generation(uuid[], text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.enqueue_study_generation(uuid[], text, uuid, boolean)
  to authenticated;

-- ------------------------------------------------------- 11. the worker's writes

/*
 * Record every provider attempt of one study stage, cache what it produced, and give
 * back the hold -- in one transaction.
 *
 * `p_calls` is one object per attempt: providerCallId, provider, model, inputTokens,
 * outputTokens, costCents, usageKnown. Each must name a journal row for this job and
 * step, or the whole recording is refused: a ledger row that points at a call the
 * transport never saw would make the reconciliation lie in the other direction.
 *
 * Idempotent on the call id, so a replay after a lost response neither doubles a
 * charge nor adds it to the job twice. The cache insert is idempotent on its key.
 *
 * The settle is `(job, step)`, one share, exactly as `record_job_step` does it.
 */
create function public.record_study_stage(
  p_job_id uuid,
  p_step text,
  p_calls jsonb,
  p_cache jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  job        public.generation_jobs%rowtype;
  gen_owner  uuid;
  attempt    jsonb;
  call_id    uuid;
  cost       numeric;
  added      numeric := 0;
  cached     uuid;
  version_id uuid;
begin
  select * into job from public.generation_jobs where id = p_job_id;
  if not found or job.kind <> 'study_course' then
    raise exception 'record_study_stage: % is not a study job', p_job_id using errcode = '22023';
  end if;
  if p_step not in ('study_extract', 'study_assemble') then
    raise exception 'record_study_stage: % does not call a provider', p_step
      using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_calls, '[]'::jsonb)) <> 'array' then
    raise exception 'record_study_stage: calls must be an array' using errcode = '22023';
  end if;

  for attempt in select value from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) loop
    call_id := (attempt ->> 'providerCallId')::uuid;
    cost := greatest(coalesce((attempt ->> 'costCents')::numeric, 0), 0);
    if not exists (
      select 1 from public.provider_calls pc
      where pc.id = call_id and pc.job_id = p_job_id and pc.step = p_step
    ) then
      raise exception 'record_study_stage: call % is not journalled for this job and step', call_id
        using errcode = '23503';
    end if;

    insert into public.cost_ledger
      (job_id, provider, operation, unit, quantity, cost_cents, provider_call_id, usage_known)
    values
      (p_job_id, attempt ->> 'provider', p_step, 'tokens',
       greatest(coalesce((attempt ->> 'inputTokens')::numeric, 0), 0)
         + greatest(coalesce((attempt ->> 'outputTokens')::numeric, 0), 0),
       cost, call_id, coalesce((attempt ->> 'usageKnown')::boolean, true))
    on conflict (provider_call_id) do nothing;
    if found then
      added := added + cost;
    end if;
  end loop;

  update public.generation_jobs
     set cost_cents = coalesce(cost_cents, 0) + added
   where id = p_job_id;

  if p_cache is not null then
    select g.owner_id into gen_owner
    from public.study_generations g
    where g.job_id = p_job_id;
    if gen_owner is null then
      raise exception 'record_study_stage: the study material for % was deleted', p_job_id
        using errcode = '23503';
    end if;

    insert into public.study_stage_cache
      (owner_id, stage, cache_key, output, prompt_name, prompt_hash, schema_hash,
       provider_signature, model, provider_call_id, job_id)
    values
      (gen_owner, p_cache ->> 'stage', p_cache ->> 'cacheKey', p_cache -> 'output',
       p_cache ->> 'promptName', p_cache ->> 'promptHash', p_cache ->> 'schemaHash',
       p_cache ->> 'providerSignature', p_cache ->> 'model',
       (p_cache ->> 'providerCallId')::uuid, p_job_id)
    on conflict (owner_id, stage, cache_key) do nothing
    returning id into cached;

    if cached is null then
      select c.id into cached
      from public.study_stage_cache c
      where c.owner_id = gen_owner
        and c.stage = p_cache ->> 'stage'
        and c.cache_key = p_cache ->> 'cacheKey';
    else
      -- Every version the entry was derived from must belong to this job's course;
      -- the composite key then makes the owner match too.
      for version_id in
        select (value #>> '{}')::uuid
        from jsonb_array_elements(coalesce(p_cache -> 'sourceVersionIds', '[]'::jsonb))
      loop
        if not exists (
          select 1 from public.study_generation_sources s
          join public.study_generations g on g.id = s.generation_id
          where g.job_id = p_job_id and s.source_version_id = version_id
        ) then
          raise exception 'record_study_stage: version % is not a source of this course', version_id
            using errcode = '23503';
        end if;
        insert into public.study_stage_cache_sources (cache_id, owner_id, source_version_id)
        values (cached, gen_owner, version_id)
        on conflict do nothing;
      end loop;
      if not exists (select 1 from public.study_stage_cache_sources where cache_id = cached) then
        raise exception 'record_study_stage: a cache entry must name the versions it came from'
          using errcode = '23502';
      end if;
    end if;
  end if;

  perform public.settle_budget(p_job_id, p_step);
  return cached;
end
$fn$;

revoke all on function public.record_study_stage(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_study_stage(uuid, text, jsonb, jsonb) to service_role;

/*
 * Write a course's claims, evidence, lessons and questions in one transaction.
 *
 * Idempotent: a course that already has claims is not written again, so a lost
 * response followed by a retry of `study_ground` cannot produce a second copy.
 *
 * AND IT CHECKS THE EVIDENCE ITSELF rather than trusting the worker's arithmetic.
 * Every resolved span must be exactly the text at those code-point offsets of the
 * stored version, and every claim, lesson link and question link must stay inside this
 * course. A payload that fails any of that is refused whole.
 */
create function public.persist_study_course(p_job_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  gen        public.study_generations%rowtype;
  claim      jsonb;
  ev         jsonb;
  lesson     jsonb;
  item       jsonb;
  ref        text;
  new_id     uuid;
  version_id uuid;
  ord        int;
  claim_ids  jsonb := '{}'::jsonb;
  lesson_ids jsonb := '{}'::jsonb;
  counts     jsonb;
begin
  select g.* into gen
  from public.study_generations g
  where g.job_id = p_job_id
  for update;
  if not found then
    raise exception 'persist_study_course: the study material for % was deleted', p_job_id
      using errcode = '23503';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'persist_study_course: payload must be an object' using errcode = '22023';
  end if;

  if exists (select 1 from public.study_claims c where c.generation_id = gen.id) then
    return jsonb_build_object(
      'generationId', gen.id,
      'replayed', true,
      'claims', (select count(*) from public.study_claims c where c.generation_id = gen.id),
      'lessons', (select count(*) from public.study_lessons l where l.generation_id = gen.id),
      'items', (select count(*) from public.study_items i where i.generation_id = gen.id)
    );
  end if;

  update public.study_generations
     set title = p_payload #>> '{course,title}',
         overview = p_payload #>> '{course,overview}',
         objectives = coalesce(
           array(select jsonb_array_elements_text(p_payload #> '{course,objectives}')), '{}'),
         recap = p_payload #>> '{course,recap}',
         disagreements = coalesce(p_payload #> '{course,disagreements}', '[]'::jsonb),
         withheld = coalesce(p_payload #> '{course,withheld}', '[]'::jsonb),
         assembly_provenance = p_payload -> 'provenance',
         assembled_at = now()
   where id = gen.id;

  for claim in select value from jsonb_array_elements(coalesce(p_payload -> 'claims', '[]'::jsonb)) loop
    version_id := (claim ->> 'sourceVersionId')::uuid;
    if not exists (
      select 1 from public.study_generation_sources s
      where s.generation_id = gen.id and s.source_version_id = version_id
    ) then
      raise exception 'persist_study_course: claim % cites a version outside this course',
        claim ->> 'key' using errcode = '23503';
    end if;

    insert into public.study_claims
      (owner_id, generation_id, source_version_id, claim_key, kind, statement,
       qualifications, attribution, status, rejection_reasons,
       prompt_hash, schema_hash, model, provider_call_id)
    values
      (gen.owner_id, gen.id, version_id, claim ->> 'key', claim ->> 'kind',
       claim ->> 'statement',
       coalesce(array(select jsonb_array_elements_text(claim -> 'qualifications')), '{}'),
       claim ->> 'attribution', claim ->> 'status',
       coalesce(array(select jsonb_array_elements_text(claim -> 'rejectionReasons')), '{}'),
       claim #>> '{provenance,promptHash}', claim #>> '{provenance,schemaHash}',
       claim #>> '{provenance,model}', (claim #>> '{provenance,providerCallId}')::uuid)
    returning id into new_id;
    claim_ids := claim_ids || jsonb_build_object(claim ->> 'key', new_id);

    ord := 0;
    for ev in select value from jsonb_array_elements(coalesce(claim -> 'evidence', '[]'::jsonb)) loop
      ord := ord + 1;
      if ev ->> 'match' <> 'unresolved' and not exists (
        select 1 from public.study_source_versions v
        where v.id = version_id
          and (ev ->> 'end')::int <= char_length(v.extracted_text)
          and substr(v.extracted_text, (ev ->> 'start')::int + 1,
                     (ev ->> 'end')::int - (ev ->> 'start')::int) = ev ->> 'spanText'
      ) then
        raise exception 'persist_study_course: evidence % of claim % is not in the stored version',
          ord, claim ->> 'key' using errcode = '23514';
      end if;
      insert into public.study_claim_evidence
        (claim_id, owner_id, ordinal, model_quote, span_text, start_offset, end_offset, page, match)
      values
        (new_id, gen.owner_id, ord, ev ->> 'modelQuote', ev ->> 'spanText',
         (ev ->> 'start')::int, (ev ->> 'end')::int, (ev ->> 'page')::int, ev ->> 'match');
    end loop;
  end loop;

  for lesson in select value from jsonb_array_elements(coalesce(p_payload -> 'lessons', '[]'::jsonb)) loop
    insert into public.study_lessons
      (owner_id, generation_id, lesson_key, position, unit_no, unit_title, title, objective,
       explanation, example, recap, minutes, status, rejection_reasons,
       prompt_hash, schema_hash, model, provider_call_id)
    values
      (gen.owner_id, gen.id, lesson ->> 'key', (lesson ->> 'position')::smallint,
       (lesson ->> 'unitNo')::smallint, lesson ->> 'unitTitle', lesson ->> 'title',
       lesson ->> 'objective', lesson ->> 'explanation', lesson ->> 'example',
       lesson ->> 'recap', (lesson ->> 'minutes')::smallint, lesson ->> 'status',
       coalesce(array(select jsonb_array_elements_text(lesson -> 'rejectionReasons')), '{}'),
       p_payload #>> '{provenance,promptHash}', p_payload #>> '{provenance,schemaHash}',
       p_payload #>> '{provenance,model}', (p_payload #>> '{provenance,providerCallId}')::uuid)
    returning id into new_id;
    lesson_ids := lesson_ids || jsonb_build_object(lesson ->> 'key', new_id);

    for ref in select jsonb_array_elements_text(coalesce(lesson -> 'claimKeys', '[]'::jsonb)) loop
      if claim_ids ->> ref is null then
        raise exception 'persist_study_course: lesson % cites unknown claim %', lesson ->> 'key', ref
          using errcode = '23503';
      end if;
      insert into public.study_lesson_claims (lesson_id, claim_id, owner_id)
      values (new_id, (claim_ids ->> ref)::uuid, gen.owner_id)
      on conflict do nothing;
    end loop;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
    if item ->> 'lessonKey' is not null and lesson_ids ->> (item ->> 'lessonKey') is null then
      raise exception 'persist_study_course: question % names unknown lesson %',
        item ->> 'key', item ->> 'lessonKey' using errcode = '23503';
    end if;

    insert into public.study_items
      (owner_id, generation_id, lesson_id, item_key, purpose, kind, prompt, answer,
       accepted_answers, distractors, cloze, sequence, pairs, explanation, difficulty,
       status, rejection_reasons, prompt_hash, schema_hash, model, provider_call_id)
    values
      (gen.owner_id, gen.id, (lesson_ids ->> (item ->> 'lessonKey'))::uuid,
       item ->> 'key', item ->> 'purpose', item ->> 'kind', item ->> 'prompt',
       item ->> 'answer',
       coalesce(array(select jsonb_array_elements_text(item -> 'acceptedAnswers')), '{}'),
       coalesce(item -> 'distractors', '[]'::jsonb), item ->> 'cloze',
       coalesce(array(select jsonb_array_elements_text(item -> 'sequence')), '{}'),
       coalesce(item -> 'pairs', '[]'::jsonb), item ->> 'explanation',
       (item ->> 'difficulty')::smallint, item ->> 'status',
       coalesce(array(select jsonb_array_elements_text(item -> 'rejectionReasons')), '{}'),
       p_payload #>> '{provenance,promptHash}', p_payload #>> '{provenance,schemaHash}',
       p_payload #>> '{provenance,model}', (p_payload #>> '{provenance,providerCallId}')::uuid)
    returning id into new_id;

    for ref in select jsonb_array_elements_text(coalesce(item -> 'claimKeys', '[]'::jsonb)) loop
      if claim_ids ->> ref is null then
        raise exception 'persist_study_course: question % cites unknown claim %', item ->> 'key', ref
          using errcode = '23503';
      end if;
      insert into public.study_item_claims (item_id, claim_id, owner_id)
      values (new_id, (claim_ids ->> ref)::uuid, gen.owner_id)
      on conflict do nothing;
    end loop;
  end loop;

  select jsonb_build_object(
           'generationId', gen.id,
           'replayed', false,
           'claims', (select count(*) from public.study_claims c where c.generation_id = gen.id),
           'lessons', (select count(*) from public.study_lessons l where l.generation_id = gen.id),
           'items', (select count(*) from public.study_items i where i.generation_id = gen.id))
    into counts;
  return counts;
end
$fn$;

revoke all on function public.persist_study_course(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.persist_study_course(uuid, jsonb) to service_role;

-- --------------------------------------------------------------- 12. the audit

/*
 * Reconcile the journal against the ledger, for operators and for the evaluator.
 *
 *   unledgered       a journalled attempt with no ledger row: the accounting missed it
 *   open             a journalled attempt never closed: the worker died mid-call
 *   usage_unknown    a ledgered attempt the provider may have billed without saying so
 *
 * Zero in the first column is the ledger-completeness claim; anything else is an alert.
 */
create function public.study_provider_call_audit(p_since timestamptz default now() - interval '1 day')
returns table (
  journalled    bigint,
  ledgered      bigint,
  unledgered    bigint,
  open_calls    bigint,
  usage_unknown bigint,
  cost_cents    numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(pc.id),
    count(cl.id),
    count(pc.id) filter (where cl.id is null),
    count(pc.id) filter (where pc.outcome = 'open' and pc.opened_at < now() - interval '10 minutes'),
    count(cl.id) filter (where cl.usage_known is false),
    coalesce(sum(cl.cost_cents), 0)
  from public.provider_calls pc
  left join public.cost_ledger cl on cl.provider_call_id = pc.id
  where pc.opened_at >= p_since;
$$;

revoke all on function public.study_provider_call_audit(timestamptz) from public, anon, authenticated;
grant execute on function public.study_provider_call_audit(timestamptz) to service_role;
