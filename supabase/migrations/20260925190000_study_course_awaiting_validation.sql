-- Study courses: a preparation whose validation is still to come, told apart from one that
-- failed.
--
-- 20260925120000 to 20260925180000 are pushed, so the overview is superseded here (law 6).
--
-- A preparation's job can end `failed` after its course was saved: the validation step ran
-- out of retries. The course is not lost -- `validate_stranded_study_courses` validates it
-- within minutes -- but the overview said only that the newest job failed, so a screen
-- told the reader their course could not be prepared, offered to prepare it again at a
-- cost, and stopped looking. The same gap hid a newer preparation of a course already being
-- read, finished and awaiting its validation, from a screen deciding whether to look again.
--
-- `awaiting_validation` is true when the newest generation is one the sweep will validate:
-- its job has ended, its text is still pending, and it has claims. It is the sweep's own
-- predicate, so the two cannot disagree about which courses are coming.

/* As 20260925180000, with `awaiting_validation` at the end. */
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
  coalesce(cur.id is not null and public.study_generation_rank(cur.id) < 2, false) as held_back,
  -- The sweep's own predicate (`validate_stranded_study_courses`), for the newest generation.
  coalesce(latest.job_status not in ('queued', 'running')
           and latest.text_status = 'pending'
           and exists (select 1 from public.study_claims cl
                       where cl.generation_id = latest.generation_id), false)
    as awaiting_validation
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
  select g.id as generation_id, j.status as job_status, g.text_status
  from public.study_generations g
  join public.generation_jobs j on j.id = g.job_id
  where g.course_id = c.id
  order by g.created_at desc, g.id desc
  limit 1
) as latest on true;
