-- Study validation and correction: the stranded sweep and the proven-claims query, after
-- the database's second review.
--
-- 20260925050000 to 20260925080000 are pushed, so they are superseded here (law 6).
--
-- 1. THE SWEEP NEVER WAITS. It validated up to twenty courses in one transaction, holding
--    each course's row until the batch committed -- so with two of one reader's courses in
--    the batch, `delete_my_account` (which deletes the courses in whatever order its
--    cascade reaches them) and the sweep could each hold one and wait for the other:
--    40P01, and the account deletion was the one aborted. Each course's row is now taken
--    NOWAIT inside the course's own exception block, so a course something else holds is
--    skipped and tried next run, and the sweep never waits while holding anything. Five a
--    run, not twenty, so a reader correcting an already-swept course waits less.
--
-- 2. THE SWEEP READS ONLY WHAT MAY BE STRANDED. Every finished course was checked for
--    drafts every five minutes, which grows with every course ever made. A course's own
--    text is decided in the same transaction that moves its drafts, so `text_status =
--    'pending'` alone marks one validation has not finished -- and a partial index keeps
--    that set small however long the history.
--
-- 3. PROVEN CLAIMS IN ONE QUERY. `study_proven_claims` called the proof rule once per
--    answer, which cannot be inlined; ten thousand answers took over a second. It is now
--    one set-based query, and `study_validation.sql` asserts it agrees with
--    `study_answer_proves_recall` event by event, so the rule still has one definition
--    that the query is held to.

create index study_generations_pending_idx on public.study_generations (created_at)
  where text_status = 'pending';

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
      and g.created_at < now() - p_older_than
      and j.status not in ('queued', 'running')
      and exists (select 1 from public.study_claims c where c.generation_id = g.id)
    order by g.created_at
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

revoke all on function public.validate_stranded_study_courses(interval, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.validate_stranded_study_courses(interval, integer) to postgres;

comment on function public.enable_generation_sweeper(text) is
  'Schedules the stranded-job sweep and, since 20260925070000, the stranded study-course validation. Separate from the migration so a from-zero replay never depends on pg_cron running, and idempotent because cron.schedule upserts by job name.';

/*
 * The claims a reader has proven, and when last: `study_answer_proves_recall`, set-based.
 * Every clause of the rule is here once, in the same order; the test suite checks the two
 * agree on every answer it records.
 */
create or replace function public.study_proven_claims()
returns table (claim_id uuid, proven_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select ic.claim_id, max(e.answered_at)
  from public.study_answer_events e
  join public.study_items i
    on i.id = e.item_id and i.status = 'validated' and i.authored_by = 'model'
  join public.study_item_claims ic on ic.item_id = e.item_id
  cross join lateral (
    select l.to_status
    from public.study_status_log l
    where l.item_id = e.item_id and l.at <= e.answered_at
    order by l.at desc, l.id desc
    limit 1
  ) as then_status
  where e.correct
    and not e.hinted
    and e.grading = 'deterministic'
    and then_status.to_status = 'validated'
    and not exists (select 1 from public.study_item_claims ic2
                    join public.study_claims c on c.id = ic2.claim_id
                    where ic2.item_id = e.item_id and c.status <> 'validated')
  group by ic.claim_id
$fn$;
