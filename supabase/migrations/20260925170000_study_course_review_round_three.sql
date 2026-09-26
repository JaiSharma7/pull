-- Study courses, after the third review.
--
-- 20260925120000 to 20260925160000 are pushed, so they are superseded here (law 6).
--
-- 1. WHAT A READER DOES CANNOT CHANGE WHICH GENERATION IS CURRENT. 20260925150000 ranked a
--    generation by whether it has a lesson that can be shown today -- validated, or
--    suspended. A reader's own report or withdrawal moves that, so withdrawing every lesson
--    of the newest generation switched the course back to an older one built from a source
--    version the reader had replaced, hid the questions they kept, and left a regeneration
--    refused as unchanged. It now ranks by what was ever validated, which the status log
--    records and nothing updates: a generation with a lesson that was validated, then one
--    with such a question, then the newest finished. Validation's verdict, and the reader's
--    own corrections, still decide; a later report or withdrawal does not.
--
-- 2. THE OVERVIEW SAYS WHEN NOTHING PASSED. A current generation with no lesson and no
--    question to show was either held back by validation or emptied by the reader's own
--    reports and withdrawals, and a screen could not tell which. `held_back` is true for the
--    first: nothing in the current generation was ever validated.
--
-- 3. THE SIZE LIMIT SAYS SO. A regeneration uses the newest version of each source, so one
--    longer version can take a bundle over 200,000 characters while `update_available` is
--    true -- and the refusal was a bare 22023, which a client cannot tell from a malformed
--    request, nor check for itself without fetching every text. It now carries DETAIL
--    `too_large`, on the first preparation too.
--
-- 4. THE ACCOUNT ROW COMES FIRST. A regeneration key-shared the reader's sources and only
--    then, inserting its job, their `auth.users` row -- the opposite order to saving a
--    source, which locks the account row and then the source, and to deleting the account.
--    Review reproduced deadlocks with all three: 58 races in 60 against an administrator's
--    deletion, 25 in 60 against a save. Preparation now key-shares the account row before
--    it locks anything, and `delete_my_account` takes its own row before the reader's study
--    lock, so it serialises with an administrator deleting the same account rather than
--    deadlocking in 17 races of 40. The order is now the account row, then the reader's
--    study lock, then their study rows, on every path.

-- ------------------------------------------------------------------ 1. the current generation

/*
 * What was ever made showable in a generation: 2 with a lesson, 1 with a question and no
 * lesson, 0 with neither. "Made showable" is a status log row moving it to `validated` --
 * validation's verdict, or the reader's own correction, which is inserted validated. The
 * log is never updated (`study_status_log_is_final`), so a later report or withdrawal
 * leaves the rank where it was.
 */
create function public.study_generation_rank(p_generation_id uuid)
returns int
language sql
stable
set search_path = ''
as $fn$
  select case
    when exists (select 1 from public.study_lessons l
                 join public.study_status_log s on s.lesson_id = l.id
                 where l.generation_id = p_generation_id and s.to_status = 'validated')
      then 2
    when exists (select 1 from public.study_items i
                 join public.study_status_log s on s.item_id = i.id
                 where i.generation_id = p_generation_id and s.to_status = 'validated')
      then 1
    else 0
  end
$fn$;

revoke all on function public.study_generation_rank(uuid) from public, anon;
grant execute on function public.study_generation_rank(uuid) to authenticated, service_role;

/* As 20260925150000, ranked by what was ever validated rather than by status today. */
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
  order by public.study_generation_rank(g.id) desc, g.created_at desc, g.id desc
  limit 1
$fn$;

-- ------------------------------------------------------------------ 2. the overview

/* As 20260925130000, with `held_back` at the end. */
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
     and cl.id in (select proven.claim_id from proven))::int as claims_demonstrated_count,
  coalesce(public.study_generation_rank(cur.id) = 0, false) as held_back
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

-- ------------------------------------------------------------------ 3. the size limit

/* As 20260925150000, with DETAIL `too_large` on the size refusal, and the account row
   locked before anything else (4). */
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

-- ------------------------------------------------------------------ 4. account deletion

/* As 20260925160000, taking the account row before the reader's study lock. */
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  uid uuid := auth.uid();
  age int;
begin
  if uid is null then
    raise exception 'delete_my_account requires an authenticated user';
  end if;

  age := public.session_age_seconds();
  if age is null or age > 600 then
    raise exception
      'Deleting an account needs a recent sign-in. Request a new code, enter it, '
      'and try again.'
      using errcode = '28000';
  end if;

  -- The account row, then the reader's study lock, before any other row: deleting the jobs
  -- below cascades to every study generation, lesson and question, which a progress batch
  -- holding the lock may be waiting on (20260925160000), and an administrator deleting the
  -- same account takes the row first (20260925170000).
  perform 1 from auth.users u where u.id = uid for update;
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended('study_progress:' || uid::text, 0));

  delete from public.generation_jobs g where g.requester_id = uid;
  /*
   * Bounded to the reader's OWN material, which is what this migration widened it for.
   *
   * The first version was `not (status = 'published' and visibility = 'public')`,
   * matching the update policy's predicate -- and that reached further than intended.
   * `pipeline.ts` writes a canonical summary as `draft` + `public` with the requester
   * as author, and it becomes `published` only at the final step; so a canonical
   * generation sits in exactly that state for the whole run, and permanently for any
   * job that dies before publishing. One requester closing their account destroyed
   * shared catalogue content the project paid for and stranded its work. Verified:
   * the summary and its pulls were both gone.
   *
   * THE SECOND VERSION READ THE WORK'S CURRENT `rights_status`, AND THE READER CAN
   * MOVE THE SUMMARY. `summaries_author_update` constrains `author_id`, the
   * published+public pair, and `work_is_authorable(work_id)` -- which is true of every
   * catalogue work, because every catalogue work carries a published public summary.
   * `authenticated` holds column UPDATE on `work_id`, so one PATCH sets
   * `work_id = <any seeded work>, status = 'draft', visibility = 'public'` and neither
   * leg matches any more. Verified: the summary and its pulls survived
   * `delete_my_account` with the reader's `auth.users` row gone, leaving an ownerless
   * summary whose pulls hold a publisher's paragraphs -- the exact state described
   * above, reached by the one column the predicate did not look at.
   *
   * So it asks PROVENANCE instead, which the reader cannot move: `import_items` is
   * read-only through the API, `pulls` has no update policy, and the item names the
   * pull it created. A summary this reader imported into goes, wherever its work now
   * points and whatever they set its visibility to. A canonical draft has no
   * `import_items` behind it and stays.
   */
  --
  -- THE WORK IS A THIRD LEG, and it is a second line rather than the fix -- said that way
  -- because the mutation test says so. Round 7 found a summary surviving this call: the
  -- reader PATCHed an imported summary to `public`, then undid the batch, and provenance
  -- is only as durable as `import_items.pull_id`, which `undo_import` nulls by deleting
  -- the pull. Both other legs missed it and it outlived `auth.users` -- permanent,
  -- unreachable and uncollectable.
  --
  -- The fix for that is in `undo_import`, which now collects the summary whatever its
  -- visibility, so by the time this runs there is nothing left to catch: reverting this
  -- leg alone leaves `imports.sql` green, and reverting the Undo alone does not. It is
  -- kept because `rights_status = 'user_owned'` is a fact about the BOOK rather than
  -- about the reader's rows, so no Undo can move it -- which is what makes it worth
  -- having against a future change to the Undo. It is also exactly the right boundary:
  -- an imported summary always sits on a `user_owned` work, and a canonical generation
  -- -- draft-and-public with the requester as author for the whole of its run -- never
  -- does, so the catalogue content the project paid for is still left alone.
  delete from public.summaries s
   where s.author_id = uid
     and (
       s.visibility <> 'public'
       or exists (
         select 1 from public.works w
          where w.id = s.work_id and w.rights_status = 'user_owned'
       )
       or exists (
         select 1
           from public.import_items ii
           join public.pulls p on p.id = ii.pull_id
          where ii.user_id = uid and p.summary_id = s.id
       )
     );

  delete from auth.users u where u.id = uid;
end;$function$;
