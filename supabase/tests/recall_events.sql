-- ---------------------------------------------------------------------------
-- A grade is recorded once.
--
-- `grade_recall` used to apply every call it received, so a retry of a lost
-- response roughly squared the interval and the client had to drop any grade it
-- could not prove had never left the tab. 20260905100000 makes the attempt itself
-- the unique thing: an event row keyed by `client_mutation_id`, inserted before
-- the arithmetic, so a replay finds its own row and returns the state untouched.
--
-- Asserted in both directions, because a guard that also blocks a legitimate
-- second attempt is a worse bug than the one it replaces:
--
--   * the same id twice -> one event, stability unchanged by the second call
--   * two different ids -> two events, and the second one compounds
--   * a call with no id behaves as before: applied, recorded, not de-duplicable
--   * `record_interrupt` replays stop at the interrupt row: one interrupt, one
--     event, one grade, one session bump
--   * a guest can grade -- the event log carries no guest clause on purpose
--   * a reader cannot read, change or delete another reader's events, and cannot
--     change or delete their own: the log is append-only through the API
--   * an unknown `kind` is refused by the table, not silently stored
--
-- Everything runs as a real reader under RLS. The whole file rolls back.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_is_reader() returns void
language plpgsql as $fn$
begin
  if current_user <> 'authenticated' then
    raise exception
      'assertions must run as the reader, not as %. RLS is invisible to an '
      'owner-role query, so this file would be proving nothing.', current_user;
  end if;
end $fn$;

do $$
declare
  reader_a  uuid := extensions.gen_random_uuid();
  reader_b  uuid := extensions.gen_random_uuid();
  guest     uuid := extensions.gen_random_uuid();
  pull      uuid;
  session   uuid;
  mid_1     uuid := extensions.gen_random_uuid();
  mid_2     uuid := extensions.gen_random_uuid();
  mid_3     uuid := extensions.gen_random_uuid();
  ks        public.knowledge_states;
  s_first   real;
  s_second  real;
  n         int;
  touched   int;
  refused   boolean;
begin
  if (select count(*) from public.pulls) > 500 then
    raise exception
      'refusing to run: found % pulls, which is not a seed corpus. This test '
      'writes before it rolls back and must not be pointed at real data.',
      (select count(*) from public.pulls);
  end if;

  select p.id into strict pull from public.pulls p where p.headline like 'Silencing an opinion%';

  -- Two readers and a guest, all through the real signup trigger.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values
    (reader_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'recall-a-' || left(reader_a::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
    (reader_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'recall-b-' || left(reader_b::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values
    (guest, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     null, '', now(), now(), '{"provider":"anonymous","providers":["anonymous"]}'::jsonb,
     '{}'::jsonb, true);

  -- ------------------------------------------------------------- as reader A
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_a, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  -- 1. First attempt applies and is recorded.
  ks := public.grade_recall(p_pull_id := pull, p_grade := 'good',
                            p_mutation_id := mid_1, p_submitted_at := now(),
                            p_confidence := 'sure', p_latency_ms := 1500);
  s_first := ks.stability;

  select count(*) into n from public.recall_events where pull_id = pull;
  if n <> 1 then
    raise exception 'expected one event after the first grade, found %', n;
  end if;
  if ks.reps <> 1 then
    raise exception 'expected reps = 1 after the first grade, found %', ks.reps;
  end if;

  if not exists (
    select 1 from public.recall_events
    where client_mutation_id = mid_1
      and grade = 'good' and confidence = 'sure' and kind = 'review'
      and stability_before is not null and stability_after = s_first
  ) then
    raise exception 'the event did not record what was applied';
  end if;

  -- 2. The same attempt again: nothing moves.
  ks := public.grade_recall(p_pull_id := pull, p_grade := 'good',
                            p_mutation_id := mid_1, p_submitted_at := now());
  select count(*) into n from public.recall_events where pull_id = pull;
  if n <> 1 then
    raise exception 'a replayed grade wrote a second event (found %)', n;
  end if;
  if ks.stability <> s_first or ks.reps <> 1 then
    raise exception
      'a replayed grade changed the state: stability % -> %, reps %',
      s_first, ks.stability, ks.reps;
  end if;

  -- 3. A genuinely new attempt compounds, as it should.
  ks := public.grade_recall(p_pull_id := pull, p_grade := 'good',
                            p_mutation_id := mid_2, p_submitted_at := now());
  s_second := ks.stability;
  if s_second <= s_first or ks.reps <> 2 then
    raise exception
      'a second attempt did not compound: stability % -> %, reps %',
      s_first, s_second, ks.reps;
  end if;
  select count(*) into n from public.recall_events where pull_id = pull;
  if n <> 2 then
    raise exception 'expected two events after two distinct attempts, found %', n;
  end if;

  -- 4. No id at all: applied and recorded, exactly as before this migration.
  ks := public.grade_recall(p_pull_id := pull, p_grade := 'hard');
  if ks.reps <> 3 then
    raise exception 'a grade without an id was not applied (reps = %)', ks.reps;
  end if;
  select count(*) into n from public.recall_events
  where pull_id = pull and client_mutation_id is null;
  if n <> 1 then
    raise exception 'a grade without an id was not recorded (found %)', n;
  end if;

  -- 5. record_interrupt: a replay stops at the interrupt row.
  insert into public.session_seeds (user_id, seed) values (reader_a, 7) returning id into session;

  perform public.record_interrupt(
    p_pull_id := pull, p_kind := 'recall', p_slot := 4, p_response := 'answered',
    p_grade := 'easy', p_session := session, p_latency := 900,
    p_mutation_id := mid_3, p_submitted_at := now(), p_confidence := 'unsure');
  perform public.record_interrupt(
    p_pull_id := pull, p_kind := 'recall', p_slot := 4, p_response := 'answered',
    p_grade := 'easy', p_session := session, p_latency := 900,
    p_mutation_id := mid_3, p_submitted_at := now(), p_confidence := 'unsure');

  select count(*) into n from public.interrupt_events where client_mutation_id = mid_3;
  if n <> 1 then
    raise exception 'a replayed interrupt wrote % rows', n;
  end if;
  select count(*) into n from public.recall_events where client_mutation_id = mid_3;
  if n <> 1 then
    raise exception 'a replayed interrupt graded % times', n;
  end if;
  if not exists (
    select 1 from public.recall_events
    where client_mutation_id = mid_3 and kind = 'recall' and confidence = 'unsure'
  ) then
    raise exception 'the interrupt grade did not inherit its kind and confidence';
  end if;
  select reps into n from public.knowledge_states where user_id = reader_a and pull_id = pull;
  if n <> 4 then
    raise exception 'expected reps = 4 after one interrupt answer, found %', n;
  end if;
  select interrupts_shown into n from public.session_seeds where id = session;
  if n <> 1 then
    raise exception 'a replayed interrupt bumped the session count to %', n;
  end if;

  -- 6. Append-only through the API: an update or delete touches nothing.
  update public.recall_events set grade = 'forgot' where pull_id = pull;
  get diagnostics touched = row_count;
  if touched <> 0 then
    raise exception 'a reader could rewrite % of their own recall events', touched;
  end if;
  delete from public.recall_events where pull_id = pull;
  get diagnostics touched = row_count;
  if touched <> 0 then
    raise exception 'a reader could delete % of their own recall events', touched;
  end if;

  -- 7. An unknown kind is refused, not stored.
  refused := false;
  begin
    perform public.grade_recall(p_pull_id := pull, p_grade := 'good',
                                p_mutation_id := extensions.gen_random_uuid(),
                                p_kind := 'vibes');
  exception when check_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'an unknown recall_events.kind was accepted';
  end if;

  -- ------------------------------------------------------------- as reader B
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_b, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  select count(*) into n from public.recall_events;
  if n <> 0 then
    raise exception 'reader B can see % of reader A''s recall events', n;
  end if;

  update public.recall_events set grade = 'forgot' where user_id = reader_a;
  get diagnostics touched = row_count;
  if touched <> 0 then
    raise exception 'reader B could rewrite reader A''s events';
  end if;

  -- ------------------------------------------------------------- as the guest
  perform set_config('request.jwt.claims',
    json_build_object('sub', guest, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  perform pg_temp.assert_is_reader();

  ks := public.grade_recall(p_pull_id := pull, p_grade := 'good',
                            p_mutation_id := extensions.gen_random_uuid(),
                            p_submitted_at := now());
  if ks.reps <> 1 then
    raise exception 'a guest could not grade (reps = %)', ks.reps;
  end if;
  select count(*) into n from public.recall_events where user_id = guest;
  if n <> 1 then
    raise exception 'a guest''s grade was not recorded (found %)', n;
  end if;

  raise notice 'recall_events: replay-safe, append-only, self-only, guests may grade';
end $$;

rollback;
