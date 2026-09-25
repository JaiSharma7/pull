-- Study courses, after the first review.
--
-- 20260925120000 is pushed, so it is superseded here (law 6).
--
-- 1. A HELD-BACK GENERATION DOES NOT REPLACE A GOOD ONE. The current generation was the
--    newest whose validation had finished, even when validation had held back every lesson
--    and question in it -- so one bad regeneration replaced a course the reader was
--    studying with an empty one, and a regeneration of the same versions was refused as
--    unchanged. The current generation is now the newest finished one with something a
--    learner may be shown (a validated or suspended lesson or question); only when none
--    has, the newest finished. `newer_generation_held_back` says when a newer one exists
--    that is not current, and `update_available` is judged against the newest finished
--    generation, so it never offers a regeneration that would be refused as unchanged.
--
-- 2. A READER'S CORRECTION KEEPS THEIR PLACE. Progress was per version, so correcting a
--    typo in a lesson the reader had read put it back to `not_seen`. The reader wrote the
--    correction. Exposure -- shown, read, skipped -- is now read across every version of a
--    lesson or question within the generation (its `lineage_id`). Answers and proof stay
--    with the version answered: a reader's version is practice, and a model's question
--    proves nothing about another.
--
-- 3. A CORRECTED UNIT TITLE RETITLES THE UNIT. The outline took a unit's title from its
--    first lesson, so a correction on any other lesson showed nowhere. It now takes the
--    title of the lesson whose unit title was most recently changed by a correction --
--    not merely the newest version, which may have corrected something else -- and the
--    first lesson's when none was.
--
-- 4. REFUSALS SAY WHICH. Both 55000 refusals of a regeneration carry a DETAIL, `preparing`
--    or `unchanged`. A replay of a mutation id made for another course is refused rather
--    than answered with that course's job. A refused progress event names its client event
--    id whenever it parsed, and `occurredAt` may be an ISO-8601 string or epoch
--    milliseconds.
--
-- 5. COUNTS ARE NAMED AS COUNTS. `study_course_overview` and `study_course_outline` rename
--    their counts (`lesson_count`, `question_count`, ...) while nothing reads them, and the
--    overview adds the validated course's `disagreements` and `withheld`.

-- ------------------------------------------------------------------ 1. the current generation

/* As 20260925120000, preferring a generation with something a learner may be shown. */
create or replace function public.study_course_generation(p_course_id uuid)
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
  order by (exists (select 1 from public.study_lessons l
                    where l.generation_id = g.id and l.status in ('validated', 'suspended'))
            or exists (select 1 from public.study_items i
                       where i.generation_id = g.id and i.status in ('validated', 'suspended')))
           desc,
           g.created_at desc, g.id desc
  limit 1
$fn$;

-- ------------------------------------------------------------------ 2, 3, 5. the read path

drop view public.study_course_overview;

/* As 20260925120000, with counts named as counts, the course's disagreements and withheld
   questions, exposure read across a lesson's versions, and the newest finished generation
   beside the current one. */
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
  case when cur.text_status = 'validated' then cur.disagreements else '[]'::jsonb end
    as disagreements,
  case when cur.text_status = 'validated' then cur.withheld else '[]'::jsonb end as withheld,
  latest.generation_id as latest_generation_id,
  latest.job_status as latest_job_status,
  coalesce(latest.job_status in ('queued', 'running'), false) as preparing,
  coalesce(newest.id is not null and newest.id is distinct from cur.id, false)
    as newer_generation_held_back,
  coalesce(newest.id is not null and exists (
    select 1
    from public.study_course_sources cs
    cross join lateral (
      select v.id from public.study_source_versions v
      where v.source_id = cs.source_id
      order by v.version_no desc
      limit 1
    ) as newest_version
    where cs.course_id = c.id
      and not exists (select 1 from public.study_generation_sources gs
                      where gs.generation_id = newest.id
                        and gs.source_version_id = newest_version.id)
  ), false) as update_available,
  (select count(*) from public.study_lessons l
   where l.generation_id = cur.id and l.status = 'validated')::int as lesson_count,
  (select count(*) from public.study_lessons l
   where l.generation_id = cur.id and l.status = 'validated'
     and exists (select 1 from public.study_lessons v
                 join public.study_progress_events e on e.lesson_id = v.id
                 where v.lineage_id = l.lineage_id and e.kind = 'lesson_read'))::int
    as lessons_read_count,
  (select count(*) from public.study_items i
   where i.generation_id = cur.id and i.status = 'validated')::int as question_count,
  (select count(*) from public.study_claims cl
   where cl.generation_id = cur.id and cl.status = 'validated')::int as claim_count,
  (select count(*) from public.study_claims cl
   where cl.generation_id = cur.id and cl.status = 'validated'
     and cl.id in (select proven.claim_id from proven))::int as claims_demonstrated_count
from public.study_courses c
left join lateral (
  select g.* from public.study_generations g
  where g.id = public.study_course_generation(c.id)
) as cur on true
left join lateral (
  select g.id from public.study_generations g
  where g.course_id = c.id and g.assembled_at is not null and g.text_status <> 'pending'
  order by g.created_at desc, g.id desc
  limit 1
) as newest on true
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

drop function public.study_course_outline(uuid);

/* As 20260925120000, with `question_count`, exposure read across a lesson's versions, and
   the unit titled by its most recent unit-title correction. */
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
  question_count  int,
  state           text,
  first_shown_at  timestamptz,
  read_at         timestamptz
)
language sql
stable
set search_path = ''
as $fn$
  with lessons as (
    select l.*,
           -- When this lesson's unit title was last changed by a correction, if ever.
           (select max(v.created_at)
            from public.study_lessons v
            join public.study_lessons p on p.id = v.supersedes_id
            where v.lineage_id = l.lineage_id and v.unit_title is distinct from p.unit_title)
             as titled_at
    from public.study_lessons l
    where l.generation_id = public.study_course_generation(p_course_id)
      and l.status = 'validated'
  ),
  seen as (
    select l.id as lesson_id,
           min(e.occurred_at) filter (where e.kind = 'lesson_shown') as shown_at,
           min(e.occurred_at) filter (where e.kind = 'lesson_read') as read_at,
           bool_or(e.kind = 'lesson_skipped') as skipped
    from lessons l
    join public.study_lessons v on v.lineage_id = l.lineage_id
    join public.study_progress_events e on e.lesson_id = v.id
    group by l.id
  )
  select l.generation_id,
         l.unit_no,
         first_value(l.unit_title)
           over (partition by l.unit_no order by l.titled_at desc nulls last, l.position),
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

revoke all on function public.study_course_outline(uuid) from public, anon, authenticated;
grant execute on function public.study_course_outline(uuid) to authenticated;

/* As 20260925120000, with `shown` read across a question's versions. Answers and proof stay
   with the version answered. */
create or replace function public.study_course_questions(p_course_id uuid)
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
    select i.id as item_id, min(e.occurred_at) as shown_at
    from items i
    join public.study_items v on v.lineage_id = i.lineage_id
    join public.study_progress_events e on e.item_id = v.id and e.kind = 'item_shown'
    group by i.id
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

-- ------------------------------------------------------------------ 4. refusals

/* As 20260925120000, with a DETAIL on each 55000 and a replay held to its course. */
create or replace function public.study_enqueue_course(
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
  v_replayed_course uuid;
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
    select g.course_id into v_replayed_course
    from public.study_generations g where g.job_id = replayed.id;
    -- A regeneration's replay answers only for its own course; a generation since deleted
    -- has no course to compare, and its replay still answers.
    if p_course_id is not null and v_replayed_course is not null
       and v_replayed_course <> p_course_id then
      raise exception 'that mutation id belongs to a different request' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'jobId', replayed.id,
      'generationId', replayed.target ->> 'generationId',
      'courseId', v_replayed_course,
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
      raise exception 'this course is already being prepared'
        using errcode = '55000', detail = 'preparing';
    end if;
    if exists (
      select 1 from public.study_generations g
      where g.course_id = v_course and g.assembled_at is not null and g.text_status <> 'pending'
        and (select array_agg(gs.source_version_id order by gs.source_version_id)
             from public.study_generation_sources gs where gs.generation_id = g.id)
            = (select array_agg(x order by x) from unnest(p_source_version_ids) as x)
    ) then
      raise exception 'nothing in this course''s sources has changed since it was last prepared'
        using errcode = '55000', detail = 'unchanged';
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

/* As 20260925120000, naming a refused event's client id whenever it parsed, and taking
   `occurredAt` as an ISO-8601 string or epoch milliseconds. */
create or replace function public.record_study_progress(p_events jsonb)
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
    v_gen := null;
    if jsonb_typeof(ev) is distinct from 'object' then
      refused := refused || jsonb_build_object('index', ord - 1, 'reason', 'malformed');
      continue;
    end if;
    -- The client id on its own, so a refusal can name it even when another field is bad.
    begin
      v_client := (ev ->> 'clientEventId')::uuid;
    exception when data_exception then
      v_client := null;
    end;
    begin
      v_kind := ev ->> 'kind';
      v_target := case when v_kind like 'lesson\_%' then (ev ->> 'lessonId')::uuid
                       when v_kind like 'item\_%' then (ev ->> 'itemId')::uuid end;
      v_at := case jsonb_typeof(ev -> 'occurredAt')
                when 'number' then to_timestamp((ev ->> 'occurredAt')::numeric / 1000)
                when 'string' then (ev ->> 'occurredAt')::timestamptz
                else now() end;
    exception when data_exception then
      refused := refused || jsonb_strip_nulls(jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'malformed'));
      continue;
    end;
    if v_client is null or v_target is null or v_at is null
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
  end loop;

  return jsonb_build_object('recorded', recorded, 'duplicates', duplicates, 'refused', refused);
end
$fn$;
