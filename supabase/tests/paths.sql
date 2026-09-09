-- ---------------------------------------------------------------------------
-- Paths, steps, progress, and an apply step that resurfaces.
--
-- Asserted, and each is a way the functions in 20260909010000 could be wrong:
--
--   * a draft path is invisible through RLS and through `get_paths()`; a published
--     one is visible through both
--   * `get_path` is case-insensitive on its slug -- `paths.slug` is citext and the
--     function runs with an empty search_path, which is exactly the setting that
--     turns `=` case-sensitive
--   * the three helpers the RPCs share are not callable by a reader, and the readable
--     set they define excludes a draft path
--   * `advance_path` refuses an apply step, so the only way to complete one is with a
--     reflection
--   * a reader with NO prior `knowledge_states` row walks a path, and every step they
--     advance puts its idea into the schedule: the row EXISTS afterwards, acquired by
--     reading, and the apply step's idea is due within three days. Asserted by
--     presence -- `if x is null then raise` -- never by a comparison a null satisfies,
--     because that is how the first version of this file passed with the row missing
--   * an idea already scheduled is pulled forward to three days and not later
--   * advancing clears `paused_at`
--   * a replayed `apply_path_step` returns the note it already wrote, writes no
--     second one, and does not rewrite the first
--   * `apply_path_step` refuses a step that is not an apply step, a draft path, an
--     unreadable step, a blank reflection (spaces, tabs or newlines) and one over
--     20,000 characters -- and writes NOTHING when it refuses: no note, no step done,
--     no schedule entry, no progress row. Asserted against a reader with no prior
--     activity, on undone steps, so a refusal that did not raise but wrote first
--     would have somewhere to leave a mark. A refusal that RAISES cannot, whatever
--     order its statements are in: the exception aborts the call and Postgres
--     discards its writes, and a mutant that advanced the step before raising was
--     run against this file and survived for exactly that reason. The footprint
--     check therefore guards the shape of a future refusal that returns instead of
--     raising, not the current ones
--   * `test_out` leaves a step the reader genuinely completed as completed, and only
--     tests out of steps not yet done
--   * a step whose pull the caller cannot read is neither shown by `get_path` nor
--     counted by `advance_path`, so the path completes for that caller; the reader
--     who CAN read it is shown it and owes it
--   * a path none of whose steps the caller can read cannot be completed by testing
--     out of nothing, and one completed and then wholly hidden is not reported complete
--   * a step that becomes readable after the path was finished reopens it, on both
--     RPCs and in the stored row; a step hidden after it was done does not push
--     `completedSteps` past `stepCount`
--   * Reader B sees none of Reader A's progress
--   * anon can read paths and cannot mutate them
--
-- WHAT THIS FILE CANNOT PROVE. The `for update` lock that serialises two advances of
-- the last two steps needs two sessions to demonstrate; psql has one. And `test_out`
-- comparing `>` rather than `>=` against the floor differs only at exact equality,
-- which `retrievability` -- an exponential of a timestamp difference -- cannot be
-- made to hit on purpose. Both are stated in the migration and neither is asserted.
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

create or replace function pg_temp.become(p_uid uuid) returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
end $fn$;

create or replace function pg_temp.as_owner() returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $fn$;

/* Everything a refused call could have left behind for one reader, as one number.
   Run as the reader, so every table is read under that reader's own policies. */
create or replace function pg_temp.footprint(p_uid uuid) returns int
language sql as $fn$
  select (select count(*) from public.notes where user_id = p_uid)
       + (select count(*) from public.path_step_done where user_id = p_uid)
       + (select count(*) from public.knowledge_states where user_id = p_uid)
       + (select count(*) from public.path_progress where user_id = p_uid);
$fn$;

do $$
declare
  reader_a  uuid := extensions.gen_random_uuid();
  reader_b  uuid := extensions.gen_random_uuid();
  reader_c  uuid := extensions.gen_random_uuid();
  pull_1    uuid;
  pull_2    uuid;
  pull_priv uuid;
  priv_work    uuid := extensions.gen_random_uuid();
  priv_summary uuid := extensions.gen_random_uuid();
  path_pub  uuid;
  path_drf  uuid;
  path_hid  uuid;
  slug_pub  citext := 'test-path-public';
  slug_drf  citext := 'test-path-draft';
  slug_hid  citext := 'test-path-hidden';
  paths_out jsonb;
  path_out  jsonb;
  row_out   jsonb;
  adv_out   jsonb;
  apply_out jsonb;
  test_out_res jsonb;
  refused   boolean;
  code      text;
  n         int;
  mut_id    uuid := extensions.gen_random_uuid();
  note_id   uuid;
  note_body text;
  via       public.acquisition;
  due_before timestamptz;
  due_after  timestamptz;
  paused     timestamptz;
begin
  -- 1. Two seeded pulls with readable summaries, and one nobody but reader C can read.
  select p.id into pull_1
  from public.pulls p
  join public.summaries s on s.id = p.summary_id and s.visibility = 'public' and s.status = 'published'
  order by p.created_at asc, p.id
  limit 1;

  select p.id into pull_2
  from public.pulls p
  join public.summaries s on s.id = p.summary_id and s.visibility = 'public' and s.status = 'published'
  where p.id <> pull_1
  order by p.created_at asc, p.id
  limit 1;

  if pull_1 is null or pull_2 is null then
    raise exception 'fixture setup: need at least 2 public pulls';
  end if;

  insert into auth.users (id, email)
  values
    (reader_a, 'reader_a_paths@example.com'),
    (reader_b, 'reader_b_paths@example.com'),
    (reader_c, 'reader_c_paths@example.com');

  -- Reader C's private summary: readable by C through `summary_is_readable`'s author
  -- clause, and by nobody else.
  insert into public.works (id, kind, title, slug, rights_status)
  values (priv_work, 'book', 'Reader C''s Own Notes', 'paths-test-private', 'user_owned');

  insert into public.summaries
    (id, work_id, version, status, visibility, author_id, title, published_at)
  values (priv_summary, priv_work, 1, 'published', 'private', reader_c,
          'Reader C''s Own Notes', now());

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (priv_summary, 1, 'A private idea', 'Only C can read this.', 5)
  returning id into pull_priv;

  -- A published path: read, apply, and a third step only reader C can see.
  insert into public.paths (id, slug, title, question, description, status)
  values (
    extensions.gen_random_uuid(),
    slug_pub,
    'How to master yourself',
    'What is actually up to you?',
    'A short test path on control and attention.',
    'published'
  )
  returning id into path_pub;

  insert into public.path_steps (path_id, ordinal, pull_id, kind, prompt)
  values
    (path_pub, 1, pull_1, 'read', 'Read the core claim'),
    (path_pub, 2, pull_2, 'apply', 'Name one thing today'),
    (path_pub, 3, pull_priv, 'read', 'A step behind a private summary');

  insert into public.paths (id, slug, title, question, description, status)
  values (
    extensions.gen_random_uuid(),
    slug_drf,
    'Draft Path',
    'Why is this draft?',
    'Not yet ready for readers.',
    'draft'
  )
  returning id into path_drf;

  insert into public.path_steps (path_id, ordinal, pull_id, kind)
  values (path_drf, 1, pull_1, 'read'),
         (path_drf, 2, pull_2, 'apply');

  -- A published path whose ONLY step is behind C's private summary.
  insert into public.paths (id, slug, title, question, description, status)
  values (
    extensions.gen_random_uuid(),
    slug_hid,
    'A path nobody can see',
    'What is on it?',
    'Every step is behind a private summary.',
    'published'
  )
  returning id into path_hid;

  insert into public.path_steps (path_id, ordinal, pull_id, kind)
  values (path_hid, 1, pull_priv, 'read');

  -- ---------------------------------------------------------------------------
  -- 2. Visibility, as reader A
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_a);

  select count(*) into n from public.paths where id = path_drf;
  if n <> 0 then
    raise exception 'draft path should not be visible under RLS, got %', n;
  end if;

  select count(*) into n from public.paths where id = path_pub;
  if n <> 1 then
    raise exception 'published path should be visible under RLS, got %', n;
  end if;

  paths_out := public.get_paths();
  if not (paths_out @> jsonb_build_array(jsonb_build_object('slug', slug_pub::text))) then
    raise exception 'get_paths() missing published path %', slug_pub;
  end if;
  if paths_out @> jsonb_build_array(jsonb_build_object('slug', slug_drf::text)) then
    raise exception 'get_paths() must not include draft path %', slug_drf;
  end if;

  path_out := public.get_path(slug_pub);
  if path_out is null or (path_out->>'title') is distinct from 'How to master yourself' then
    raise exception 'get_path(%) failed to return path: %', slug_pub, path_out;
  end if;

  -- The private step is not on reader A's screen, and the other two are.
  if jsonb_array_length(path_out->'steps') <> 2 then
    raise exception 'get_path(%) expected 2 readable steps, got %',
      slug_pub, jsonb_array_length(path_out->'steps');
  end if;
  if exists (
    select 1 from jsonb_array_elements(path_out->'steps') s where (s->>'ordinal')::int = 3
  ) then
    raise exception 'a step behind a summary reader A cannot read reached get_path';
  end if;

  -- Case-insensitive. `paths.slug` is citext; the function must compare it as citext.
  path_out := public.get_path('TEST-PATH-PUBLIC'::citext);
  if path_out is null or (path_out->>'id') is distinct from path_pub::text then
    raise exception
      'get_path is case-sensitive: TEST-PATH-PUBLIC did not find %. The slug is citext '
      'and the comparison fell through to text.', slug_pub;
  end if;

  if public.get_path(slug_drf) is not null then
    raise exception 'get_path returned a draft path';
  end if;

  -- The helpers are not a client's to call.
  code := null;
  begin
    perform public.readable_path_steps(path_pub);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception 'readable_path_steps is callable by a reader (got %)', coalesce(code, 'no error');
  end if;
  code := null;
  begin
    perform public.settle_path_progress(reader_a, path_pub);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception 'settle_path_progress is callable by a reader (got %)', coalesce(code, 'no error');
  end if;

  -- And the helper's own definition includes publication: a draft path has no
  -- readable steps even to the owner role, whose reads no policy filters.
  perform pg_temp.as_owner();
  select count(*) into n from public.readable_path_steps(path_drf);
  if n <> 0 then
    raise exception
      'readable_path_steps returned % step(s) of a draft path. The helper is missing '
      'the published half of the path_steps_read predicate.', n;
  end if;
  -- Two, not three: the owner role bypasses policies, but the helper still asks
  -- `summary_is_readable`, and with no JWT there is no author to match C's private
  -- summary against. The published half and the readable half are both in force.
  select count(*) into n from public.readable_path_steps(path_pub);
  if n <> 2 then
    raise exception 'readable_path_steps as owner expected the 2 public steps of the published path, got %', n;
  end if;
  perform pg_temp.become(reader_a);

  -- ---------------------------------------------------------------------------
  -- 3. Reader A walks the path with NO prior knowledge_states row
  -- ---------------------------------------------------------------------------
  select count(*) into n from public.knowledge_states where user_id = reader_a;
  if n <> 0 then
    raise exception 'fixture: reader A must start with no knowledge_states, has %', n;
  end if;

  -- Paused first, so the advance below has something to clear.
  perform public.pause_path(path_pub);
  select paused_at into paused
  from public.path_progress where user_id = reader_a and path_id = path_pub;
  if paused is null then
    raise exception 'pause_path did not set paused_at';
  end if;

  adv_out := public.advance_path(path_pub, 1::smallint);
  if not ((adv_out->>'ok')::boolean) or ((adv_out->>'completed')::boolean) then
    raise exception 'advance_path step 1 unexpected output: %', adv_out;
  end if;

  select count(*) into n
  from public.path_step_done
  where user_id = reader_a and path_id = path_pub and ordinal = 1 and tested_out = false;
  if n <> 1 then
    raise exception 'path_step_done ordinal 1 expected 1 row, got %', n;
  end if;

  -- Advancing resumes.
  select paused_at into paused
  from public.path_progress where user_id = reader_a and path_id = path_pub;
  if paused is not null then
    raise exception 'advance_path left paused_at set; the banner said advancing resumes';
  end if;

  -- THE IDEA ENTERED THE SCHEDULE. Asserted by presence.
  select ks.acquired_via, ks.next_due_at into via, due_after
  from public.knowledge_states ks
  where ks.user_id = reader_a and ks.pull_id = pull_1;
  if due_after is null then
    raise exception
      'advance_path did not put step 1''s idea into knowledge_states. The completion '
      'screen tells the reader every idea is in their review schedule.';
  end if;
  if via is distinct from 'read' then
    raise exception 'step 1''s idea was acquired via % rather than read', via;
  end if;

  -- pause / resume round-trip, unchanged from the first version of this file.
  perform public.pause_path(path_pub);
  select count(*) into n
  from public.path_progress
  where user_id = reader_a and path_id = path_pub and paused_at is not null;
  if n <> 1 then
    raise exception 'pause_path failed to set paused_at';
  end if;

  perform public.resume_path(path_pub);
  select count(*) into n
  from public.path_progress
  where user_id = reader_a and path_id = path_pub and paused_at is null;
  if n <> 1 then
    raise exception 'resume_path failed to clear paused_at';
  end if;

  -- The apply step, still with no knowledge_states row for its idea.
  select count(*) into n from public.knowledge_states where user_id = reader_a and pull_id = pull_2;
  if n <> 0 then
    raise exception 'fixture: reader A must not hold pull_2 before applying';
  end if;

  apply_out := public.apply_path_step(path_pub, 2::smallint, 'My reflection on control', mut_id);
  if not ((apply_out->>'ok')::boolean) or (apply_out->>'noteId') is null then
    raise exception 'apply_path_step unexpected output: %', apply_out;
  end if;
  if (apply_out->>'replayed')::boolean then
    raise exception 'a first apply reported itself as a replay: %', apply_out;
  end if;
  note_id := (apply_out->>'noteId')::uuid;

  select ks.next_due_at into due_after
  from public.knowledge_states ks
  where ks.user_id = reader_a and ks.pull_id = pull_2;
  if due_after is null then
    raise exception
      'apply_path_step did not put the applied idea into knowledge_states, so it will '
      'never come round in Review.';
  end if;
  if due_after > now() + interval '3 days' + interval '1 minute' then
    raise exception 'the applied idea is due at %, more than three days out', due_after;
  end if;

  select count(*) into n from public.notes
  where user_id = reader_a and pull_id = pull_2 and body = 'My reflection on control';
  if n <> 1 then
    raise exception 'apply_path_step wrote % note(s) rather than one', n;
  end if;

  -- Steps 1 and 2 are every step reader A can read, so the path is complete for A --
  -- the third step is behind a summary A cannot see and must not hold A hostage.
  select count(*) into n
  from public.path_progress
  where user_id = reader_a and path_id = path_pub and completed_at is not null;
  if n <> 1 then
    raise exception
      'the path is not complete for reader A after every readable step. A step the '
      'screen cannot show is being counted as owed.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 4. A replay returns the note it already wrote and changes nothing
  -- ---------------------------------------------------------------------------
  apply_out := public.apply_path_step(path_pub, 2::smallint, 'A DIFFERENT reflection', mut_id);
  if not ((apply_out->>'ok')::boolean) then
    raise exception 'replay of apply_path_step failed: %', apply_out;
  end if;
  if (apply_out->>'noteId')::uuid is distinct from note_id then
    raise exception 'replay returned note % rather than the original %',
      apply_out->>'noteId', note_id;
  end if;
  if not (apply_out->>'replayed')::boolean then
    raise exception 'a replay did not say it was one: %', apply_out;
  end if;

  select count(*) into n from public.notes where user_id = reader_a and client_mutation_id = mut_id;
  if n <> 1 then
    raise exception 'a replayed apply wrote a second note (% rows for the mutation id)', n;
  end if;
  select body into note_body from public.notes where id = note_id;
  if note_body is distinct from 'My reflection on control' then
    raise exception 'a replay rewrote the note to %', note_body;
  end if;

  -- ---------------------------------------------------------------------------
  -- 5. Reader B: isolation, and a refused apply writes nothing at all
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_b);

  select count(*) into n from public.path_progress;
  if n <> 0 then
    raise exception 'Reader B saw other reader progress: %', n;
  end if;

  select count(*) into n from public.path_step_done;
  if n <> 0 then
    raise exception 'Reader B saw other reader step done: %', n;
  end if;

  select count(*) into n from public.notes;
  if n <> 0 then
    raise exception 'Reader B saw another reader''s reflection: %', n;
  end if;

  -- B has done nothing yet, and every step below is undone for B -- so a mutant that
  -- advanced, scheduled or started progress before refusing has somewhere to show.
  if pg_temp.footprint(reader_b) <> 0 then
    raise exception 'fixture: reader B must have no footprint before the refusals';
  end if;

  -- Not an apply step.
  code := null;
  begin
    perform public.apply_path_step(path_pub, 1::smallint, 'A note on a read step', null);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '22023' then
    raise exception 'apply_path_step on a read step should raise 22023, got %', coalesce(code, 'nothing');
  end if;

  -- And the other direction: an apply step cannot be completed by advance_path, which
  -- would mark it done with no reflection and no three-day pull-forward.
  code := null;
  begin
    perform public.advance_path(path_pub, 2::smallint);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '22023' then
    raise exception 'advance_path on an apply step should raise 22023, got %', coalesce(code, 'nothing');
  end if;

  -- A draft path.
  code := null;
  begin
    perform public.apply_path_step(path_drf, 2::smallint, 'A note on a draft path', null);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from 'P0002' then
    raise exception 'apply_path_step on a draft path should raise P0002, got %', coalesce(code, 'nothing');
  end if;

  -- A step B cannot read.
  code := null;
  begin
    perform public.apply_path_step(path_pub, 3::smallint, 'A note on a hidden step', null);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from 'P0002' then
    raise exception 'apply_path_step on an unreadable step should raise P0002, got %', coalesce(code, 'nothing');
  end if;

  -- Blank: spaces, then tabs and newlines, which `btrim` alone would have let through.
  code := null;
  begin
    perform public.apply_path_step(path_pub, 2::smallint, '   ', null);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '22023' then
    raise exception 'a blank reflection should raise 22023, got %', coalesce(code, 'nothing');
  end if;

  code := null;
  begin
    perform public.apply_path_step(path_pub, 2::smallint, E'\n\t \r', null);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '22023' then
    raise exception
      'a reflection of tabs and newlines should raise 22023, got %. Blank means no '
      'non-whitespace character, not no space character.', coalesce(code, 'nothing');
  end if;

  -- Too long.
  code := null;
  begin
    perform public.apply_path_step(path_pub, 2::smallint, repeat('x', 20001), null);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '22023' then
    raise exception 'a 20001-character reflection should raise 22023, got %', coalesce(code, 'nothing');
  end if;

  if pg_temp.footprint(reader_b) <> 0 then
    raise exception
      'a refused apply left something behind for reader B (footprint %): a note, a '
      'step done, a schedule entry or a progress row was written before the refusal.',
      pg_temp.footprint(reader_b);
  end if;

  -- ---------------------------------------------------------------------------
  -- 6. Reader B: testing out does not rewrite a done step, and cannot finish a path
  --    with nothing readable on it
  -- ---------------------------------------------------------------------------
  -- B holds pull_1 solidly and has ALSO completed step 1 by walking it.
  perform pg_temp.as_owner();
  insert into public.knowledge_states (user_id, pull_id, stability, difficulty, last_seen_at, next_due_at)
  values (reader_b, pull_1, 50.0, 0.2, now(), now() + interval '50 days');
  perform pg_temp.become(reader_b);

  perform public.advance_path(path_pub, 1::smallint);

  test_out_res := public.test_out(path_pub);
  if not ((test_out_res->>'ok')::boolean) then
    raise exception 'test_out failed for Reader B: %', test_out_res;
  end if;
  if (test_out_res->'testedOutOrdinals') @> '[1]'::jsonb then
    raise exception 'test_out reported testing out of a step reader B had completed';
  end if;

  select count(*) into n
  from public.path_step_done
  where user_id = reader_b and path_id = path_pub and ordinal = 1 and tested_out = false;
  if n <> 1 then
    raise exception 'test_out rewrote a completed step as tested out';
  end if;

  -- Now B holds pull_2 solidly too: step 2 tests out, and that completes B's path.
  perform pg_temp.as_owner();
  insert into public.knowledge_states (user_id, pull_id, stability, difficulty, last_seen_at, next_due_at)
  values (reader_b, pull_2, 50.0, 0.2, now(), now() + interval '50 days');
  perform pg_temp.become(reader_b);

  test_out_res := public.test_out(path_pub);
  if not ((test_out_res->'testedOutOrdinals') @> '[2]'::jsonb) then
    raise exception 'Reader B expected to test out of ordinal 2, got %', test_out_res;
  end if;
  if not ((test_out_res->>'completed')::boolean) then
    raise exception 'testing out of the last readable step did not complete the path: %', test_out_res;
  end if;

  select count(*) into n
  from public.path_step_done
  where user_id = reader_b and path_id = path_pub and ordinal = 2 and tested_out = true;
  if n <> 1 then
    raise exception 'Reader B expected ordinal 2 tested out, got %', n;
  end if;

  -- A path with no readable step is not finished by testing out of nothing.
  test_out_res := public.test_out(path_hid);
  if (test_out_res->>'completed')::boolean then
    raise exception 'test_out completed a path reader B cannot see a single step of';
  end if;
  select count(*) into n
  from public.path_progress
  where user_id = reader_b and path_id = path_hid and completed_at is not null;
  if n <> 0 then
    raise exception 'a path with no readable step was stored as completed';
  end if;
  select e into row_out
  from jsonb_array_elements(public.get_paths()) e
  where e->>'id' = path_hid::text;
  if row_out is null then
    raise exception 'the hidden-step path is missing from get_paths';
  end if;
  if (row_out->>'stepCount')::int <> 0 or (row_out->>'completedAt') is not null then
    raise exception 'get_paths reports the hidden-step path as % steps, completed %',
      row_out->>'stepCount', row_out->>'completedAt';
  end if;

  -- ---------------------------------------------------------------------------
  -- 7. Reader C: an idea already scheduled is pulled forward, and the private step
  --    is both shown and owed to the one reader who can read it
  -- ---------------------------------------------------------------------------
  perform pg_temp.as_owner();
  insert into public.knowledge_states (user_id, pull_id, stability, difficulty, last_seen_at, next_due_at)
  values (reader_c, pull_2, 10.0, 0.3, now() - interval '1 day', now() + interval '10 days');
  perform pg_temp.become(reader_c);

  path_out := public.get_path(slug_pub);
  if jsonb_array_length(path_out->'steps') <> 3 then
    raise exception 'reader C, who authored the private summary, should see 3 steps, got %',
      jsonb_array_length(path_out->'steps');
  end if;

  select next_due_at into due_before
  from public.knowledge_states where user_id = reader_c and pull_id = pull_2;

  apply_out := public.apply_path_step(path_pub, 2::smallint, 'C''s reflection', null);
  if not ((apply_out->>'ok')::boolean) then
    raise exception 'apply_path_step failed for reader C: %', apply_out;
  end if;

  select next_due_at into due_after
  from public.knowledge_states where user_id = reader_c and pull_id = pull_2;
  if due_after is null then
    raise exception 'reader C''s knowledge_states row for pull_2 vanished';
  end if;
  if due_after > now() + interval '3 days' + interval '1 minute' then
    raise exception 'apply_path_step did not pull the due date forward: before=%, after=%',
      due_before, due_after;
  end if;
  if due_after >= due_before then
    raise exception 'the due date was not moved earlier: before=%, after=%', due_before, due_after;
  end if;

  -- Two of C's three readable steps remain, so C's path is not complete.
  select count(*) into n
  from public.path_progress
  where user_id = reader_c and path_id = path_pub and completed_at is not null;
  if n <> 0 then
    raise exception
      'reader C''s path completed with steps 1 and 3 undone. The remaining count is '
      'not counting the steps this reader can read.';
  end if;

  perform public.advance_path(path_pub, 1::smallint);
  adv_out := public.advance_path(path_pub, 3::smallint);
  if not ((adv_out->>'completed')::boolean) then
    raise exception 'reader C''s path did not complete after every readable step: %', adv_out;
  end if;

  -- And reader A, for whom step 3 does not exist, cannot advance it.
  perform pg_temp.become(reader_a);
  code := null;
  begin
    perform public.advance_path(path_pub, 3::smallint);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from 'P0002' then
    raise exception 'reader A advanced a step behind a summary they cannot read (got %)',
      coalesce(code, 'no error');
  end if;

  -- ---------------------------------------------------------------------------
  -- 8. Anon
  -- ---------------------------------------------------------------------------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);

  paths_out := public.get_paths();
  if jsonb_array_length(paths_out) = 0 then
    raise exception 'anon expected to see published paths in get_paths()';
  end if;

  path_out := public.get_path('Test-Path-Public'::citext);
  if path_out is null or jsonb_array_length(path_out->'steps') <> 2 then
    raise exception 'anon get_path with a mixed-case slug: %', path_out;
  end if;

  refused := false;
  begin
    perform public.advance_path(path_pub, 1::smallint);
  exception when others then
    if sqlstate in ('28000', '42501') then
      refused := true;
    end if;
  end;
  if not refused then
    raise exception 'anon advance_path should raise 28000 or 42501';
  end if;

  refused := false;
  begin
    perform public.apply_path_step(path_pub, 2::smallint, 'anon reflection', null);
  exception when others then
    if sqlstate in ('28000', '42501') then
      refused := true;
    end if;
  end;
  if not refused then
    raise exception 'anon apply_path_step should raise 28000 or 42501';
  end if;

  -- ---------------------------------------------------------------------------
  -- 9. A step that becomes readable later reopens the path; one hidden later does
  --    not overcount
  -- ---------------------------------------------------------------------------
  -- Reader A finished the path in section 3 with step 3 hidden. C's summary is now
  -- published, so A can read step 3 and owes it: the stored timestamp must not be
  -- reported while a readable step is undone, and the next write must clear it.
  perform pg_temp.as_owner();
  update public.summaries set visibility = 'public' where id = priv_summary;
  perform pg_temp.become(reader_a);

  path_out := public.get_path(slug_pub);
  if jsonb_array_length(path_out->'steps') <> 3 then
    raise exception 'after publication reader A should see 3 steps, got %',
      jsonb_array_length(path_out->'steps');
  end if;
  if (path_out->>'completedAt') is not null then
    raise exception
      'get_path reports the path complete while a readable step is undone. The screen '
      'would show "Completed" over a step it never rendered.';
  end if;

  select e into row_out
  from jsonb_array_elements(public.get_paths()) e
  where e->>'id' = path_pub::text;
  if (row_out->>'completedAt') is not null then
    raise exception 'get_paths reports the path complete while a readable step is undone';
  end if;
  if (row_out->>'stepCount')::int <> 3 or (row_out->>'completedSteps')::int <> 2 then
    raise exception 'get_paths after publication: expected 2 of 3, got % of %',
      row_out->>'completedSteps', row_out->>'stepCount';
  end if;

  -- The write side: a test_out with nothing to test out of recomputes completion.
  test_out_res := public.test_out(path_pub);
  if (test_out_res->>'completed')::boolean then
    raise exception 'test_out reported a path complete with a readable step undone: %', test_out_res;
  end if;
  select count(*) into n
  from public.path_progress
  where user_id = reader_a and path_id = path_pub and completed_at is null;
  if n <> 1 then
    raise exception 'a write with a readable step undone left the stored completed_at set';
  end if;

  adv_out := public.advance_path(path_pub, 3::smallint);
  if not ((adv_out->>'completed')::boolean) then
    raise exception 'reader A''s path did not complete after the reopened step: %', adv_out;
  end if;
  path_out := public.get_path(slug_pub);
  if (path_out->>'completedAt') is null then
    raise exception 'get_path withholds completedAt from a path with every readable step done';
  end if;

  -- While it is readable, A also finishes the path whose only step is behind it.
  adv_out := public.advance_path(path_hid, 1::smallint);
  if not ((adv_out->>'completed')::boolean) then
    raise exception 'reader A did not complete the one-step path while its step was readable';
  end if;

  -- And back: C's summary is withdrawn again. A did step 3 while it was readable, and
  -- that done row must not count against a total that no longer includes the step.
  perform pg_temp.as_owner();
  update public.summaries set visibility = 'private' where id = priv_summary;
  perform pg_temp.become(reader_a);

  -- The one-step path now has NO readable step for A. Its stored completed_at is
  -- what settle_path_progress would take back on the next write, so neither RPC may
  -- report it: the list would say Completed and the screen would render the
  -- completion copy over zero ideas.
  select e into row_out
  from jsonb_array_elements(public.get_paths()) e
  where e->>'id' = path_hid::text;
  if (row_out->>'stepCount')::int <> 0 or (row_out->>'completedAt') is not null then
    raise exception
      'get_paths reports a path with no readable step as completed (% steps, completedAt %)',
      row_out->>'stepCount', row_out->>'completedAt';
  end if;
  path_out := public.get_path(slug_hid);
  if jsonb_array_length(path_out->'steps') <> 0 or (path_out->>'completedAt') is not null then
    raise exception
      'get_path reports a path with no readable step as completed (% steps, completedAt %)',
      jsonb_array_length(path_out->'steps'), path_out->>'completedAt';
  end if;

  select e into row_out
  from jsonb_array_elements(public.get_paths()) e
  where e->>'id' = path_pub::text;
  if (row_out->>'stepCount')::int <> 2 or (row_out->>'completedSteps')::int <> 2 then
    raise exception
      'get_paths after withdrawal: expected 2 of 2, got % of %. completedSteps is '
      'counting a done row for a step the total no longer includes.',
      row_out->>'completedSteps', row_out->>'stepCount';
  end if;
  if (row_out->>'completedAt') is null then
    raise exception 'get_paths withholds completedAt from a path with every readable step done';
  end if;

  raise notice 'paths.sql: a path step enters the review schedule, a replay stops at its note, a refusal writes nothing, a done step stays done, a slug reads either case, an unreadable step is neither shown nor owed, a step readable later reopens the path, an empty path cannot be finished, and nobody sees another reader''s walk';
end $$;

rollback;
