-- The door and the screen read one number, and it is a floor rather than a ceiling.
--
-- Two things were wrong at once, and they are the same thing.
--
-- `generation_budget_state()` -- the only budget figure a reader is allowed, answering
-- `open | low | spent` -- reported `spent` at `spent >= cap`, while the door refused at
-- `spent + min_job_cents > cap`. Between those two points the Studio rendered "nearly
-- used up" beside a live submit button, and every press was refused. That band was 7
-- cents wide when the door was 7; 20 made it 20, a tenth of the day, and the only way a
-- reader learned the day was over was by being turned away.
--
-- And `min_job_cents` was 20 because it was the Anthropic fallback's whole ceiling --
-- but the fallback is opt-in and off by default, so the common deployment reserves less
-- than the door demands and throws away the difference every day.
--
-- Both are fixed by having one number in one place. `min_job_cents()` is the SMALLEST a
-- job can reserve, which is what a door asking "is there room for a job at all" should
-- ask for, and what a screen saying "there is room" should mean. The reservation itself
-- moved per call in the same commit -- `worstCaseCentsFor(input)` bounds the input half
-- by the prompt's UTF-8 byte length -- so the ceiling for a maximal source is no longer
-- a number every job has to clear.
--
-- Law 2 holds: arithmetic over two tables, and no model runs in here.

/*
 * The smallest hold a job can take: one `synthesize` on the shortest possible prompt,
 * plus `embed`.
 *
 * Stated here because SQL cannot read `providers.ts`, and stated ONCE because the
 * previous copy of it drifted from the screen that quotes it. At the default prices
 * that is 16 cents for the summary -- the prompt template alone is 3,669 bytes, and
 * Gemini's output ceiling of 49,152 tokens at $3.00/MTok is 14.75 of it -- and 1 for
 * the embedding.
 *
 * `stable`, not `immutable`: it is a constant today, and a later version that reads a
 * settings row must not be folded into a plan cached from a previous value.
 *
 * Granted to nobody but `service_role`, like the two figures beside it. Its callers are
 * both `security definer` and run as the owner, so no client needs execute on it -- and
 * a number a reader can pair with `generation_budget_state()` is a little more than the
 * `open | low | spent` that 20260914030000 decided was the whole reader-facing answer.
 * The default here is the narrow one.
 */
create function public.min_job_cents()
returns numeric
language sql
stable
set search_path = ''
as $$ select 17::numeric $$;

comment on function public.min_job_cents() is
  'The smallest a job can reserve: one synthesize on the shortest prompt, plus embed. '
  'The door in enqueue_generation_job and the state generation_budget_state() reports '
  'are both this number, so they cannot disagree.';

revoke all on function public.min_job_cents() from public, anon, authenticated;
grant execute on function public.min_job_cents() to service_role;

/*
 * `generation_budget_state`, restated so `spent` means what the door means.
 *
 * The change is one line: `spent >= cap` becomes `spent + min_job_cents > cap`, which
 * is the door's own test. A reader is now told the day is over at the moment it stops
 * admitting work rather than a tenth of a cap later, and `low` keeps its own meaning --
 * a warning while there is still room, not a warning that is already false.
 *
 * Restated in full rather than patched, because a migration is append-only and the
 * whole body is what the next reader will grep for.
 */
create or replace function public.generation_budget_state()
returns text
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  -- Read once. A `case` over two calls evaluates `spend_today()` twice for the common
  -- `open` answer -- four aggregate scans over `cost_ledger` and `budget_reservations`
  -- instead of two -- on a function in the reader's request path.
  spent numeric := public.spend_today();
  cap   numeric := public.daily_spend_cap_cents();
begin
  -- The DOOR's test, not `spent >= cap`. A day with 10 cents left cannot fund a job,
  -- and telling the reader otherwise buys them a refusal instead of an answer.
  if spent + public.min_job_cents() > cap then return 'spent'; end if;
  if spent >= cap * 0.8 then return 'low'; end if;
  return 'open';
end;
$$;

comment on function public.generation_budget_state() is
  'open | low | spent for the current UTC day. `spent` is the same test the door in '
  'enqueue_generation_job applies, so a reader is never shown room that does not exist. '
  'Never the figures themselves: see 20260914030000.';

revoke all on function public.generation_budget_state() from public, anon;
grant execute on function public.generation_budget_state() to authenticated, service_role;

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
  -- Read from `min_job_cents()` rather than pinned here, so the screen that says
  -- whether there is room and the door that decides cannot drift apart.
  min_job_cents      constant numeric := public.min_job_cents();

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
    /*
     * UNDER THE LOCK, which is the correction rather than a tidy-up.
     *
     * Read before it, two presses racing each other both saw no row -- the button
     * carries `aria-disabled` and stays clickable -- so both fell through, the first
     * inserted, and the second died on `generation_jobs_client_mutation_key` with a raw
     * constraint violation under the form while a job really had started. Taking the
     * per-requester lock first makes the second press wait, and by the time it reads,
     * the first is committed and it replays. The lock is per user and transaction-scoped,
     * and taking it here rather than further down only widens what it covers.
     */
    perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

    select * into replayed
    from public.generation_jobs gj
    where gj.requester_id = uid and gj.client_mutation_id = p_mutation_id;

    if found then
      /*
       * A job that is OVER is over, whatever its place in the queue used to be.
       *
       * This recomputed the stagger for every replay and never looked at the status, so
       * a reader replaying a submit whose job had since failed -- a provider outage, or
       * the budget wait running out -- got `queue: 'fast', delaySeconds: 0`, which the
       * Studio prints as "Started." directly above a job list saying it did not finish.
       * The row already knows; this says so and lets the screen read the job itself.
       */
      if replayed.status in ('succeeded', 'failed', 'cancelled') then
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
          'finished', true,
          'status', replayed.status,
          'remainingToday', greatest(daily_hard_ceiling - used, 0),
          'budget', public.generation_budget_state()
        );
      end if;

      /*
       * The placement it ACTUALLY got, not a cheerful default.
       *
       * This answered `queue: 'fast', delaySeconds: 0` for every replay, and the Studio
       * branches on exactly that to print "Started." -- so a reader replaying their 20th
       * job of the day was told a summary had begun that would not start for ninety
       * minutes. Nothing is stored about the delay, but everything needed to recompute it
       * is: the job's own position among that day's jobs is how many the requester had
       * queued before it, which is what decided the stagger at the time.
       */
      select count(*) into used
      from public.generation_jobs gj
      where gj.requester_id = uid
        and gj.created_at >= date_trunc('day', (replayed.created_at at time zone 'utc'))
                             at time zone 'utc'
        -- `(created_at, id)`, because `created_at` alone is not a total order: two jobs
        -- written in the same millisecond would each count the other as later and both
        -- claim the earlier slot. The pair is what the insert order actually was.
        and (gj.created_at, gj.id) < (replayed.created_at, replayed.id);

      over := used >= daily_fast_limit;
      delay_for := case
                     when over then (used - daily_fast_limit + 1) * stagger_seconds
                     else 0
                   end;

      -- What is LEFT of that wait, since some of it has already passed.
      delay_for := greatest(
        delay_for - floor(extract(epoch from (now() - replayed.created_at)))::int, 0);

      select count(*) into used
      from public.generation_jobs
      where requester_id = uid
        and created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

      return jsonb_build_object(
        'jobId', replayed.id,
        'kind', replayed.kind,
        'queue', case when delay_for > 0 then 'normal' else 'fast' end,
        'delaySeconds', delay_for,
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
   * worst case of the two provider steps it will reserve for.
   *
   * TWENTY, NOT SEVEN. Seven was 6 + 1, and the 6 was the EXPECTED cost of a Gemini
   * summary rather than a ceiling — `synthesize` now reserves the active provider's own
   * worst case, which at the Anthropic fallback's configured `max_tokens` and default
   * prices is 19 cents for one accepted source. A door pinned at 7 admitted jobs the
   * reservation then refused, which is the disagreement this check exists to prevent,
   * and the reservation is the half that may not be loosened: it is what stops the
   * ledger passing the cap.
   *
   * Stated in `min_job_cents()` rather than imported, because SQL cannot read
   * `providers.ts`. If the ceilings or the prices move, that function moves with them
   * -- and the failure if it does not is a job accepted into a wait, which is visible
   * rather than silent.
   *
   * It is a FLOOR now, not the ceiling for the largest source. `worstCaseCentsFor` is
   * per call: the input half is the prompt's own byte length, so a two-page essay holds
   * a fraction of what a 200,000-character book holds. A door pinned to the book would
   * refuse the essay with 30 cents of the day unspent and nothing able to use it. The
   * cost of the floor is the opposite case -- a maximal source admitted in the last
   * stretch of a day, whose reservation is then refused and which waits -- and between
   * throwing away a sixth of every day and parking the rare largest job, the job waits.
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

revoke all on function public.enqueue_generation_job(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_generation_job(jsonb, uuid) to authenticated;
