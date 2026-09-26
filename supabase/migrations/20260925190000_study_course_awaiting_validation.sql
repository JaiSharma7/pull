-- Study courses: a preparation whose validation is still to come, told apart from one that
-- failed.
--
-- 20260925120000 to 20260925180000 are pushed, so what changes is superseded here (law 6).
--
-- A preparation's job can end `failed` after its course was saved: the validation step ran
-- out of retries. The course is not lost -- `validate_stranded_study_courses` takes it up
-- once it is ten minutes old, five a run -- but the overview said only that the newest job
-- failed, so a screen told the reader their course could not be prepared, offered to
-- prepare it again, and stopped looking; and the database accepted that request, for a
-- duplicate of the course the sweep was about to finish.
--
-- 1. `study_generation_awaiting_validation(generation)`: its job has ended, its course is
--    saved (`assembled_at`, which the sweep keys on too) and its text is still pending --
--    for a day. A generation validation keeps refusing is retried by the sweep without
--    end; after a day it stops standing in the reader's way.
-- 2. The overview says it (`awaiting_validation`, for the newest generation), and judges
--    `update_available` against the newest generation finished or awaiting, so a newer
--    version on its way is not offered again.
-- 3. `study_enqueue_course` refuses to prepare a course again while one awaits, with DETAIL
--    `preparing`, as it does while one is queued or running.
-- 4. The sweep takes courses awaiting within their day first. It retries without end, oldest
--    first, five a run, so five courses validation always refuses -- anywhere -- took every
--    run, and every other course waited out its day and was offered as failed.
-- 5. `latest_settled` says the newest generation was saved and validation settled it, so a
--    screen does not call it both failed and held back.

create function public.study_generation_awaiting_validation(p_generation_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select coalesce((
    select j.status not in ('queued', 'running')
           and g.text_status = 'pending'
           and g.assembled_at is not null
           and g.created_at > now() - interval '1 day'
    from public.study_generations g
    join public.generation_jobs j on j.id = g.job_id
    where g.id = p_generation_id
  ), false)
$fn$;

revoke all on function public.study_generation_awaiting_validation(uuid) from public, anon;
grant execute on function public.study_generation_awaiting_validation(uuid)
  to authenticated, service_role;

-- ------------------------------------------------------------------ 2. the overview

/* As 20260925180000, with `awaiting_validation` at the end and `update_available` judged
   against the newest generation finished or awaiting. */
create or replace view public.study_course_overview with (security_invoker = true) as
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
  coalesce(saved.id is not null and exists (
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
                      where gs.generation_id = saved.id
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
     and cl.id in (select proven.claim_id from proven))::int as claims_demonstrated_count,
  coalesce(cur.id is not null and public.study_generation_rank(cur.id) < 2, false) as held_back,
  public.study_generation_awaiting_validation(latest.generation_id) as awaiting_validation,
  -- The newest generation is saved and validation has settled it: whatever its job's
  -- status, it was not lost, and `newer_generation_held_back` or the current generation say
  -- what became of it.
  coalesce(latest.assembled_at is not null and latest.text_status <> 'pending', false)
    as latest_settled
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
-- The newest generation that is finished or coming: a new version is judged against what
-- the reader has, or is about to have, not only against what validation has settled.
left join lateral (
  select g.id from public.study_generations g
  where g.course_id = c.id and g.assembled_at is not null
    and (g.text_status <> 'pending' or public.study_generation_awaiting_validation(g.id))
  order by g.created_at desc, g.id desc
  limit 1
) as saved on true
left join lateral (
  select g.id as generation_id, j.status as job_status, g.assembled_at, g.text_status
  from public.study_generations g
  join public.generation_jobs j on j.id = g.job_id
  where g.course_id = c.id
  order by g.created_at desc, g.id desc
  limit 1
) as latest on true;

-- ------------------------------------------------------------------ 4. the sweep

/* As 20260925100000, taking the courses awaiting within their day first. */
create or replace function public.validate_stranded_study_courses(
  p_older_than interval default interval '10 minutes',
  p_limit integer default 5
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  stranded uuid;
  done     integer := 0;
begin
  for stranded in
    select g.job_id
    from public.study_generations g
    join public.generation_jobs j on j.id = g.job_id
    where g.text_status = 'pending'
      and g.assembled_at is not null
      and g.created_at < now() - p_older_than
      and j.status not in ('queued', 'running')
    order by (g.created_at > now() - interval '1 day') desc, g.created_at
    limit greatest(coalesce(p_limit, 5), 0)
  loop
    begin
      -- Taken without waiting: a course a deletion, a correction or the worker holds is
      -- left for the next run rather than waited on while this run holds the ones before.
      perform 1 from public.study_generations g where g.job_id = stranded for update nowait;
      perform public.validate_study_course(stranded);
      done := done + 1;
    exception when others then
      raise warning 'validate_stranded_study_courses: % skipped: %', stranded, sqlerrm;
    end;
  end loop;
  return done;
end
$fn$;

-- ------------------------------------------------------------------ 3. preparing again

/* As 20260925170000, refusing while a generation awaits its validation. */
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
  v_versions uuid[] := p_source_version_ids;
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
  -- The account row before anything else is locked: saving a source and deleting the
  -- account both take it before the reader's sources, which a regeneration key-shares
  -- below. Taken after them, it deadlocked with either. It is also the guest check.
  perform 1 from auth.users u where u.id = uid and u.is_anonymous is not true for key share;
  if not found then
    raise exception 'study generation needs an account, not a guest session'
      using errcode = '28000';
  end if;
  if not exists (select 1 from public.study_generation_access a where a.user_id = uid) then
    raise exception 'study generation is in a limited beta and is not open to this account yet'
      using errcode = '42501', detail = 'beta';
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

  if v_course is not null then
    -- The bundle's sources first, then the course: a source deletion takes the source
    -- before anything built on it. Only then are the course's goal and versions read.
    perform 1
    from public.study_sources s
    join public.study_course_sources cs on cs.source_id = s.id
    where cs.course_id = v_course and cs.owner_id = uid
    for key share of s;
    select c.goal into v_goal
    from public.study_courses c
    where c.id = v_course and c.owner_id = uid
    for key share;
    if not found then
      raise exception 'no such course' using errcode = 'P0002';
    end if;
    select array_agg(newest.id order by cs.position) into v_versions
    from public.study_course_sources cs
    cross join lateral (
      select v.id from public.study_source_versions v
      where v.source_id = cs.source_id and v.owner_id = uid
      order by v.version_no desc
      limit 1
    ) as newest
    where cs.course_id = v_course and cs.owner_id = uid;
  end if;

  if char_length(v_goal) not between 1 and 300 then
    raise exception 'the study goal must be 1 to 300 characters' using errcode = '22023';
  end if;

  select count(distinct v) into wanted
  from unnest(coalesce(v_versions, '{}'::uuid[])) as v
  where v is not null;
  if wanted < 1 or wanted > max_sources
     or wanted <> cardinality(coalesce(v_versions, '{}'::uuid[])) then
    raise exception 'choose one to % different source versions', max_sources
      using errcode = '22023';
  end if;

  select count(*), coalesce(sum(char_length(v.extracted_text)), 0) into owned, total
  from public.study_source_versions v
  where v.id = any (v_versions) and v.owner_id = uid;
  if owned <> wanted then
    raise exception 'a chosen source version is unavailable'
      using errcode = '42501', detail = 'unavailable';
  end if;
  if total > max_total_chars then
    raise exception 'the chosen sources total % characters; the limit is %', total, max_total_chars
      using errcode = '22023', detail = 'too_large';
  end if;

  if v_course is not null then
    -- On its way is a job queued or running, or a course saved and awaiting its validation:
    -- preparing again then would buy a duplicate of what the sweep is about to finish.
    if exists (select 1 from public.study_generations g
               join public.generation_jobs j on j.id = g.job_id
               where g.course_id = v_course
                 and (j.status in ('queued', 'running')
                      or public.study_generation_awaiting_validation(g.id))) then
      raise exception 'this course is already being prepared'
        using errcode = '55000', detail = 'preparing';
    end if;
    if exists (
      select 1 from public.study_generations g
      where g.course_id = v_course and g.assembled_at is not null and g.text_status <> 'pending'
        and (select array_agg(gs.source_version_id order by gs.source_version_id)
             from public.study_generation_sources gs where gs.generation_id = g.id)
            = (select array_agg(x order by x) from unnest(v_versions) as x)
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
      from unnest(v_versions) with ordinality as x(id, ord)
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
  from unnest(v_versions) with ordinality as v(id, ord);

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

