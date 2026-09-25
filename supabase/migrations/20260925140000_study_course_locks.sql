-- Study courses: lock order, after the first review.
--
-- 20260925120000 and 20260925130000 are pushed, so they are superseded here (law 6).
--
-- 20260925120000 claimed that every writer took rows in the order a source deletion does,
-- so none could deadlock with one. Two could, and both were reproduced with real sessions:
--
-- 1. A PROGRESS BATCH ACROSS TWO GENERATIONS. Each event key-shares its generation and
--    then its lesson or question, in the order the client sent them; a deletion takes the
--    generations in whatever order its cascade reaches them. An offline queue holding
--    events from before and after a regeneration, raced with a source or course deletion,
--    deadlocked in most runs. Deleting a source or a course now takes the same per-reader
--    lock a progress batch takes (`study_progress:<owner>`), before any cascade, so the
--    two serialise instead. It also serialises two deletions of one reader's sources,
--    which deadlocked on a generation built on both (a cycle since 20260925010000).
--
-- 2. A COURSE DELETED WHILE ITS LAST SOURCE IS. Foreign-key cascades run level by level:
--    a source deletion takes the source, its versions and its bundle rows, then -- through
--    the trigger -- the course; a course deletion takes the course, then its bundle rows.
--    Opposite orders. A course is now deleted through `delete_study_course`, which
--    key-shares the course's sources before it touches the course, as a regeneration does;
--    the direct DELETE grant and policy go.
--
-- 3. THE LAST SOURCE'S TRIGGER LOCKS THE COURSE. Two deletions of a course's last two
--    sources each saw the other's bundle row, and the course survived with none. The
--    trigger now takes the course row before it looks, so the second sees the first.
--
-- 4. A REGENERATION LOCKS BEFORE IT READS. It read the course, its goal and its sources'
--    newest versions before taking any lock, and lost races to deletions with a raw 23503.
--    It now takes the bundle's sources and the course first, then reads them.
--
-- 5. PROOF IN THE QUESTION LIST, SET-BASED. `study_course_questions` put every eligible
--    answer to `study_answer_proves_recall` one call at a time -- 690 ms for a course
--    answered a hundred times a question. It now applies the rule's clauses in one query,
--    as `study_proven_claims` does, and the suite holds the two to the same answers.

-- ------------------------------------------------------------------ 1. one lock per reader

/*
 * Before a reader's source or course is deleted, take the lock their progress batches
 * take. A batch holds it for its whole call and never touches sources or courses; a
 * deletion takes it before its cascade reaches any generation, lesson or question.
 */
create function public.study_hold_course_writes()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended('study_progress:' || old.owner_id::text, 0));
  return old;
end
$fn$;

revoke all on function public.study_hold_course_writes()
  from public, anon, authenticated, service_role;

create trigger study_sources_hold_course_writes before delete on public.study_sources
  for each row execute function public.study_hold_course_writes();
create trigger study_courses_hold_course_writes before delete on public.study_courses
  for each row execute function public.study_hold_course_writes();

-- ------------------------------------------------------------------ 2. deleting a course

drop policy study_courses_delete_own on public.study_courses;
revoke delete on public.study_courses from authenticated;

/*
 * Delete one of the reader's courses and everything prepared for it; its sources, and the
 * model output cached from them, stay. A job still preparing it is cancelled
 * (`study_generations_cancel_job`). The sources first, as a source deletion takes them.
 */
create function public.delete_study_course(p_course_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'deleting a course requires a signed-in reader' using errcode = '28000';
  end if;

  perform 1
  from public.study_sources s
  join public.study_course_sources cs on cs.source_id = s.id
  where cs.course_id = p_course_id and cs.owner_id = uid
  for key share of s;

  delete from public.study_courses c where c.id = p_course_id and c.owner_id = uid;
  if not found then
    raise exception 'no such course' using errcode = 'P0002';
  end if;
end
$fn$;

revoke all on function public.delete_study_course(uuid) from public, anon, authenticated;
grant execute on function public.delete_study_course(uuid) to authenticated;

-- ------------------------------------------------------------------ 3. the last source

/* As 20260925120000, taking the course row before looking for the bundle's other rows. */
create or replace function public.study_course_source_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform 1 from public.study_courses c where c.id = old.course_id for no key update;
  delete from public.study_courses c
  where c.id = old.course_id
    and not exists (select 1 from public.study_course_sources s where s.course_id = old.course_id);
  return null;
end
$fn$;

-- ------------------------------------------------------------------ 4. regeneration

/*
 * As 20260925130000. With a course, the versions and the goal are no longer arguments: the
 * bundle's sources and the course are locked first, and then the newest version of each
 * source and the course's goal are read under those locks.
 */
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
    raise exception 'a chosen source version is unavailable' using errcode = '42501';
  end if;
  if total > max_total_chars then
    raise exception 'the chosen sources total % characters; the limit is %', total, max_total_chars
      using errcode = '22023';
  end if;

  if v_course is not null then
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

/* As 20260925120000; the course's goal and versions are now read under its locks. */
create or replace function public.regenerate_study_course(
  p_course_id uuid,
  p_mutation_id uuid,
  p_processing_consent boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if (select auth.uid()) is null then
    raise exception 'study generation requires a signed-in reader' using errcode = '28000';
  end if;
  if p_course_id is null then
    raise exception 'no such course' using errcode = 'P0002';
  end if;
  return public.study_enqueue_course(
    null, null, p_mutation_id, p_processing_consent, p_course_id);
end
$fn$;

-- ------------------------------------------------------------------ 5. the question list

/* As 20260925130000, with proof decided in one query by the clauses of
   `study_answer_proves_recall`. */
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
    -- Validated now, by construction; and whether every claim under it is validated now.
    select i.*,
           not exists (select 1 from public.study_item_claims ic
                       join public.study_claims c on c.id = ic.claim_id
                       where ic.item_id = i.id and c.status <> 'validated') as claims_validated
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
    select a.item_id, max(a.answered_at) as last_answered_at
    from public.study_answer_events a
    where a.item_id in (select items.id from items)
    group by a.item_id
  ),
  -- The proof rule, set-based: a correct, unhinted, deterministically graded answer to a
  -- question the model wrote, validated when answered, validated now, on validated claims.
  demonstrated as (
    select a.item_id, min(a.answered_at) as demonstrated_at
    from items i
    join public.study_answer_events a on a.item_id = i.id
    cross join lateral (
      select l.to_status
      from public.study_status_log l
      where l.item_id = a.item_id and l.at <= a.answered_at
      order by l.at desc, l.id desc
      limit 1
    ) as then_status
    where i.authored_by = 'model'
      and i.claims_validated
      and a.correct
      and not a.hinted
      and a.grading = 'deterministic'
      and then_status.to_status = 'validated'
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
         case when demonstrated.demonstrated_at is not null then 'recall_demonstrated'
              when answered.last_answered_at is not null then 'answered'
              when shown.shown_at is not null then 'shown'
              else 'not_seen' end,
         shown.shown_at,
         answered.last_answered_at,
         demonstrated.demonstrated_at
  from items i
  left join public.study_lessons l on l.id = i.lesson_id
  left join shown on shown.item_id = i.id
  left join answered on answered.item_id = i.id
  left join demonstrated on demonstrated.item_id = i.id
  order by l.unit_no nulls last, l.position nulls last,
           (substr(i.item_key, 2))::int
$fn$;
