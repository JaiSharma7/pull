-- Study courses: a course awaiting its validation is counted from when it was saved, and the
-- sweep takes turns.
--
-- 20260925190000 is pushed, so what changes is superseded here (law 6).
--
-- 1. `study_generation_awaiting_validation` counted its day from the generation's row, which
--    is written when the preparation is queued. The worker lets a step wait on the budget a
--    day at a time, so a course can be saved more than a day after that; when its validation
--    then ran out of retries, it read as failed at once, was offered again, and the database
--    accepted a paid duplicate of the course the sweep was about to finish -- the case
--    20260925190000 exists for. The day now starts when the course was saved
--    (`assembled_at`), in the sweep's order as in the predicate.
-- 2. Within the day the sweep still took the oldest first, and a refused attempt, rolled back
--    to its savepoint, left no trace: five courses validation kept refusing took every run
--    until their day ran out, and a sound one behind them could wait out its own. Each
--    attempt is now stamped (`validation_tried_at`) before the part a refusal undoes, and the
--    sweep takes the least recently tried first.

alter table public.study_generations add column validation_tried_at timestamptz;

comment on column public.study_generations.validation_tried_at is
  'When validate_stranded_study_courses last tried this generation. It takes the least '
  'recently tried first, so courses validation keeps refusing do not take every run.';

-- ------------------------------------------------------------------ 1. from saving

/* As 20260925190000, with the day counted from `assembled_at`. */
create or replace function public.study_generation_awaiting_validation(p_generation_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select coalesce((
    select j.status not in ('queued', 'running')
           and g.text_status = 'pending'
           and g.assembled_at is not null
           and g.assembled_at > now() - interval '1 day'
    from public.study_generations g
    join public.generation_jobs j on j.id = g.job_id
    where g.id = p_generation_id
  ), false)
$fn$;

-- ------------------------------------------------------------------ 2. taking turns

/* As 20260925190000, stamping each attempt and taking the least recently tried first. */
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
    order by (g.assembled_at > now() - interval '1 day') desc,
             g.validation_tried_at nulls first,
             g.assembled_at
    limit greatest(coalesce(p_limit, 5), 0)
  loop
    -- Stamped outside the block below, so a refusal does not undo it and the next run takes
    -- others first. Without waiting, as the attempt is: a row someone holds is skipped here
    -- and refused below, and left for the next run.
    update public.study_generations g set validation_tried_at = now()
    where g.id = (select g2.id from public.study_generations g2
                  where g2.job_id = stranded
                  for no key update skip locked);
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
