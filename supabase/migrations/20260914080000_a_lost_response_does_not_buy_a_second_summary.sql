/*
 * Two corrections from the ninth review round, both about paying twice.
 *
 * 1. A SUBMIT WHOSE RESPONSE WAS LOST BOUGHT A SECOND GENERATION.
 *    `enqueue_generation_job` inserted a fresh row on every call, so a request that
 *    reached Postgres and committed but whose answer never arrived left the Studio
 *    saying "that has not reached your account" to a reader who then pressed again --
 *    and the second press is ~5.6 cents of real provider spend against the day's cap,
 *    plus a second summary of one book on their own shelf. Every other replayable write
 *    in this schema carries a client-minted mutation id for exactly this
 *    (`explanations`, `convictions`, the recall grades); the one that spends money did
 *    not. It does now, and a replay is answered before the quota, the cap or the insert.
 *
 * 2. THE VERSION LOCK WAS ANCHORED ON A ROW THAT MOVES.
 *    20260914060000 took `for update` on `select ... order by s.id limit 1` over the
 *    reader's summaries for a work, to serialise two generations of one book. Postgres
 *    re-checks the WHERE clause after such a lock unblocks but does NOT re-run
 *    ORDER BY/LIMIT, and `summaries.id` is a random uuid -- so once a job inserts a row
 *    that sorts below the import's, two jobs can hold two different rows, both read the
 *    same `max(version)`, and the second insert dies on the unique constraint the lock
 *    was there to avoid. An advisory lock keyed on `(work, author)` names the thing the
 *    version is actually scoped to and cannot be moved by an insert.
 */

-- ---------------------------------------------------------- 1. replay safety
alter table public.generation_jobs
  add column if not exists client_mutation_id uuid;

comment on column public.generation_jobs.client_mutation_id is
  'Client-minted, once per submission. Lets a retry after a lost response return the job it is replaying instead of buying a second generation.';

-- Unique only where present: every job written before this migration has none, and a
-- caller that sends no id keeps the old behaviour of one row per call.
create unique index if not exists generation_jobs_client_mutation_key
  on public.generation_jobs (requester_id, client_mutation_id)
  where client_mutation_id is not null;

create or replace function public.enqueue_generation_job(
  p_target jsonb,
  p_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  daily_fast_limit   constant int := 3;
  daily_hard_ceiling constant int := 50;
  stagger_seconds    constant int := 300;
  max_text_length    constant int := 200000;
  max_title_length   constant int := 200;
  -- What one job will reserve before it can do anything: synthesize plus embed.
  min_job_cents      constant numeric := 7;

  uid        uuid := (select auth.uid());
  used       int;
  over       boolean;
  job_id     uuid;
  delay_for  int;
  job_kind   text;
  target     jsonb := coalesce(p_target, '{}'::jsonb);
  work_ref   text;
  spent      numeric;
  cap        numeric := public.daily_spend_cap_cents();
  replayed   public.generation_jobs%rowtype;
begin
  if uid is null then
    raise exception 'enqueue_generation_job requires an authenticated user';
  end if;

  if not exists (
    select 1 from auth.users u where u.id = uid and u.is_anonymous is not true
  ) then
    raise exception
      'Generating a summary needs an account. Sign in with an email address and try again.'
      using errcode = '28000';
  end if;

  /*
   * A REPLAY, answered before anything is spent or counted.
   *
   * Every other write in this app that can be retried carries a mutation id for this --
   * `explanations`, `convictions`, the recall grades -- and the one that spends money
   * did not. A submit whose response is lost (the request committed, the answer never
   * arrived) puts the screen's "that has not reached your account" in front of a reader
   * who then presses again, and the second press bought a second generation: real
   * provider spend against the day's cap, and on an adopted book a second summary of
   * one title on the reader's own shelf.
   *
   * Before the quota, the cap and the insert, so a replay costs nothing and counts for
   * nothing. The answer is the original job's, with `remainingToday` recomputed, because
   * what the caller needs is the job it already has.
   */
  if p_mutation_id is not null then
    select * into replayed
    from public.generation_jobs gj
    where gj.requester_id = uid and gj.client_mutation_id = p_mutation_id;

    if found then
      select count(*) into used
      from public.generation_jobs
      where requester_id = uid
        and created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

      return jsonb_build_object(
        'jobId', replayed.id,
        'kind', replayed.kind,
        'queue', 'fast',
        'delaySeconds', 0,
        'replayed', true,
        'remainingToday', greatest(daily_hard_ceiling - used, 0),
        'budget', public.generation_budget_state()
      );
    end if;
  end if;

  /*
   * An OBJECT, or nothing.
   *
   * `coalesce(p_target, '{}')` covers a missing target and not a malformed one: a
   * client that posts `{"p_target": "hello"}` sends a jsonb STRING, which survives
   * every `->>` below as NULL without complaint and then reaches `target - 'visibility'`
   * -- where `jsonb - text` raises `cannot delete from scalar`, an unhandled 22023 with
   * a message about the internals of a function the caller cannot see. Every other
   * refusal in here is a sentence; this was the one shape that got a stack trace.
   */
  if jsonb_typeof(target) <> 'object' then
    raise exception 'the generation target must be an object, not %', jsonb_typeof(target)
      using errcode = '22023';
  end if;

  job_kind := coalesce(nullif(target ->> 'jobKind', ''), 'canonical_summary');
  if job_kind not in ('canonical_summary', 'private_summary') then
    raise exception 'unknown job kind %; expected canonical_summary or private_summary',
      job_kind
      using errcode = '22023';
  end if;

  if length(coalesce(target ->> 'text', '')) > max_text_length then
    raise exception 'the submitted text is % characters; the limit is %',
      length(target ->> 'text'), max_text_length
      using errcode = 'check_violation';
  end if;

  if length(coalesce(target ->> 'title', '')) > max_title_length then
    raise exception 'the title is % characters; the limit is %',
      length(target ->> 'title'), max_title_length
      using errcode = 'check_violation';
  end if;

  target := target - 'visibility';
  work_ref := target ->> 'work_id';
  if work_ref is null
     or work_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not exists (
       select 1 from public.summaries s
       where s.work_id = work_ref::uuid and s.author_id = uid
     )
  then
    target := target - 'work_id';
  end if;

  /*
   * REFUSED WHERE A JOB COULD NOT RUN, not only where the budget is exactly gone.
   *
   * `spent >= cap` let a job in at 196 of 200 and told the reader it had started, and
   * `reserve_budget` then refused it at `196 + 6 > 200` -- so it parked in the 24-hour
   * budget wait while the screen said "Started. 46 more today." The door and the
   * reservation have to agree, so the door asks for what a job actually needs: the
   * worst case of the two provider steps it will reserve for (`RESERVE_CENTS` in
   * `supabase/functions/_shared/pipeline.ts`, 6 for synthesize and 1 for embed).
   *
   * Stated here rather than imported because SQL cannot read that file. If those
   * constants move, this moves with them -- and the failure if it does not is a job
   * accepted into a wait, which is visible rather than silent.
   */
  spent := public.spend_today();
  if spent + min_job_cents > cap then
    raise exception
      'the daily generation budget is spent. Summaries resume at 00:00 UTC.'
      using errcode = '53400';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

  select count(*) into used
  from public.generation_jobs
  where requester_id = uid
    and created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

  if used >= daily_hard_ceiling then
    raise exception 'daily generation ceiling reached (% jobs); try again tomorrow',
      daily_hard_ceiling
      using errcode = 'check_violation';
  end if;

  over := used >= daily_fast_limit;

  delay_for := case
                 when over then (used - daily_fast_limit + 1) * stagger_seconds
                 else 0
               end;

  insert into public.generation_jobs (requester_id, kind, target, status, client_mutation_id)
  values (uid, job_kind, target, 'queued', p_mutation_id)
  returning id into job_id;

  perform pgmq.send('generation',
                    jsonb_build_object('jobId', job_id, 'step', 'resolve_identity'),
                    delay_for);

  return jsonb_build_object(
    'jobId', job_id,
    'kind', job_kind,
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for,
    'remainingToday', daily_hard_ceiling - used - 1,
    'budget', public.generation_budget_state()
  );
end;
$$;

/*
 * The one-argument form is dropped, not kept beside this.
 *
 * `p_mutation_id` has a default, so an overload would make `rpc('enqueue_generation_job',
 * {p_target: ...})` ambiguous -- PostgREST resolves by the named arguments it is given,
 * and two candidates both match a call that names only `p_target`. One function, one
 * signature, and a caller that sends no id gets the old behaviour.
 */
drop function if exists public.enqueue_generation_job(jsonb);

revoke all on function public.enqueue_generation_job(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_generation_job(jsonb, uuid) to authenticated;

comment on function public.enqueue_generation_job(jsonb, uuid) is
  'The only legitimate writer of generation_jobs. Refuses a guest, a malformed target, a day with no budget left for a whole job, and a requester past the daily ceiling; staggers past the first three. A call carrying a mutation id it has seen returns that job rather than queueing a second.';

-- ------------------------------------------------- 2. a lock an insert cannot move
create or replace function public.attach_generated_summary(
  p_job_id         uuid,
  p_work_id        uuid,
  p_title          text,
  p_elevator_pitch text,
  p_why_it_matters text,
  p_sections       jsonb,
  p_visibility     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  author   uuid;
  existing uuid;
  owned    uuid;
  next_ver int;
  new_id   uuid;
begin
  /*
   * The job row, locked.
   *
   * Two deliveries of the same step can be in flight at once -- pgmq redelivers on a
   * visibility timeout, not on a proof that the last attempt died -- and without this
   * both would read a null `summary_id` and both would insert. The second waits here,
   * then finds the first one's summary and returns it.
   */
  select gj.requester_id, gj.summary_id
    into author, existing
  from public.generation_jobs gj
  where gj.id = p_job_id
  for update;

  if not found then
    raise exception 'attach_generated_summary: no job %', p_job_id using errcode = '22023';
  end if;
  if author is null then
    raise exception 'attach_generated_summary: job % has no requester', p_job_id
      using errcode = '22023';
  end if;

  -- Idempotent, and this is the whole point of the lock above.
  if existing is not null then
    return jsonb_build_object('summaryId', existing, 'created', false);
  end if;

  /*
   * The second lock, on `(work, author)` rather than on a row.
   *
   * This took `for update` on `select ... order by s.id limit 1` over the reader's
   * summaries for the work, which is not a stable anchor: Postgres re-checks the WHERE
   * clause after such a lock unblocks but does not re-run ORDER BY/LIMIT, and
   * `summaries.id` is a random uuid -- so the moment one job inserts a row that sorts
   * below the import's, two jobs can be holding two different rows while both read the
   * same `max(version)`, and the second insert dies on the unique constraint this is
   * here to avoid. An advisory lock names the pair the version is scoped to, and an
   * insert cannot move it. Transaction-scoped, so it ends with the two writes below
   * whatever happens to the connection.
   */
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_work_id::text || ':' || author::text, 0)
  );

  /*
   * And the ownership check, now on its own.
   *
   * `template` adopts a work only where the requester has authored a summary on it;
   * asserting it here means a caller that skipped that check cannot quietly hang a
   * private generation off somebody else's row.
   */
  select s.id into owned
  from public.summaries s
  where s.work_id = p_work_id and s.author_id = author
  limit 1;

  if owned is null then
    raise exception
      'attach_generated_summary: the requester has authored nothing on work %', p_work_id
      using errcode = '42501';
  end if;

  /*
   * NEVER VERSION 1.
   *
   * An imported book carries the reader's version 1 -- the summary `commit_import`
   * hangs four hundred highlights from. A generated summary landing there would be
   * adopted by nothing and overwritten by `cards`, which upserts Pulls on
   * `(summary_id, ordinal)` and would replace the reader's own highlight text at every
   * ordinal the two lists share. The floor holds even if the ownership row above is
   * somehow at a higher version than 1.
   */
  select greatest(coalesce(max(s.version), 1) + 1, 2)
    into next_ver
  from public.summaries s
  where s.work_id = p_work_id and s.author_id = author;

  insert into public.summaries
    (work_id, version, status, visibility, author_id, title, elevator_pitch,
     why_it_matters, sections)
  values
    (p_work_id, next_ver, 'draft', coalesce(p_visibility, 'private')::public.visibility,
     author, p_title, p_elevator_pitch, p_why_it_matters, coalesce(p_sections, '[]'::jsonb))
  returning id into new_id;

  update public.generation_jobs
     set summary_id = new_id,
         work_id    = p_work_id
   where id = p_job_id;

  return jsonb_build_object('summaryId', new_id, 'version', next_ver, 'created', true);
end;
$$;

comment on function public.attach_generated_summary(uuid, uuid, text, text, text, jsonb, text) is
  'Writes a generated summary on a work its requester owns and points the job at it, in one transaction, under a lock on the job and an advisory lock on (work, author) -- so a retry adopts, and two generations of one book take two versions rather than colliding. Draft, never version 1, and the worker''s alone.';

revoke all on function
  public.attach_generated_summary(uuid, uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function
  public.attach_generated_summary(uuid, uuid, text, text, text, jsonb, text)
  to service_role;
