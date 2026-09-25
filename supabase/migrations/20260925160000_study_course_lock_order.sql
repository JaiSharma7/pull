-- Study courses: lock order, after the second review.
--
-- 20260925140000 made a deletion of a reader's source or course take their progress lock
-- (`study_progress:<owner>`) from a row trigger, so it serialised with a progress batch.
-- Review reproduced two orders it left, both with real sessions:
--
-- 1. ACCOUNT DELETION DEADLOCKED WITH A BATCH, in 39 runs of 40. `delete_my_account` deletes
--    the reader's `generation_jobs` first, which cascades to every study generation, lesson
--    and question without the lock; only later does the `auth.users` cascade reach
--    `study_sources`, where the trigger waited for the lock a batch held -- while the batch
--    waited on a generation the deletion had taken. Before 20260925140000 the deletion
--    never waited on that lock, so this was a regression of that fix. It now takes the lock
--    before its first delete.
--
-- 2. A ROW TRIGGER FIRES AFTER ITS ROW IS LOCKED. So a DELETE of several of a reader's
--    sources took the lock after its first row and before the rest, while a DELETE of one
--    source, and `delete_study_course`, took a source row and then the lock: opposite
--    orders, and a deadlock between two deletions -- or between deleting an account and
--    deleting one of its sources. Every path now takes the lock before any row:
--
--    - a reader's own DELETE on `study_sources`, from a statement-level trigger that takes
--      the lock of the reader making it, before the statement locks anything;
--    - `delete_study_course`, before it key-shares the course's sources;
--    - `delete_my_account`, before its first delete (1);
--    - a deletion of the `auth.users` row by anyone else -- the dashboard, the admin API --
--      from a trigger on that row, which a batch or a reader's deletion never waits for.
--
--    The row triggers stay: under any of these they find the lock already held, and they
--    still cover a deletion that reaches a reader's sources some other way.

-- ------------------------------------------------------------------ 1. account deletion

/* As 20260905110000, with the reader's study lock taken before the first delete. */
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

  -- The reader's study lock first, before any row: deleting the jobs below cascades to every
  -- study generation, lesson and question, which a progress batch holding this lock may be
  -- waiting on. Taken later -- when the cascade reached study_sources -- it deadlocked with
  -- the batch (20260925160000).
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

-- ------------------------------------------------------------------ 2. a reader's deletions

/*
 * Before a reader's own DELETE on their sources locks any row, take the lock their progress
 * batches take. RLS confines the statement to the reader's rows, so their id names the one
 * lock it needs. Without a reader -- a service-role deletion -- the row trigger takes it.
 */
create function public.study_hold_reader_deletes()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  uid uuid := (select auth.uid());
begin
  if uid is not null then
    perform pg_advisory_xact_lock(
      pg_catalog.hashtextextended('study_progress:' || uid::text, 0));
  end if;
  return null;
end
$fn$;

revoke all on function public.study_hold_reader_deletes()
  from public, anon, authenticated, service_role;

create trigger study_sources_hold_reader_deletes before delete on public.study_sources
  for each statement execute function public.study_hold_reader_deletes();

/* As 20260925140000, with the reader's lock taken before the course's sources. */
create or replace function public.delete_study_course(p_course_id uuid)
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

  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended('study_progress:' || uid::text, 0));

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

-- ------------------------------------------------------------------ 3. anyone else's deletion

/*
 * An account deleted from outside the app -- the dashboard, the admin API -- takes its
 * study lock once its `auth.users` row is locked and before any cascade: a progress batch
 * or a reader's deletion holding the lock never waits on that row. Only for an account with
 * study sources, since only those have progress to serialise with, so deleting many guest
 * accounts at once does not take a lock each. A definer, so the auth service can look.
 */
create function public.study_hold_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if exists (select 1 from public.study_sources s where s.owner_id = old.id) then
    perform pg_advisory_xact_lock(
      pg_catalog.hashtextextended('study_progress:' || old.id::text, 0));
  end if;
  return old;
end
$fn$;

revoke all on function public.study_hold_account_deletion()
  from public, anon, authenticated, service_role;

create trigger study_hold_account_deletion before delete on auth.users
  for each row execute function public.study_hold_account_deletion();
