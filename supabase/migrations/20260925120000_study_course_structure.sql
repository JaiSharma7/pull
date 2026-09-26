-- Study courses: the private container a reader studies from, the bundle of sources it is
-- built on, the generations it has had, and the reader's progress through it. Roadmap PR 6.
--
-- Until now a course was one `study_generations` row, tied to the job that made it: there
-- was nothing to come back to once a source changed, and nothing recorded what the reader
-- had seen. This adds:
--
--   study_courses          the course itself, owner-scoped, separate from the public
--                          curated `paths`. It outlives any one generation.
--   study_course_sources   its source bundle: which of the reader's sources it follows,
--                          in order. A generation pins the versions it used
--                          (`study_generation_sources`); the bundle names the sources, so
--                          a newer version of one is visible as an update.
--   study_generations      gains `course_id`. A course's current generation is its newest
--                          one whose validation has finished.
--   study_progress_events  what the reader was shown, read, skipped: append-only, recorded
--                          through `record_study_progress` with a client event id, so an
--                          offline queue can replay it. Exposure is never proof of recall.
--
-- and the read path over them, in SQL (law 2): `study_course_overview`,
-- `study_course_outline` and `study_course_questions`.
--
-- Lock order. A source deletion takes the source, then its versions, then (through
-- triggers) the generations built on them and, if it was the bundle's last source, the
-- course. Every writer here takes rows in that same order -- a progress event references
-- the generation and the lesson or question, never the course; `enqueue_study_generation`
-- links the bundle's sources before the versions; a regeneration key-shares the bundle's
-- sources before it touches the course -- so none can deadlock with a deletion.

-- ------------------------------------------------------------------ courses

create table public.study_courses (
  id          uuid primary key default extensions.gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  goal        text not null check (char_length(goal) between 1 and 300),
  created_at  timestamptz not null default now(),
  unique (id, owner_id)
);

create index study_courses_owner_idx on public.study_courses (owner_id, created_at desc);

alter table public.study_courses enable row level security;

create policy study_courses_read_own on public.study_courses
  for select to authenticated using (owner_id = (select auth.uid()));
-- A reader may delete a course and keep its sources; everything the course derived goes
-- with it, and a job still preparing it is cancelled (`study_generations_cancel_job`).
create policy study_courses_delete_own on public.study_courses
  for delete to authenticated using (owner_id = (select auth.uid()));

revoke all on public.study_courses from public, anon, authenticated, service_role;
grant select, delete on public.study_courses to authenticated;
grant select on public.study_courses to service_role;

comment on table public.study_courses is
  'A reader''s private course: a goal and a bundle of their own sources, prepared by one or more generations. Separate from the public curated paths.';

-- ------------------------------------------------------------------ the source bundle

create table public.study_course_sources (
  -- A single-column key, so the account export can page by it.
  id         uuid primary key default extensions.gen_random_uuid(),
  course_id  uuid not null,
  owner_id   uuid not null,
  source_id  uuid not null,
  position   smallint not null check (position between 1 and 5),
  unique (course_id, source_id),
  unique (course_id, position),
  foreign key (course_id, owner_id) references public.study_courses (id, owner_id)
    on delete cascade,
  foreign key (source_id, owner_id) references public.study_sources (id, owner_id)
    on delete cascade
);

create index study_course_sources_source_idx on public.study_course_sources (source_id, owner_id);
create index study_course_sources_owner_idx on public.study_course_sources (owner_id, id);

alter table public.study_course_sources enable row level security;

create policy study_course_sources_read_own on public.study_course_sources
  for select to authenticated using (owner_id = (select auth.uid()));

revoke all on public.study_course_sources from public, anon, authenticated, service_role;
grant select on public.study_course_sources to authenticated, service_role;

/*
 * A course whose last source is deleted goes too: with no material left there is nothing
 * to study or regenerate. A course that loses one of several sources stays, without the
 * generations built on the deleted one, and can be prepared again from the rest.
 *
 * `security definer` because it runs inside the cascade from `study_sources`, which the
 * owner starts under RLS.
 */
create function public.study_course_source_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  delete from public.study_courses c
  where c.id = old.course_id
    and not exists (select 1 from public.study_course_sources s where s.course_id = old.course_id);
  return null;
end
$fn$;

revoke all on function public.study_course_source_removed()
  from public, anon, authenticated, service_role;

create trigger study_course_sources_cascade_up
  after delete on public.study_course_sources
  for each row execute function public.study_course_source_removed();

-- ------------------------------------------------------------------ generations belong to a course

alter table public.study_generations add column course_id uuid;

-- Every generation made before this has a course of its own, with the same id and goal,
-- and a bundle of the sources its versions came from.
insert into public.study_courses (id, owner_id, goal, created_at)
select g.id, g.owner_id, g.goal, g.created_at
from public.study_generations g;

update public.study_generations set course_id = id;

insert into public.study_course_sources (course_id, owner_id, source_id, position)
select s.generation_id, s.owner_id, s.source_id,
       row_number() over (partition by s.generation_id order by s.first_position)::smallint
from (
  select gs.generation_id, gs.owner_id, v.source_id, min(gs.position) as first_position
  from public.study_generation_sources gs
  join public.study_source_versions v on v.id = gs.source_version_id
  group by gs.generation_id, gs.owner_id, v.source_id
) as s;

alter table public.study_generations
  alter column course_id set not null,
  add constraint study_generations_course_fk foreign key (course_id, owner_id)
    references public.study_courses (id, owner_id) on delete cascade;

create index study_generations_course_idx on public.study_generations (course_id, created_at desc);

-- ------------------------------------------------------------------ progress events

create table public.study_progress_events (
  id               bigint generated always as identity primary key,
  owner_id         uuid not null,
  generation_id    uuid not null,
  lesson_id        uuid,
  item_id          uuid,
  kind             text not null
    check (kind in ('lesson_shown', 'lesson_read', 'lesson_skipped', 'item_shown')),
  client_event_id  uuid not null,
  -- When the reader saw it, as their device reports: clamped to the last thirty days and
  -- never the future. Exposure is never proof, so a device clock cannot buy anything.
  occurred_at      timestamptz not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  unique (owner_id, client_event_id),
  constraint study_progress_events_target check (
    (kind like 'lesson\_%') = (lesson_id is not null)
    and (kind like 'item\_%') = (item_id is not null)),
  -- The generation first, then the lesson or question: the order a deletion takes them.
  foreign key (generation_id, owner_id) references public.study_generations (id, owner_id)
    on delete cascade,
  foreign key (lesson_id, owner_id) references public.study_lessons (id, owner_id)
    on delete cascade,
  foreign key (item_id, owner_id) references public.study_items (id, owner_id)
    on delete cascade
);

create index study_progress_events_generation_idx
  on public.study_progress_events (generation_id, owner_id);
create index study_progress_events_lesson_idx
  on public.study_progress_events (lesson_id, owner_id, kind);
create index study_progress_events_item_idx
  on public.study_progress_events (item_id, owner_id, kind);
create index study_progress_events_owner_idx
  on public.study_progress_events (owner_id, recorded_at);

alter table public.study_progress_events enable row level security;

create policy study_progress_events_read_own on public.study_progress_events
  for select to authenticated using (owner_id = (select auth.uid()));

revoke all on public.study_progress_events from public, anon, authenticated, service_role;
grant select on public.study_progress_events to authenticated, service_role;

create function public.study_progress_is_final()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'recorded progress cannot be changed' using errcode = '55000';
end
$fn$;

revoke all on function public.study_progress_is_final()
  from public, anon, authenticated, service_role;

create trigger study_progress_events_are_final before update on public.study_progress_events
  for each row execute function public.study_progress_is_final();

/*
 * The reader's one write path for progress: a batch of what they were shown, read or
 * skipped, each with the client's own event id so a queue replayed after a lost response
 * or an offline spell records each event once.
 *
 *   p_events  [{ clientEventId, kind, lessonId | itemId, occurredAt? }], 1 to 100
 *
 * Returns { recorded, duplicates, refused: [{ index, clientEventId?, reason }] }. An event
 * is refused, and the rest of the batch still recorded, when it is malformed, names
 * nothing of the reader's (`not_found`, which also covers someone else's), names content
 * that was never shown (`not_shown`: never validated), or would pass the daily limit of
 * 2,000 (`limit`). A refused event is refused for good; the client can drop it.
 */
create function public.record_study_progress(p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  daily_limit constant int := 2000;
  batch_limit constant int := 100;

  uid         uuid := (select auth.uid());
  ev          jsonb;
  ord         bigint;
  v_client    uuid;
  v_kind      text;
  v_target    uuid;
  v_at        timestamptz;
  v_gen       uuid;
  v_shown     boolean;
  used        int;
  recorded    int := 0;
  duplicates  int := 0;
  refused     jsonb := '[]'::jsonb;
begin
  if uid is null then
    raise exception 'recording progress requires a signed-in reader' using errcode = '28000';
  end if;
  if jsonb_typeof(p_events) is distinct from 'array'
     or jsonb_array_length(p_events) not between 1 and batch_limit then
    raise exception 'send 1 to % progress events at a time', batch_limit using errcode = '22023';
  end if;

  -- One batch at a time per reader, so the daily count below cannot be raced past.
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended('study_progress:' || uid::text, 0));

  select count(*) into used
  from public.study_progress_events e
  where e.owner_id = uid
    and e.recorded_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

  for ev, ord in select value, ordinality from jsonb_array_elements(p_events) with ordinality loop
    v_client := null;
    v_target := null;
    begin
      if jsonb_typeof(ev) is distinct from 'object' then
        raise exception using errcode = '22023';
      end if;
      v_client := (ev ->> 'clientEventId')::uuid;
      v_kind := ev ->> 'kind';
      v_target := case when v_kind like 'lesson\_%' then (ev ->> 'lessonId')::uuid
                       when v_kind like 'item\_%' then (ev ->> 'itemId')::uuid end;
      v_at := coalesce((ev ->> 'occurredAt')::timestamptz, now());
    exception when data_exception then
      refused := refused || jsonb_build_object('index', ord - 1, 'reason', 'malformed');
      continue;
    end;
    if v_client is null or v_target is null
       or v_kind not in ('lesson_shown', 'lesson_read', 'lesson_skipped', 'item_shown') then
      refused := refused || jsonb_strip_nulls(jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'malformed'));
      continue;
    end if;

    if exists (select 1 from public.study_progress_events e
               where e.owner_id = uid and e.client_event_id = v_client) then
      duplicates := duplicates + 1;
      continue;
    end if;

    -- The reader's own lesson or question, and one a learner could have been shown: it
    -- has been validated at some point (a suspended or retired one was, a quarantined or
    -- rejected one never).
    if v_kind like 'lesson\_%' then
      select l.generation_id,
             exists (select 1 from public.study_status_log s
                     where s.lesson_id = l.id and s.owner_id = uid and s.to_status = 'validated')
        into v_gen, v_shown
      from public.study_lessons l
      where l.id = v_target and l.owner_id = uid;
    else
      select i.generation_id,
             exists (select 1 from public.study_status_log s
                     where s.item_id = i.id and s.owner_id = uid and s.to_status = 'validated')
        into v_gen, v_shown
      from public.study_items i
      where i.id = v_target and i.owner_id = uid;
    end if;
    if v_gen is null then
      refused := refused || jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'not_found');
      continue;
    end if;
    if not v_shown then
      refused := refused || jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'not_shown');
      continue;
    end if;
    if used >= daily_limit then
      refused := refused || jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'limit');
      continue;
    end if;

    begin
      insert into public.study_progress_events
        (owner_id, generation_id, lesson_id, item_id, kind, client_event_id, occurred_at)
      values
        (uid, v_gen,
         case when v_kind like 'lesson\_%' then v_target end,
         case when v_kind like 'item\_%' then v_target end,
         v_kind, v_client,
         least(greatest(v_at, now() - interval '30 days'), now()));
      recorded := recorded + 1;
      used := used + 1;
    exception
      -- Deleted between the check and the insert.
      when foreign_key_violation then
        refused := refused || jsonb_build_object(
          'index', ord - 1, 'clientEventId', v_client, 'reason', 'not_found');
    end;
    v_gen := null;
  end loop;

  return jsonb_build_object('recorded', recorded, 'duplicates', duplicates, 'refused', refused);
end
$fn$;

revoke all on function public.record_study_progress(jsonb) from public, anon, authenticated;
grant execute on function public.record_study_progress(jsonb) to authenticated;

-- ------------------------------------------------------------------ enqueue and regenerate

/*
 * The body of `enqueue_study_generation` (20260925030000), shared with
 * `regenerate_study_course`. With no course it creates one, and its bundle from the
 * sources of the chosen versions; with a course it prepares that course again, refusing
 * while a generation of it is still being prepared or when nothing in its sources has
 * changed (an unchanged bundle would come back from the stage cache as the same course).
 *
 * Not callable from the API: the two functions below are its only callers.
 */
create function public.study_enqueue_course(
  p_source_version_ids uuid[],
  p_goal text,
  p_mutation_id uuid,
  p_processing_consent boolean,
  p_course_id uuid
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
  v_course   uuid := p_course_id;
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
      'courseId', (select g.course_id from public.study_generations g
                   where g.job_id = replayed.id),
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

  if v_course is not null then
    -- The bundle's sources first: a source deletion takes the source before anything
    -- built on it, so holding the sources before the course keeps one order.
    perform 1
    from public.study_sources s
    join public.study_course_sources cs on cs.source_id = s.id
    where cs.course_id = v_course and cs.owner_id = uid
    for key share of s;
    if not exists (select 1 from public.study_courses c
                   where c.id = v_course and c.owner_id = uid) then
      raise exception 'no such course' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.study_generations g
               join public.generation_jobs j on j.id = g.job_id
               where g.course_id = v_course and j.status in ('queued', 'running')) then
      raise exception 'this course is already being prepared' using errcode = '55000';
    end if;
    if exists (
      select 1 from public.study_generations g
      where g.course_id = v_course and g.assembled_at is not null and g.text_status <> 'pending'
        and (select array_agg(gs.source_version_id order by gs.source_version_id)
             from public.study_generation_sources gs where gs.generation_id = g.id)
            = (select array_agg(x order by x) from unnest(p_source_version_ids) as x)
    ) then
      raise exception 'nothing in this course''s sources has changed since it was last prepared'
        using errcode = '55000';
    end if;
  end if;

  if public.spend_today() + public.study_min_job_cents() > public.daily_spend_cap_cents() then
    raise exception 'the daily generation budget is spent. Study generation resumes at 00:00 UTC.'
      using errcode = '53400';
  end if;
  if public.study_requester_spend_today(uid) + public.study_min_job_cents()
     > public.study_requester_daily_cap_cents() then
    raise exception 'your share of today''s study generation budget is spent. It resets at 00:00 UTC.'
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

  if v_course is null then
    insert into public.study_courses (owner_id, goal) values (uid, v_goal)
    returning id into v_course;
    -- One entry per source, in the order its first chosen version was given. Before the
    -- versions are linked below: the sources first, as a deletion takes them.
    insert into public.study_course_sources (course_id, owner_id, source_id, position)
    select v_course, uid, s.source_id,
           row_number() over (order by s.first_ord)::smallint
    from (
      select v.source_id, min(x.ord) as first_ord
      from unnest(p_source_version_ids) with ordinality as x(id, ord)
      join public.study_source_versions v on v.id = x.id
      group by v.source_id
    ) as s;
  end if;

  insert into public.generation_jobs
    (requester_id, kind, target, status, current_step, client_mutation_id)
  values
    (uid, 'study_course', jsonb_build_object('generationId', new_gen), 'queued',
     'study_prepare', p_mutation_id)
  returning id into new_job;

  insert into public.study_generations
    (id, owner_id, job_id, goal, processing_consent_at, course_id)
  values (new_gen, uid, new_job, v_goal, now(), v_course);

  insert into public.study_generation_sources (generation_id, owner_id, source_version_id, position)
  select new_gen, uid, v.id, v.ord::smallint
  from unnest(p_source_version_ids) with ordinality as v(id, ord);

  perform pgmq.send('generation',
                    jsonb_build_object('jobId', new_job, 'step', 'study_prepare'),
                    delay_for);

  return jsonb_build_object(
    'jobId', new_job,
    'generationId', new_gen,
    'courseId', v_course,
    'status', 'queued',
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for,
    'remainingToday', daily_hard_ceiling - used - 1,
    'replayed', false
  );
end
$fn$;

revoke all on function public.study_enqueue_course(uuid[], text, uuid, boolean, uuid)
  from public, anon, authenticated, service_role;

/* As 20260925030000, and every new course is a `study_courses` row with its bundle. */
create or replace function public.enqueue_study_generation(
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
begin
  return public.study_enqueue_course(
    p_source_version_ids, p_goal, p_mutation_id, p_processing_consent, null);
end
$fn$;

/*
 * Prepare a course again from the newest version of each source in its bundle, for the
 * course's own goal: the explicit regeneration a changed source needs. Nothing carries
 * over -- the new generation's lessons and questions are new rows, and progress and proof
 * attach to the rows they were recorded against.
 */
create function public.regenerate_study_course(
  p_course_id uuid,
  p_mutation_id uuid,
  p_processing_consent boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  uid        uuid := (select auth.uid());
  v_goal     text;
  v_versions uuid[];
begin
  if uid is null then
    raise exception 'study generation requires a signed-in reader' using errcode = '28000';
  end if;

  select c.goal into v_goal
  from public.study_courses c
  where c.id = p_course_id and c.owner_id = uid;
  -- A replayed request answers even if the course has gone since.
  if v_goal is null and not exists (
    select 1 from public.generation_jobs gj
    where gj.requester_id = uid and gj.client_mutation_id = p_mutation_id) then
    raise exception 'no such course' using errcode = 'P0002';
  end if;

  select array_agg(latest.id order by cs.position) into v_versions
  from public.study_course_sources cs
  cross join lateral (
    select v.id from public.study_source_versions v
    where v.source_id = cs.source_id and v.owner_id = uid
    order by v.version_no desc
    limit 1
  ) as latest
  where cs.course_id = p_course_id and cs.owner_id = uid;

  return public.study_enqueue_course(
    v_versions, v_goal, p_mutation_id, p_processing_consent, p_course_id);
end
$fn$;

revoke all on function public.regenerate_study_course(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.regenerate_study_course(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ the read path

/*
 * A course's current generation: its newest one whose validation has finished (persisted,
 * and its own text decided in the transaction that moved its drafts). A generation still
 * being prepared, or one that failed before it was persisted, is not current; the one
 * before it stays current until then.
 */
create function public.study_course_generation(p_course_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $fn$
  select g.id
  from public.study_generations g
  where g.course_id = p_course_id
    and g.assembled_at is not null
    and g.text_status <> 'pending'
  order by g.created_at desc, g.id desc
  limit 1
$fn$;

/*
 * The reader's courses, one row each: what the current generation says (its text only
 * once validated), whether a newer generation is being prepared or a source has a newer
 * version, and how far the reader has got -- lessons read, and claims whose recall they
 * have demonstrated (`study_proven_claims`, the proof rule's set form).
 */
create view public.study_course_overview with (security_invoker = true) as
-- Materialized: the proven set is computed once per query, not once per course.
with proven as materialized (
  select p.claim_id from public.study_proven_claims() as p
)
select
  c.id as course_id,
  c.goal,
  c.created_at,
  (select count(*) from public.study_course_sources s where s.course_id = c.id)::int
    as source_count,
  cur.id as generation_id,
  case when cur.text_status = 'validated' then cur.title end as title,
  case when cur.text_status = 'validated' then cur.overview end as overview,
  case when cur.text_status = 'validated' then cur.objectives else '{}'::text[] end
    as objectives,
  case when cur.text_status = 'validated' then cur.recap end as recap,
  latest.generation_id as latest_generation_id,
  latest.job_status as latest_job_status,
  coalesce(latest.job_status in ('queued', 'running'), false) as preparing,
  coalesce(cur.id is not null and exists (
    select 1
    from public.study_course_sources cs
    cross join lateral (
      select v.id from public.study_source_versions v
      where v.source_id = cs.source_id
      order by v.version_no desc
      limit 1
    ) as newest
    where cs.course_id = c.id
      and not exists (select 1 from public.study_generation_sources gs
                      where gs.generation_id = cur.id and gs.source_version_id = newest.id)
  ), false) as update_available,
  (select count(*) from public.study_lessons l
   where l.generation_id = cur.id and l.status = 'validated')::int as lessons,
  (select count(*) from public.study_lessons l
   where l.generation_id = cur.id and l.status = 'validated'
     and exists (select 1 from public.study_progress_events e
                 where e.lesson_id = l.id and e.kind = 'lesson_read'))::int as lessons_read,
  (select count(*) from public.study_items i
   where i.generation_id = cur.id and i.status = 'validated')::int as questions,
  (select count(*) from public.study_claims cl
   where cl.generation_id = cur.id and cl.status = 'validated')::int as claims,
  (select count(*) from public.study_claims cl
   where cl.generation_id = cur.id and cl.status = 'validated'
     and cl.id in (select proven.claim_id from proven))::int as claims_demonstrated
from public.study_courses c
left join lateral (
  select g.* from public.study_generations g
  where g.id = public.study_course_generation(c.id)
) as cur on true
left join lateral (
  select g.id as generation_id, j.status as job_status
  from public.study_generations g
  join public.generation_jobs j on j.id = g.job_id
  where g.course_id = c.id
  order by g.created_at desc, g.id desc
  limit 1
) as latest on true;

revoke all on public.study_course_overview from public, anon, authenticated, service_role;
grant select on public.study_course_overview to authenticated;

/*
 * The current generation's lessons a learner may be shown, in course order -- unit, then
 * position -- with the reader's progress through each. A unit is its lessons' `unit_no`;
 * its title is the one its first lesson carries (a reader's correction of one lesson's
 * unit title does not rename the others).
 *
 * state: `read` (finished), `skipped`, `shown`, or `not_seen`. Progress belongs to the
 * version it was recorded against, so a corrected lesson starts again at `not_seen`.
 */
create function public.study_course_outline(p_course_id uuid)
returns table (
  generation_id   uuid,
  unit_no         smallint,
  unit_title      text,
  lesson_id       uuid,
  lesson_key      text,
  lesson_position smallint,
  title           text,
  objective       text,
  minutes         smallint,
  questions       int,
  state           text,
  first_shown_at  timestamptz,
  read_at         timestamptz
)
language sql
stable
set search_path = ''
as $fn$
  with lessons as (
    select l.*
    from public.study_lessons l
    where l.generation_id = public.study_course_generation(p_course_id)
      and l.status = 'validated'
  ),
  seen as (
    select e.lesson_id,
           min(e.occurred_at) filter (where e.kind = 'lesson_shown') as shown_at,
           min(e.occurred_at) filter (where e.kind = 'lesson_read') as read_at,
           bool_or(e.kind = 'lesson_skipped') as skipped
    from public.study_progress_events e
    where e.lesson_id in (select lessons.id from lessons)
    group by e.lesson_id
  )
  select l.generation_id,
         l.unit_no,
         first_value(l.unit_title) over (partition by l.unit_no order by l.position),
         l.id,
         l.lesson_key,
         l.position,
         l.title,
         l.objective,
         l.minutes,
         (select count(*) from public.study_items i
          where i.lesson_id = l.id and i.status = 'validated')::int,
         case when seen.read_at is not null then 'read'
              when seen.skipped then 'skipped'
              when seen.shown_at is not null then 'shown'
              else 'not_seen' end,
         seen.shown_at,
         seen.read_at
  from lessons l
  left join seen on seen.lesson_id = l.id
  order by l.unit_no, l.position
$fn$;

/*
 * The current generation's questions a learner may be shown, lesson by lesson in course
 * order and then course-level ones, with the reader's progress on each:
 *
 *   recall_demonstrated  an answer to it proves recall (`study_answer_proves_recall`, the
 *                        one definition of proof)
 *   answered             answered, but not in a way that proves recall
 *   shown                shown, not answered
 *   not_seen
 *
 * `due` is the scheduler's to decide (roadmap PR 9); nothing here marks a question due.
 */
create function public.study_course_questions(p_course_id uuid)
returns table (
  generation_id    uuid,
  item_id          uuid,
  lesson_id        uuid,
  item_key         text,
  purpose          text,
  kind             text,
  difficulty       smallint,
  authored_by      text,
  state            text,
  first_shown_at   timestamptz,
  last_answered_at timestamptz,
  demonstrated_at  timestamptz
)
language sql
stable
set search_path = ''
as $fn$
  with items as (
    select i.*
    from public.study_items i
    where i.generation_id = public.study_course_generation(p_course_id)
      and i.status = 'validated'
  ),
  shown as (
    select e.item_id, min(e.occurred_at) as shown_at
    from public.study_progress_events e
    where e.item_id in (select items.id from items) and e.kind = 'item_shown'
    group by e.item_id
  ),
  answered as (
    select a.item_id,
           max(a.answered_at) as last_answered_at,
           -- Only an answer that could prove recall is put to the rule: a CASE, so the
           -- cheap clauses decide first.
           min(case when a.correct and not a.hinted and a.grading = 'deterministic'
                    then case when public.study_answer_proves_recall(a.id)
                              then a.answered_at end end) as demonstrated_at
    from public.study_answer_events a
    where a.item_id in (select items.id from items)
    group by a.item_id
  )
  select i.generation_id,
         i.id,
         i.lesson_id,
         i.item_key,
         i.purpose,
         i.kind,
         i.difficulty,
         i.authored_by,
         case when answered.demonstrated_at is not null then 'recall_demonstrated'
              when answered.last_answered_at is not null then 'answered'
              when shown.shown_at is not null then 'shown'
              else 'not_seen' end,
         shown.shown_at,
         answered.last_answered_at,
         answered.demonstrated_at
  from items i
  left join public.study_lessons l on l.id = i.lesson_id
  left join shown on shown.item_id = i.id
  left join answered on answered.item_id = i.id
  order by l.unit_no nulls last, l.position nulls last,
           (substr(i.item_key, 2))::int
$fn$;

revoke all on function public.study_course_generation(uuid) from public, anon, authenticated;
revoke all on function public.study_course_outline(uuid) from public, anon, authenticated;
revoke all on function public.study_course_questions(uuid) from public, anon, authenticated;
grant execute on function public.study_course_generation(uuid) to authenticated;
grant execute on function public.study_course_outline(uuid) to authenticated;
grant execute on function public.study_course_questions(uuid) to authenticated;
