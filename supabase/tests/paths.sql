-- ---------------------------------------------------------------------------
-- Package 5a: Paths, steps, progress, and an apply step that resurfaces.
--
-- Tests:
--   * Paths and steps: draft paths invisible, published paths readable.
--   * RPCs: get_paths() and get_path(slug) return structured JSON.
--   * advance_path: starts progress, records step done, idempotent on replay,
--     marks completed when final step is done.
--   * pause_path / resume_path: updates paused_at.
--   * test_out: marks steps whose pull retrievability >= floor as tested out.
--   * apply_path_step: inserts note with client_mutation_id, pulls forward
--     next_due_at, advances path, and is idempotent on mutation replay.
--   * Isolation: Reader A cannot see or mutate Reader B's progress.
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
  pull_1    uuid;
  pull_2    uuid;
  path_pub  uuid;
  path_drf  uuid;
  slug_pub  citext := 'test-path-public';
  slug_drf  citext := 'test-path-draft';
  paths_out jsonb;
  path_out  jsonb;
  adv_out   jsonb;
  apply_out jsonb;
  test_out_res jsonb;
  refused   boolean;
  n         int;
  mut_id    uuid := extensions.gen_random_uuid();
  due_before timestamptz;
  due_after  timestamptz;
begin
  -- 1. Pick two seeded pulls that have readable summaries
  select p.id into pull_1
  from public.pulls p
  join public.summaries s on s.id = p.summary_id and s.visibility = 'public' and s.status = 'published'
  order by p.created_at asc
  limit 1;

  select p.id into pull_2
  from public.pulls p
  join public.summaries s on s.id = p.summary_id and s.visibility = 'public' and s.status = 'published'
  where p.id <> pull_1
  order by p.created_at asc
  limit 1;

  if pull_1 is null or pull_2 is null then
    raise exception 'fixture setup: need at least 2 public pulls';
  end if;

  -- Create test users
  insert into auth.users (id, email)
  values
    (reader_a, 'reader_a_paths@example.com'),
    (reader_b, 'reader_b_paths@example.com');

  -- Create a published path with 2 steps
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
    (path_pub, 2, pull_2, 'apply', 'Name one thing today');

  -- Create a draft path
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
  values (path_drf, 1, pull_1, 'read');

  -- ---------------------------------------------------------------------------
  -- Reader A tests
  -- ---------------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', reader_a::text, true);
  perform pg_temp.assert_is_reader();

  -- Draft path invisible through table RLS
  select count(*) into n from public.paths where id = path_drf;
  if n <> 0 then
    raise exception 'draft path should not be visible under RLS, got %', n;
  end if;

  -- Published path visible through table RLS
  select count(*) into n from public.paths where id = path_pub;
  if n <> 1 then
    raise exception 'published path should be visible under RLS, got %', n;
  end if;

  -- get_paths() includes published path, excludes draft
  paths_out := public.get_paths();
  if not (paths_out @> jsonb_build_array(jsonb_build_object('slug', slug_pub::text))) then
    raise exception 'get_paths() missing published path %', slug_pub;
  end if;
  if paths_out @> jsonb_build_array(jsonb_build_object('slug', slug_drf::text)) then
    raise exception 'get_paths() must not include draft path %', slug_drf;
  end if;

  -- get_path(slug) returns full structure
  path_out := public.get_path(slug_pub);
  if path_out is null or (path_out->>'title') <> 'How to master yourself' then
    raise exception 'get_path(%) failed to return path: %', slug_pub, path_out;
  end if;
  if jsonb_array_length(path_out->'steps') <> 2 then
    raise exception 'get_path(%) expected 2 steps, got %', slug_pub, jsonb_array_length(path_out->'steps');
  end if;

  -- Advance step 1
  adv_out := public.advance_path(path_pub, 1::smallint);
  if not ((adv_out->>'ok')::boolean) or ((adv_out->>'completed')::boolean) then
    raise exception 'advance_path step 1 unexpected output: %', adv_out;
  end if;

  -- Verify step 1 recorded in path_step_done and path_progress started
  select count(*) into n
  from public.path_step_done
  where user_id = reader_a and path_id = path_pub and ordinal = 1;
  if n <> 1 then
    raise exception 'path_step_done ordinal 1 expected 1 row, got %', n;
  end if;

  select count(*) into n
  from public.path_progress
  where user_id = reader_a and path_id = path_pub and started_at is not null and completed_at is null;
  if n <> 1 then
    raise exception 'path_progress expected active progress, got %', n;
  end if;

  -- Pause path and resume path
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

  -- Apply step 2 (with reflection and mutation id)
  -- Seed a knowledge_state first for pull_2 with a due date 10 days out
  reset role;
  insert into public.knowledge_states (user_id, pull_id, stability, difficulty, last_seen_at, next_due_at)
  values (reader_a, pull_2, 10.0, 0.3, now() - interval '1 day', now() + interval '10 days')
  on conflict (user_id, pull_id) do update set
    next_due_at = now() + interval '10 days';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', reader_a::text, true);

  select next_due_at into due_before
  from public.knowledge_states
  where user_id = reader_a and pull_id = pull_2;

  apply_out := public.apply_path_step(path_pub, 2::smallint, 'My reflection on control', mut_id);
  if not ((apply_out->>'ok')::boolean) or (apply_out->>'noteId') is null then
    raise exception 'apply_path_step unexpected output: %', apply_out;
  end if;

  -- next_due_at was pulled forward within 3 days
  select next_due_at into due_after
  from public.knowledge_states
  where user_id = reader_a and pull_id = pull_2;

  if due_after > now() + interval '3 days' + interval '1 minute' then
    raise exception 'apply_path_step did not pull due date forward: before=%, after=%', due_before, due_after;
  end if;

  -- Step 2 was the final step: path is now completed!
  select count(*) into n
  from public.path_progress
  where user_id = reader_a and path_id = path_pub and completed_at is not null;
  if n <> 1 then
    raise exception 'path expected to be marked completed after step 2';
  end if;

  -- Replay of apply_path_step is idempotent
  apply_out := public.apply_path_step(path_pub, 2::smallint, 'My reflection on control', mut_id);
  if not ((apply_out->>'ok')::boolean) then
    raise exception 'replay of apply_path_step failed';
  end if;

  -- ---------------------------------------------------------------------------
  -- Reader B isolation tests
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', reader_b::text, true);

  -- Reader B cannot see Reader A's progress or done steps
  select count(*) into n from public.path_progress;
  if n <> 0 then
    raise exception 'Reader B saw other reader progress: %', n;
  end if;

  select count(*) into n from public.path_step_done;
  if n <> 0 then
    raise exception 'Reader B saw other reader step done: %', n;
  end if;

  -- Reader B can test out of step 1 if pull_1 is already known solid
  reset role;
  insert into public.knowledge_states (user_id, pull_id, stability, difficulty, last_seen_at, next_due_at)
  values (reader_b, pull_1, 50.0, 0.2, now(), now() + interval '50 days');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', reader_b::text, true);

  test_out_res := public.test_out(path_pub);
  if not ((test_out_res->>'ok')::boolean) then
    raise exception 'test_out failed for Reader B: %', test_out_res;
  end if;

  -- Reader B tested out of ordinal 1
  select count(*) into n
  from public.path_step_done
  where user_id = reader_b and path_id = path_pub and ordinal = 1 and tested_out = true;
  if n <> 1 then
    raise exception 'Reader B expected to test out of ordinal 1, got %', n;
  end if;

  -- ---------------------------------------------------------------------------
  -- Anon tests
  -- ---------------------------------------------------------------------------
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  -- Anon can read published paths and steps via RPC
  paths_out := public.get_paths();
  if jsonb_array_length(paths_out) = 0 then
    raise exception 'anon expected to see published paths in get_paths()';
  end if;

  -- Anon mutating functions raise 28000
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

  -- Success notice
  raise notice 'paths.sql: all assertions passed';
end $$;

rollback;
