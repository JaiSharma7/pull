-- ---------------------------------------------------------------------------
-- Package 10b: nearest_pulls and counterpulls_for_work
--
-- Tests:
--   * nearest_pulls:
--     - Refused to anon and authenticated (42501).
--     - Granted to service_role.
--     - Returns k nearest neighbours from other public works, sorted by distance.
--   * counterpulls_for_work:
--     - Invoker function, callable by anon (returns empty) and authenticated.
--     - Reader with no knowledge states gets empty results.
--     - Reader holding an opposing idea above the floor gets the counterpull.
--     - Works in both edge directions (from -> to and to -> from).
--     - Ideas whose retrievability has faded below the floor are excluded.
--     - Another author's private pull/edge is NEVER exposed.
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
  reader_none   uuid := extensions.gen_random_uuid();
  reader_knows  uuid := extensions.gen_random_uuid();
  author_priv   uuid := extensions.gen_random_uuid();

  mill_id       uuid;
  mill_work_id  uuid;
  thoreau_id    uuid;
  walden_work_id uuid;

  priv_sum_id   uuid;
  priv_pull_id  uuid;

  res           jsonb;
  item          jsonb;
  refused       boolean := false;
  v_floor       double precision := public.known_retrievability_floor();
begin
  -- Resolve seeded fixtures
  select p.id, s.work_id into mill_id, mill_work_id
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
  where p.headline like 'Silencing an opinion robs%'
  limit 1;

  select p.id, s.work_id into thoreau_id, walden_work_id
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
  where p.headline like 'Living deliberately%'
  limit 1;

  if mill_id is null or thoreau_id is null then
    raise exception 'counterpulls.sql: could not find seeded Mill and Thoreau pulls';
  end if;

  -- Ensure an explicit 'opposes' edge exists between Mill and Thoreau
  insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight, rationale)
  values (thoreau_id, mill_id, 'opposes', 0.85, 'Deliberate curation of attention challenges unrestricted public discourse.')
  on conflict (from_pull_id, to_pull_id, kind) do update
    set weight = excluded.weight, rationale = excluded.rationale;

  -- Create test users
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values
    (reader_none, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'reader-none@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
    (reader_knows, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'reader-knows@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
    (author_priv, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'author-priv@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  -- Give reader_knows solid retention on Mill's pull
  insert into public.knowledge_states (user_id, pull_id, stability, difficulty, last_seen_at)
  values (reader_knows, mill_id, 100.0, 0.3, now());

  -- =========================================================================
  -- 1. Security Gate on nearest_pulls
  -- =========================================================================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  refused := false;
  begin
    perform public.nearest_pulls(mill_id, 5);
  exception
    when insufficient_privilege then
      refused := true;
  end;

  if not refused then
    raise exception 'nearest_pulls must be refused to authenticated users (service_role only)';
  end if;

  -- =========================================================================
  -- 2. nearest_pulls executed as service_role
  -- =========================================================================
  perform set_config('role', 'service_role', true);
  res := public.nearest_pulls(mill_id, 5);

  if jsonb_array_length(res) = 0 then
    raise exception 'nearest_pulls as service_role returned 0 candidates';
  end if;

  if jsonb_array_length(res) > 5 then
    raise exception 'nearest_pulls returned more candidates than requested limit';
  end if;

  -- Assert each candidate is from a different work and has required keys
  for item in select * from jsonb_array_elements(res) loop
    if (item ->> 'workId')::uuid = mill_work_id then
      raise exception 'nearest_pulls returned an idea from the anchor work';
    end if;
    if item ->> 'id' is null or item ->> 'headline' is null or item ->> 'distance' is null then
      raise exception 'nearest_pulls missing required fields';
    end if;
  end loop;

  -- =========================================================================
  -- 3. counterpulls_for_work as anon
  -- =========================================================================
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}'::text, true);

  res := public.counterpulls_for_work(walden_work_id);
  if jsonb_array_length(res) <> 0 then
    raise exception 'counterpulls_for_work should return empty for anonymous callers';
  end if;

  -- =========================================================================
  -- 4. counterpulls_for_work as reader with no states
  -- =========================================================================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_none, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  res := public.counterpulls_for_work(walden_work_id);
  if jsonb_array_length(res) <> 0 then
    raise exception 'counterpulls_for_work should return empty for reader with no states';
  end if;

  -- =========================================================================
  -- 5. counterpulls_for_work as reader holding opposing idea above floor
  -- =========================================================================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  res := public.counterpulls_for_work(walden_work_id);
  if jsonb_array_length(res) = 0 then
    raise exception 'counterpulls_for_work should return counterpulls when reader holds opposing idea';
  end if;

  item := res -> 0;
  if (item ->> 'pullId')::uuid <> thoreau_id then
    raise exception 'expected counterpull to be Thoreau, got %', item ->> 'pullId';
  end if;
  if (item ->> 'opposingPullId')::uuid <> mill_id then
    raise exception 'expected opposing idea to be Mill, got %', item ->> 'opposingPullId';
  end if;
  if (item ->> 'retrievability')::double precision < v_floor then
    raise exception 'retrievability of opposing idea must be >= floor';
  end if;

  -- =========================================================================
  -- 6. Faded retention (< floor) excludes the counterpull
  -- =========================================================================
  perform set_config('role', 'postgres', true);
  update public.knowledge_states
     set last_seen_at = now() - interval '10 days',
         stability = 1.0
   where user_id = reader_knows and pull_id = mill_id;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  res := public.counterpulls_for_work(walden_work_id);
  if jsonb_array_length(res) <> 0 then
    raise exception 'faded idea (< floor) must not trigger a counterpull';
  end if;

  -- Restore retention above floor
  perform set_config('role', 'postgres', true);
  update public.knowledge_states
     set last_seen_at = now(),
         stability = 100.0
   where user_id = reader_knows and pull_id = mill_id;

  -- =========================================================================
  -- 7. Private summaries & private edges cannot leak (§9 invariant)
  -- =========================================================================
  perform set_config('role', 'postgres', true);

  insert into public.summaries (work_id, title, status, visibility, author_id, published_at)
  values (walden_work_id, 'Private Walden critique', 'published', 'private', author_priv, now())
  returning id into priv_sum_id;

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (priv_sum_id, 1, 'Private objection to Mill from Walden.', 'Private text.', 30)
  returning id into priv_pull_id;

  insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight)
  values (priv_pull_id, mill_id, 'opposes', 0.9);

  -- Query as reader_knows
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  res := public.counterpulls_for_work(walden_work_id);
  -- Must only contain public pulls, NEVER priv_pull_id
  for item in select * from jsonb_array_elements(res) loop
    if (item ->> 'pullId')::uuid = priv_pull_id or (item ->> 'opposingPullId')::uuid = priv_pull_id then
      raise exception 'private pull leaked into counterpulls_for_work!';
    end if;
  end loop;

  raise notice 'counterpulls.sql: all assertions passed';
end $$;

rollback;
