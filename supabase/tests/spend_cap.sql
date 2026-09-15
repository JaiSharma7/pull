-- The daily budget: a reservation, not a reading.
--
-- The property worth protecting is the one a naive implementation gets wrong in a way
-- nobody notices until the invoice arrives: checking `spend_today()` before a provider
-- call is not a cap, because two workers read the same number and both proceed. So the
-- assertions here are mostly about CONCURRENCY and SETTLEMENT rather than about
-- arithmetic:
--
--   * a reservation is counted against the cap by everybody, not only by the worker
--     that took it -- which is what makes two workers unable to both fit in the same
--     remaining budget
--   * a step whose earlier hold is SETTLED takes that row over rather than stacking, so a
--     retry is not refused against money nobody is spending -- while a step redelivered
--     while its first call is still open adds to the hold, because both calls spend
--   * `record_job_step` replaces the hold with the charge in one transaction, so there
--     is no instant where the money is counted twice and none where it goes uncounted
--   * a step that dies holding a reservation is released by the stranded sweep, and by
--     the TTL if the sweep never runs
--   * `spend_today()` never counts `generation_jobs.cost_cents`, which `record_job_step`
--     already writes for every ledgered charge -- counting both halves the cap while
--     claiming not to
--   * `enqueue_generation_job` refuses at the door when the day is spent, validates the
--     job kind and the payload bounds, and keeps `work_id` only where the caller
--     authored a summary on that work
--   * the API roles cannot insert a `generation_jobs` row of their own
--
-- Run as the owner where the subject is the arithmetic, and as `authenticated` where
-- the subject is what a reader may do -- RLS and grants are invisible to an owner-role
-- query, and half of this file would prove nothing without the switch.
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on

begin;

do $$
declare
  reader      uuid := extensions.gen_random_uuid();
  other       uuid := extensions.gen_random_uuid();
  job_a       uuid;
  job_b       uuid;
  job_c       uuid;
  job_d       uuid;
  job_e       uuid;
  job_f       uuid;
  some_work   uuid;
  other_work  uuid;
  cap         numeric := public.daily_spend_cap_cents();
  spent       numeric;
  left_over   numeric;
  refused     boolean;
  queued      jsonb;
  held        int;
begin
  if cap <= 0 then
    raise exception 'daily_spend_cap_cents() is %, so nothing below can mean anything', cap;
  end if;

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (reader, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'spend-cap' || left(reader::text, 8) || '@example.test', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
         (other, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'spend-cap' || left(other::text, 8) || '@example.test', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false);

  select w.id into some_work from public.works w order by w.id limit 1;
  select w.id into other_work from public.works w order by w.id desc limit 1;
  if some_work is null or some_work = other_work then
    raise exception 'the corpus has fewer than two works; this fixture needs two';
  end if;

  insert into public.generation_jobs (requester_id, target, status)
  values (reader, '{"text":"x"}'::jsonb, 'running') returning id into job_a;
  insert into public.generation_jobs (requester_id, target, status)
  values (reader, '{"text":"x"}'::jsonb, 'running') returning id into job_b;
  insert into public.generation_jobs (requester_id, target, status)
  values (reader, '{"text":"x"}'::jsonb, 'running') returning id into job_c;

  -- Aged at INSERT, not by a later update: `set_updated_at` is a `before update`
  -- trigger, so an `update ... set updated_at = ...` is stamped straight back to now()
  -- and the sweep below would find nothing. `stranded_jobs.sql` learned this first.
  insert into public.generation_jobs (requester_id, target, status, current_step, updated_at)
  values (reader, '{"text":"x"}'::jsonb, 'running', 'artwork', now() - interval '1 hour')
  returning id into job_d;

  -- --------------------------------------------- 1. a hold is everybody's hold
  --
  -- The reservation job A takes has to be visible to the sum job B is measured
  -- against. If it is not, two workers fit inside the same remaining budget and the
  -- overshoot is unbounded in the number of workers.
  spent := public.spend_today();
  if spent <> 0 then
    raise exception 'the fixture started with % cents already spent today', spent;
  end if;

  perform public.reserve_budget(job_a, 'synthesize', cap - 1);
  if public.spend_today() <> cap - 1 then
    raise exception
      'a hold of % is not counted by spend_today() (it says %). A reservation only its '
      'own worker can see is not a cap.', cap - 1, public.spend_today();
  end if;

  refused := false;
  begin
    perform public.reserve_budget(job_b, 'synthesize', 5);
  exception when configuration_limit_exceeded then
    refused := true;
  end;
  if not refused then
    raise exception
      'a second job reserved 5 cents while % of % were already held. Two workers just '
      'both decided they were under the cap.', cap - 1, cap;
  end if;

  -- And the budget that does fit is still granted, so the cap is a bound rather
  -- than a wall.
  left_over := public.reserve_budget(job_b, 'synthesize', 1);
  if left_over <> 0 then
    raise exception 'reserve_budget reported % left after filling the cap exactly', left_over;
  end if;

  -- ----------------------------------- 2. a RETRY re-reserves rather than stacking
  --
  -- pgmq can hand the same message out twice, and the two cases are not the same. A
  -- step that has finished -- failed or billed -- settled its hold on the way out, so
  -- the delivery that retries it finds a dead row and takes it over: one row, and the
  -- total where it was. Stacking there would refuse a retry against money nobody is
  -- spending. The other case, where the earlier call is still OPEN, is a second call
  -- and is asserted at 5b-ii below.
  perform public.settle_budget(job_b, 'synthesize');
  perform public.reserve_budget(job_b, 'synthesize', 1);
  select count(*) into held from public.budget_reservations br
   where br.job_id = job_b and br.step = 'synthesize';
  if held <> 1 then
    raise exception 'a redelivered step opened % reservations; it must reuse one', held;
  end if;
  if public.spend_today() <> cap then
    raise exception
      're-reserving a settled step moved the total to % rather than leaving it at %',
      public.spend_today(), cap;
  end if;

  -- ------------------------------------ 3. the ledger replaces the hold, atomically
  --
  -- `record_job_step` writes the charge and settles the reservation in one
  -- transaction. A sum that counted both would be double; one that counted neither
  -- would let the next caller spend money already spent.
  perform public.settle_budget(job_b, 'synthesize');
  if public.spend_today() <> cap - 1 then
    raise exception 'settling job B''s hold left the total at %', public.spend_today();
  end if;

  perform public.record_job_step(
    job_a, 'synthesize', 1, 'stub', 'v1', 100, 100, 10::numeric, 5, 'stub', true, null
  );
  spent := public.spend_today();
  if spent <> 10 then
    raise exception
      'after a 10-cent charge replaced a % cent hold, spend_today() says %. The hold '
      'and the charge must not both count, and one of them must.', cap - 1, spent;
  end if;

  -- The roll-up into generation_jobs.cost_cents happened too, and must NOT be counted.
  if (select gj.cost_cents from public.generation_jobs gj where gj.id = job_a) <> 10 then
    raise exception 'record_job_step stopped rolling the charge into the job total';
  end if;
  if public.spend_today() <> 10 then
    raise exception
      'spend_today() is % with one 10-cent charge on the ledger and the same 10 cents '
      'on the job row. Counting both halves the cap while claiming not to.',
      public.spend_today();
  end if;

  -- ------------------------------------------ 4. a failed step lets go of its hold
  perform public.reserve_budget(job_c, 'embed', 20);
  if public.spend_today() <> 30 then
    raise exception 'spend_today() is % after a 20-cent hold on top of 10 charged',
      public.spend_today();
  end if;
  perform public.record_failed_job_step(job_c, 'embed', 1, 'boom', 5, null, null, 0, 0, 0, false);
  if public.spend_today() <> 10 then
    raise exception
      'a failed step left % held. A provider outage would pin the cap shut.',
      public.spend_today() - 10;
  end if;

  -- --------------------------------------- 5. a stranded job releases what it held
  --
  -- Nothing will ever record for a job the sweep declares dead, so the sweep is the
  -- only thing between a crash and an hour of held budget.
  --
  -- Backdated with the job, because 20260914040000 made the settlement pass ignore a
  -- hold younger than its own threshold: a young hold belongs to a step that is still
  -- calling its provider, not to a crash. Nothing real puts a fresh hold on a job the
  -- sweep will fail -- `reserve_budget` runs immediately after a dispatch that stamps
  -- `updated_at`, and a job stamped seconds ago is not stranded -- so the fixture is
  -- what was unrealistic here, and it was hiding the sibling race the new bound closes.
  perform public.reserve_budget(job_d, 'artwork', 50);
  update public.budget_reservations
     set created_at = now() - interval '25 minutes'
   where job_id = job_d and step = 'artwork';
  if public.spend_today() <> 60 then
    raise exception 'the fixture for the sweep did not take; spend_today() is %',
      public.spend_today();
  end if;
  perform public.sweep_stranded_generation_jobs(interval '10 minutes');
  if public.spend_today() <> 10 then
    raise exception
      'the sweep failed a job and left % cents held against the cap',
      public.spend_today() - 10;
  end if;

  -- --------------------------- 5b. a terminal job holds nothing, however it ended
  --
  -- The sweep used to settle only the jobs IT failed, which misses the commonest
  -- terminal failure the pipeline has: the worker exhausting a step's retries and
  -- marking the job failed itself. That job is no longer `queued` or `running`, so the
  -- sweep's own selection can never reach it, and nothing else would until the TTL.
  --
  -- Backdated for the reason 5 above gives: the settlement pass leaves a hold younger
  -- than its threshold alone, because a young hold on a job that has just failed is a
  -- SIBLING STEP still inside its provider call. Section 11 asserts that half.
  insert into public.generation_jobs (requester_id, target, status)
  values (reader, '{"text":"x"}'::jsonb, 'running') returning id into job_e;
  perform public.reserve_budget(job_e, 'synthesize', 40);
  update public.budget_reservations
     set created_at = now() - interval '25 minutes'
   where job_id = job_e and step = 'synthesize';
  update public.generation_jobs set status = 'failed', finished_at = now() where id = job_e;
  if public.spend_today() <> 50 then
    raise exception 'the fixture for the terminal sweep did not take; spend_today() is %',
      public.spend_today();
  end if;
  perform public.sweep_stranded_generation_jobs(interval '10 minutes');
  if public.spend_today() <> 10 then
    raise exception
      'a job that failed outside the sweep kept % cents held. During a provider outage '
      'that is how a cap nobody spent closes for an hour.', public.spend_today() - 10;
  end if;

  -- ------------------- 5b-ii. two calls of ONE step are two holds, not one
  --
  -- pgmq redelivers on a visibility timeout, not on a proof that the last attempt died,
  -- so a `synthesize` call that runs past the worker's 180 s message hold is run a
  -- second time while the first is still inside the provider. `reserve_budget` used to
  -- upsert onto `(job, step)` while excluding that same key from the total it checked,
  -- so the second call was free -- and then the first to return stamped the row settled,
  -- leaving the second call's spend held by nothing.
  insert into public.generation_jobs (requester_id, target, status)
  values (reader, '{"text":"x"}'::jsonb, 'running') returning id into job_f;
  perform public.reserve_budget(job_f, 'synthesize', 6);
  perform public.reserve_budget(job_f, 'synthesize', 6);
  if public.spend_today() <> 22 then
    raise exception
      'two concurrent calls of one step came to % cents of hold, not 12. The cap cannot '
      'see money it is not counting.', public.spend_today() - 10;
  end if;

  -- The first call returns: its share goes back, the other call's does not.
  perform public.settle_budget(job_f, 'synthesize');
  if public.spend_today() <> 16 then
    raise exception
      'settling one of two outstanding calls left % held; the other call is still inside '
      'its provider and its six cents must stay held.', public.spend_today() - 10;
  end if;
  if (select br.settled_at from public.budget_reservations br
       where br.job_id = job_f and br.step = 'synthesize') is not null then
    raise exception 'the hold was stamped settled while a call was still outstanding';
  end if;

  perform public.settle_budget(job_f, 'synthesize');
  if public.spend_today() <> 10 then
    raise exception 'the last settle left % held', public.spend_today() - 10;
  end if;
  if (select br.settled_at from public.budget_reservations br
       where br.job_id = job_f and br.step = 'synthesize') is null then
    raise exception 'the last call released its share and the hold was left open';
  end if;

  -- --------------------- 5c. and two holds on one job are two independent holds
  --
  -- `settle_job_budget` released all of a job's holds in one call, and 20260914050000
  -- drops it: both callers now settle `(job, step)`, because a job being failed is not
  -- the same moment as every one of its steps being over -- `extract_evidence` runs
  -- beside `synthesize` and can still be mid-call. What has to hold is that settling
  -- one step leaves its sibling's money exactly where it was.
  perform public.reserve_budget(job_a, 'embed', 20);
  perform public.reserve_budget(job_a, 'artwork', 30);
  if public.spend_today() <> 60 then
    raise exception 'two holds on one job came to %', public.spend_today() - 10;
  end if;
  perform public.settle_budget(job_a, 'embed');
  if public.spend_today() <> 40 then
    raise exception
      'settling one step of a two-step job left % held; it should have released 20 and '
      'left the sibling''s 30 alone.', public.spend_today() - 10;
  end if;
  perform public.settle_budget(job_a, 'artwork');
  if public.spend_today() <> 10 then
    raise exception 'settling the sibling left % cents held', public.spend_today() - 10;
  end if;

  -- --------------------------- 5d. and a hold belongs to the day it was taken in
  --
  -- A hold taken at 23:58 for a call that stalls is still inside its one-hour TTL at
  -- 00:05. Counted, the new day opens with cents spent on it that belong to a day
  -- already closed out -- and a provider stall at the boundary produces several at
  -- once, so the first readers of the morning are refused for yesterday's ghosts.
  perform public.reserve_budget(job_a, 'artwork', 70);
  update public.budget_reservations
     set created_at = date_trunc('day', (now() at time zone 'utc')) at time zone 'utc'
                      - interval '2 minutes'
   where job_id = job_a and step = 'artwork';
  if public.spend_today() <> 10 then
    raise exception
      'a hold taken before midnight is counted against today (total %). The charge, if '
      'it lands, writes its ledger row on the day it lands.', public.spend_today();
  end if;
  delete from public.budget_reservations where job_id = job_a and step = 'artwork';

  -- ------------------------------------------------ 6. and the TTL is the backstop
  --
  -- If the sweep never runs, an ancient hold is ignored rather than believed for ever.
  perform public.reserve_budget(job_a, 'artwork', 50);
  update public.budget_reservations
     set created_at = now() - interval '2 hours'
   where job_id = job_a and step = 'artwork';
  if public.spend_today() <> 10 then
    raise exception
      'a two-hour-old hold is still counted (total %). Without a TTL one lost worker '
      'closes the budget until midnight.', public.spend_today();
  end if;
  delete from public.budget_reservations where job_id = job_a and step = 'artwork';

  raise notice 'spend_cap.sql: reservations hold, redeliver, settle and expire correctly';
end $$;

-- ------------------------------------------------- 7. what a reader may do
--
-- As `authenticated`, because grants and RLS are invisible to the owner.
do $$
declare
  reader     uuid;
  mine       uuid;
  theirs     uuid;
  other      uuid;
  refused    boolean;
  queued     jsonb;
  stored     jsonb;
  kept       text;
begin
  select u.id into reader from auth.users u
   where u.email like 'spend-cap%' order by u.email limit 1;
  select u.id into other from auth.users u
   where u.email like 'spend-cap%' and u.id <> reader limit 1;

  select w.id into mine from public.works w order by w.id limit 1;
  select w.id into theirs from public.works w order by w.id desc limit 1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);

  if current_user <> 'authenticated' then
    raise exception 'these assertions must run as authenticated, not as %', current_user;
  end if;

  -- The reader may ask WHETHER there is budget, and not how much: 20260914010000
  -- argues a readable number tells somebody exactly how much to spend to close the
  -- door on everyone else, and then granted them the number. They may not reserve,
  -- settle, or insert a job row either.
  if public.generation_budget_state() not in ('open', 'low', 'spent') then
    raise exception 'generation_budget_state() answered something the client cannot read';
  end if;

  refused := false;
  begin
    perform public.spend_today();
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception
      'a reader could read spend_today(). With daily_spend_cap_cents() beside it that '
      'is a live countdown to closing the day for everybody.';
  end if;

  refused := false;
  begin
    perform public.daily_spend_cap_cents();
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader could read the cap, which is the other half of the countdown.';
  end if;

  refused := false;
  begin
    perform public.reserve_budget(extensions.gen_random_uuid(), 'synthesize', 1);
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader could reserve budget. Anyone could starve the day at will.';
  end if;

  refused := false;
  begin
    perform public.settle_budget(extensions.gen_random_uuid(), 'synthesize');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader could settle a reservation, and so release a hold at will.';
  end if;


  refused := false;
  begin
    insert into public.generation_jobs (requester_id, target, status)
    values (reader, '{"text":"x"}'::jsonb, 'queued');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception
      'a reader inserted a generation_jobs row directly. enqueue_generation_job is the '
      'only legitimate writer -- see 20260914010000.';
  end if;

  -- The budget table itself says nothing to a reader.
  if exists (select 1 from public.budget_reservations) then
    raise exception 'budget_reservations is readable through the API';
  end if;

  -- ---------------------------------------------------- the payload bounds
  refused := false;
  begin
    perform public.enqueue_generation_job('{"jobKind":"something_else","title":"x"}'::jsonb);
  exception when invalid_parameter_value then
    refused := true;
  end;
  if not refused then
    raise exception 'an unknown jobKind was accepted; the pipeline would never run it.';
  end if;

  refused := false;
  begin
    perform public.enqueue_generation_job(
      jsonb_build_object('title', repeat('t', 201), 'text', 'x'));
  exception when check_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'a 201-character title was accepted; works.title is 200.';
  end if;

  refused := false;
  begin
    perform public.enqueue_generation_job(
      jsonb_build_object('title', 'ok', 'text', repeat('x', 200001)));
  exception when check_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'a 200,001-character body was accepted; the pipeline truncates at 200,000.';
  end if;

  -- --------------------------------------- work_id survives only where it is theirs
  --
  -- The pipeline adopts `target.work_id` so an imported book gains a summary rather
  -- than a second `works` row. Adopting somebody else's would attach a reader's
  -- private generation to a work they have nothing to do with.
  queued := public.enqueue_generation_job(
    jsonb_build_object('jobKind', 'private_summary', 'title', 'Mine',
                       'text', 'x', 'work_id', theirs::text));
  select gj.target, gj.kind into stored, kept
  from public.generation_jobs gj where gj.id = (queued ->> 'jobId')::uuid;
  if stored ? 'work_id' then
    raise exception
      'a work the caller has authored nothing on survived into the target. The pipeline '
      'would adopt it.';
  end if;
  if kept <> 'private_summary' then
    raise exception 'generation_jobs.kind is % rather than the job kind that was asked for', kept;
  end if;

  -- Now author one, and the same call keeps it.
  insert into public.summaries (work_id, author_id, title, status, visibility, published_at)
  values (theirs, reader, 'A reader summary', 'published', 'private', now());

  queued := public.enqueue_generation_job(
    jsonb_build_object('jobKind', 'private_summary', 'title', 'Mine',
                       'text', 'x', 'work_id', theirs::text, 'visibility', 'public'));
  select gj.target into stored
  from public.generation_jobs gj where gj.id = (queued ->> 'jobId')::uuid;
  if (stored ->> 'work_id') <> theirs::text then
    raise exception
      'a work the caller authored a summary on was stripped from the target; an import '
      'would gain a second works row.';
  end if;
  -- `visibility` never survives, whoever sends it.
  if stored ? 'visibility' then
    raise exception 'a client-supplied visibility reached the job target.';
  end if;

  -- A malformed work_id is stripped rather than raised: it is a key the caller
  -- should not have sent, not an error they can act on.
  queued := public.enqueue_generation_job(
    jsonb_build_object('title', 'Mine', 'text', 'x', 'work_id', 'not-a-uuid'));
  if queued ->> 'jobId' is null then
    raise exception 'a malformed work_id failed the whole call';
  end if;

  raise notice 'spend_cap.sql: a reader may ask whether there is room and not how much, and may not reserve, settle or insert';
end $$;

-- ------------- 7b. a replayed submit returns the job it is replaying
--
-- A request that committed and whose response was lost leaves the Studio telling the
-- reader it never arrived. They press again, and without a mutation id that second press
-- is a second paid generation and a second summary of one book on their own shelf. Run
-- before the budget fixtures below spend the day, since the door refuses everything once
-- the cap is gone and there would be nothing left to replay.
do $$
declare
  reader  uuid;
  once    jsonb;
  twice   jsonb;
  mut     uuid := extensions.gen_random_uuid();
  jobs    int;
begin
  perform set_config('role', 'postgres', true);
  select u.id into reader from auth.users u
   where u.email like 'spend-cap%' order by u.email limit 1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);

  once := public.enqueue_generation_job(
    jsonb_build_object('title', 'Replayed', 'text', 'x'), mut);
  twice := public.enqueue_generation_job(
    jsonb_build_object('title', 'Replayed', 'text', 'x'), mut);

  if (twice ->> 'jobId') <> (once ->> 'jobId') then
    raise exception
      'a replayed submit queued a second job (% then %). That is a second paid '
      'generation for one press.', once ->> 'jobId', twice ->> 'jobId';
  end if;
  if (twice ->> 'replayed')::boolean is not true then
    raise exception 'a replay was not reported as one, so the screen cannot tell';
  end if;

  /*
   * And it says where that job actually is. The first version answered `fast` / 0 for
   * every replay, and the Studio prints "Started." on exactly that — so a reader
   * replaying a staggered job was told a summary had begun that would not start for
   * another hour and a half.
   */
  declare
    staggered jsonb;
    late      uuid := extensions.gen_random_uuid();
  begin
    -- Past the free allowance, so the next job is genuinely delayed.
    for i in 1..4 loop
      perform public.enqueue_generation_job(
        jsonb_build_object('title', 'Filler ' || i, 'text', 'x'));
    end loop;

    -- Backdated, because `now()` is the TRANSACTION's clock: every row inserted in this
    -- block shares one `created_at`, and the placement is read from which jobs came
    -- before. A minute apart is what production gets for free.
    perform set_config('role', 'postgres', true);
    update public.generation_jobs set created_at = now() - interval '1 minute'
     where requester_id = reader;
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', reader, 'role', 'authenticated')::text, true);

    staggered := public.enqueue_generation_job(
      jsonb_build_object('title', 'Late', 'text', 'x'), late);
    if (staggered ->> 'queue') <> 'normal' or (staggered ->> 'delaySeconds')::int <= 0 then
      raise exception 'the fixture did not produce a staggered job: %', staggered;
    end if;

    staggered := public.enqueue_generation_job(
      jsonb_build_object('title', 'Late', 'text', 'x'), late);
    if (staggered ->> 'queue') <> 'normal' or (staggered ->> 'delaySeconds')::int <= 0 then
      raise exception
        'a replay of a staggered job reported %, so the screen says "Started." for a job '
        'that has not.', staggered;
    end if;
  end;

  select count(*) into jobs
  from public.generation_jobs gj
  where gj.requester_id = reader and gj.client_mutation_id = mut;
  if jobs <> 1 then
    raise exception 'one submission left % job rows', jobs;
  end if;

  -- A DIFFERENT id from the same reader is a different submission, not a replay.
  if (public.enqueue_generation_job(jsonb_build_object('title', 'Another', 'text', 'x'),
                                    extensions.gen_random_uuid()) ->> 'jobId')
     = (once ->> 'jobId') then
    raise exception 'a second submission was mistaken for a replay of the first';
  end if;

  /*
   * And a job that is OVER says so rather than reporting a place in the queue. The
   * Studio prints "Started." on `queue = 'fast'`, so a replay of a submit whose job had
   * since failed announced a summary that had already not happened.
   */
  perform set_config('role', 'postgres', true);
  update public.generation_jobs set status = 'failed', finished_at = now()
   where id = (once ->> 'jobId')::uuid;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);

  twice := public.enqueue_generation_job(
    jsonb_build_object('title', 'Replayed', 'text', 'x'), mut);
  if (twice ->> 'finished')::boolean is not true or (twice ->> 'status') <> 'failed' then
    raise exception
      'a replay of a job that had already failed answered %, so the screen says a summary '
      'has started.', twice;
  end if;

  raise notice 'spend_cap.sql: a replayed submit returns its job rather than buying another';
end $$;

-- ------------------------------------------- 8. a spent day refuses at the door
--
-- Back to the owner, because the fixture writes a ledger row and then the assertion
-- has to be made as a reader.
do $$
declare
  reader uuid;
  job    uuid;
begin
  -- Back to the owner. `set_config(..., true)` is transaction-local, not block-local,
  -- so the previous block's `authenticated` is still in force here and `auth.users` is
  -- not readable by it.
  perform set_config('role', 'postgres', true);

  select u.id into reader from auth.users u
   where u.email like 'spend-cap%' order by u.email limit 1;

  insert into public.generation_jobs (requester_id, target, status)
  values (reader, '{"text":"x"}'::jsonb, 'running') returning id into job;

  -- The whole cap, charged.
  perform public.record_job_step(
    job, 'synthesize', 1, 'stub', 'v1', 1, 1,
    public.daily_spend_cap_cents(), 5, 'stub', true, null
  );
end $$;

do $$
declare
  reader  uuid;
  refused boolean := false;
begin
  select u.id into reader from auth.users u
   where u.email like 'spend-cap%' order by u.email limit 1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);

  begin
    perform public.enqueue_generation_job('{"title":"After the budget","text":"x"}'::jsonb);
  exception when configuration_limit_exceeded then
    refused := true;
  end;
  if not refused then
    raise exception
      'a job was enqueued after the day''s whole budget was charged. The cap is the one '
      'bound the per-requester quotas cannot express.';
  end if;

  raise notice 'spend_cap.sql: a spent day refuses at the door rather than queueing a wait';
end $$;

-- ------------------- 9. and a day with less than one job left refuses too
--
-- The door and the reservation have to agree. `spent >= cap` let a job in at 196 of 200,
-- told the reader "Started. 46 more today.", and then `reserve_budget` refused it -- so
-- it parked in the 24-hour budget wait with the screen saying it had begun. Every job
-- enqueued in the last few cents of a day behaved that way.
--
-- TEN CENTS LEFT, deliberately: enough that `spent >= cap` is false, more than the seven
-- the door used to ask for, and less than the seventeen it asks for now that `synthesize`
-- reserves the provider's own worst case rather than the expected cost of a Gemini call.
-- Four cents -- what this used to wind the day back to -- is refused by both thresholds,
-- so it could not tell them apart.
--
-- And the SCREEN has to say the same thing, which is the second half below. A door that
-- refuses while `generation_budget_state()` still answers `low` is a live submit button
-- over a day that is over: the reader finds out by being turned away, once per press.
do $$
declare
  reader uuid;
  job    uuid;
begin
  perform set_config('role', 'postgres', true);
  select u.id into reader from auth.users u
   where u.email like 'spend-cap%' order by u.email limit 1;

  -- Wind the day back to ten cents left: `spent >= cap` is false, and ten is less than
  -- the seventeen a job reserves before it can run.
  delete from public.cost_ledger;
  insert into public.generation_jobs (requester_id, target, status)
  values (reader, '{"text":"x"}'::jsonb, 'running') returning id into job;
  perform public.record_job_step(
    job, 'synthesize', 1, 'stub', 'v1', 1, 1,
    public.daily_spend_cap_cents() - 10, 5, 'stub', true, null
  );
end $$;

do $$
declare
  reader  uuid;
  refused boolean := false;
begin
  select u.id into reader from auth.users u
   where u.email like 'spend-cap%' order by u.email limit 1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);

  begin
    perform public.enqueue_generation_job('{"title":"Ten cents left","text":"x"}'::jsonb);
  exception when configuration_limit_exceeded then
    refused := true;
  end;
  if not refused then
    raise exception
      'a job was accepted with ten cents left, which is less than the seventeen it will '
      'reserve. It would park in a 24-hour wait under a screen saying it had started.';
  end if;

  -- The same moment, read by the client. `generation_budget_state()` is the only budget
  -- figure a reader gets, and the Studio draws its submit button from it -- so if it
  -- still answers `low` here, the screen is offering something the door will refuse.
  if public.generation_budget_state() <> 'spent' then
    raise exception
      'the door refused this day but generation_budget_state() reported %. The Studio '
      'would show "nearly used up" and a live button over a day that cannot fund a job.',
      public.generation_budget_state();
  end if;

  raise notice 'spend_cap.sql: the door refuses what the reservation could not grant, '
    'and the screen says so';
end $$;

-- ------------------------ 10. a malformed target is refused, not raised from within
--
-- Every other refusal in `enqueue_generation_job` is a sentence the caller can act on.
-- A jsonb SCALAR -- what `{"p_target": "hello"}` sends through PostgREST -- passed every
-- `->>` as NULL and then reached `target - 'visibility'`, where Postgres raises
-- `cannot delete from scalar`: a 500 out of the internals of a function the caller
-- cannot read. 20260914040000 refuses it at the top instead.
do $$
declare
  reader  uuid;
  refused text := null;
begin
  perform set_config('role', 'postgres', true);
  select u.id into reader from auth.users u
   where u.email like 'spend-cap%' order by u.email limit 1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);

  begin
    perform public.enqueue_generation_job('"hello"'::jsonb);
  exception when others then
    refused := sqlerrm;
  end;

  if refused is null then
    raise exception 'a jsonb scalar was accepted as a generation target';
  end if;
  if refused like '%delete from scalar%' then
    raise exception
      'a malformed target still raises from inside the function: %. The caller gets a '
      'stack trace where every other bad shape gets a sentence.', refused;
  end if;
  if refused not like '%must be an object%' then
    raise exception 'a malformed target was refused, but not in terms a caller can read: %',
      refused;
  end if;

  /*
   * `null` and `'{}'` are NOT asserted here, and deliberately: by this point sections 8
   * and 9 have charged the day's whole cap inside this transaction, so an acceptable
   * target is refused for the budget rather than accepted. `coalesce(p_target, '{}')`
   * runs before the new guard and `jsonb_typeof('{}')` is `object`, so the shape the
   * guard must not break is the one every other section of this file enqueues with.
   */
  raise notice 'spend_cap.sql: a malformed target is refused in the same voice as the others';
end $$;

-- ----------------- 11. a hold still in use is not stranded, however dead its job is
--
-- `graph.ts` runs `extract_evidence` beside `synthesize` and `artwork` beside `embed`,
-- in separate invocations. So the instant one step exhausts its retries and fails the
-- JOB, a sibling can still be inside its provider call holding a live reservation --
-- and a terminal-status sweep that keys on status alone hands that money back before
-- the charge arrives. The sweep now leaves a hold younger than its own threshold alone.
do $$
declare
  reader   uuid;
  job      uuid;
  open_now int;
begin
  perform set_config('role', 'postgres', true);

  select u.id into reader from auth.users u
   where u.email like 'spend-cap%' order by u.email limit 1;

  insert into public.generation_jobs (requester_id, target, status, finished_at)
  values (reader, '{"text":"x"}'::jsonb, 'failed', now()) returning id into job;

  -- A sibling that reserved a second ago and is still calling its provider.
  insert into public.budget_reservations (job_id, step, reserved_cents, created_at)
  values (job, 'synthesize', 6, now());

  perform public.sweep_stranded_generation_jobs();

  select count(*) into open_now
  from public.budget_reservations br
  where br.job_id = job and br.settled_at is null;
  if open_now <> 1 then
    raise exception
      'the sweep released a hold taken seconds ago on a job that had just failed. The '
      'step holding it is still mid-call, and its charge will land against a total '
      'this pass made short by exactly that amount.';
  end if;

  -- The same row, once it is genuinely older than the threshold.
  update public.budget_reservations br
     set created_at = now() - interval '30 minutes'
   where br.job_id = job;

  perform public.sweep_stranded_generation_jobs();

  select count(*) into open_now
  from public.budget_reservations br
  where br.job_id = job and br.settled_at is null;
  if open_now <> 0 then
    raise exception
      'the sweep left a half-hour-old hold open on a terminal job. Nothing will ever '
      'record for it, so it is money held against the cap for a charge that cannot come.';
  end if;

  raise notice 'spend_cap.sql: the sweep settles a stranded hold and leaves a live one alone';
end $$;

rollback;
