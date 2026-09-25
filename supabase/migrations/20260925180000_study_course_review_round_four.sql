-- Study courses, after the fourth review.
--
-- 20260925120000 to 20260925170000 are pushed, so they are superseded here (law 6).
--
-- 1. ACCOUNT DELETION KEY-SHARES WITH THE WORKER. 20260925170000 made `delete_my_account`
--    take the reader's account row FOR UPDATE before anything else. The worker locks a
--    job row and then key-shares the account row as it writes (`record_study_stage`'s
--    stage cache, `attach_generated_summary`'s summary), and the deletion, holding the
--    row, then waited on that job row: deadlocks in 19 races of 60 and 18 of 40. It now
--    takes the row FOR NO KEY UPDATE, which still waits for an administrator's deletion
--    and a source save -- both take FOR UPDATE -- but not for a foreign key's key-share.
--
-- 2. `held_back` read true for a course with no current generation -- a first preparation
--    still queued, one that failed, one whose sources' deletion took every generation --
--    because the rank of no generation is 0. And it meant "nothing was ever validated", so
--    a generation whose lessons validation held back but which kept a course-level question
--    read the same as one whose lessons the reader withdrew. It now means what
--    `newer_generation_held_back` means for the newest generation: there is a current
--    generation, and validation passed no lesson in it.

-- ------------------------------------------------------------------ 2. held back

/* As 20260925170000, with `held_back` true only for a current generation that validation
   passed no lesson in. */
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
  coalesce(cur.id is not null and public.study_generation_rank(cur.id) < 2, false) as held_back
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

-- ------------------------------------------------------------------ 1. account deletion

/* As 20260925170000, taking the account row FOR NO KEY UPDATE. */
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
  -- same account takes the row first (20260925170000). FOR NO KEY UPDATE, not FOR UPDATE:
  -- it must wait for a deletion or a source save, but not for a foreign key's key-share --
  -- the worker locks a job row and then key-shares this one as it writes, and a FOR UPDATE
  -- here, held while the jobs are deleted, deadlocked with it (20260925180000).
  perform 1 from auth.users u where u.id = uid for no key update;
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
