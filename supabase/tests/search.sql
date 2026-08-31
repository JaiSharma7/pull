-- Search, exercised as a real reader through the same RLS the browser gets.
--
-- Two of these assertions are about product behaviour rather than security, and
-- they are the reason this file exists at all:
--
--   * THE DELTA MUST NOT FILTER SEARCH. Dropping a result because the reader
--     already knows it would mean the app refuses to find something they read
--     last week. The Delta decides what to serve unbidden; it has no business
--     deciding what may be looked for. Known results are annotated and returned.
--   * SEARCH IS DETERMINISTIC. The feed is supposed to vary between sittings --
--     that is what the seeded jitter is for. A search that reorders between two
--     identical queries is broken, and nothing else in the read path would
--     notice.
--
-- The rest is the usual RLS question: another author's private material must be
-- unfindable, not merely unranked.
--
-- Read-only in effect: everything below rolls back.
--
-- ON_ERROR_STOP is set here as well as on the command line because without it
-- psql exits 0 even when an assertion raises, which would give a silent green
-- from a file whose whole purpose is to fail loudly.
\set ON_ERROR_STOP on

begin;

-- Refuses to let an assertion run with owner rights. A stray `set role postgres`
-- that outlives its section would turn every check below into a superuser query
-- that proves nothing, and would do it silently.
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
  reader_knows uuid := extensions.gen_random_uuid();  -- knows the Mill pull
  reader_blank uuid := extensions.gen_random_uuid();  -- knows nothing
  author_id    uuid := extensions.gen_random_uuid();  -- owns a private summary
  signup_id    uuid;
  mill_id      uuid;
  private_summary_id uuid;
  private_pull_id    uuid;
  -- A token that cannot occur in the public-domain corpus, so a hit on it is
  -- proof of a leak rather than a coincidence.
  secret_token text := 'zqxjvwk';
  res      jsonb;
  res_again jsonb;
  related  jsonb;
  found    boolean;
begin
  select p.id into strict mill_id
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
  join public.works w on w.id = s.work_id
  where w.slug = 'on-liberty' and p.headline like 'Silencing an opinion%';

  -- Two signups, through auth.users so handle_new_user creates the rows the
  -- read path expects.
  foreach signup_id in array array[reader_knows, reader_blank, author_id] loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values (signup_id, '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated',
            'search-' || left(signup_id::text, 8) || '@example.test', '',
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  end loop;

  -- Stability 100 with last_seen_at now() puts retrievability comfortably above
  -- the 0.7 floor, so this counts as known by the same test the read path uses.
  insert into public.knowledge_states (user_id, pull_id, stability, last_seen_at)
  values (reader_knows, mill_id, 100, now());

  -- Another author's private summary, on a work that is otherwise public. The
  -- token is in the headline AND the body, so both the 'A' and 'B' weights of
  -- the generated tsvector would match it.
  insert into public.summaries (work_id, title, status, visibility, author_id,
                                published_at)
  select w.id, 'Private note ' || secret_token, 'published', 'private', author_id, now()
  from public.works w where w.slug = 'on-liberty'
  returning id into strict private_summary_id;

  insert into public.pulls (summary_id, ordinal, headline, body, embedding,
                            estimated_read_seconds)
  select private_summary_id, 1,
         'A private objection ' || secret_token,
         'Visible only to its author ' || secret_token,
         (select embedding from public.pulls where id = mill_id), 30
  returning id into strict private_pull_id;

  -- ---------------------------------------------------- 1. search finds things
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_blank, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  res := public.search_catalogue('opinion', 20, 10);
  if coalesce((res -> 'counts' ->> 'ideas')::int, 0) = 0 then
    raise exception
      'search returned nothing for a word that is in the seeded corpus. '
      'Either the tsvector column is not populated or the RPC cannot read it. '
      'Got: %', res;
  end if;

  -- ------------------------------- 2. a known idea is annotated, never dropped
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  res := public.search_catalogue('opinion', 20, 10);

  if not exists (
    select 1 from jsonb_array_elements(res -> 'ideas') i
    where (i ->> 'id')::uuid = mill_id
  ) then
    raise exception
      'search hid an idea the reader already knows. The Delta decides what to '
      'serve unbidden, not what may be looked for -- a reader must be able to '
      'find something they read last week.';
  end if;

  select (i ->> 'alreadyKnown')::boolean into found
  from jsonb_array_elements(res -> 'ideas') i
  where (i ->> 'id')::uuid = mill_id;

  if not coalesce(found, false) then
    raise exception
      'a known idea was returned without the alreadyKnown annotation, so the '
      'reader cannot tell it apart from something new.';
  end if;

  -- The same idea, for a reader who knows nothing, must NOT be annotated --
  -- otherwise the flag is a constant rather than a fact about this reader.
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_blank, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  res := public.search_catalogue('opinion', 20, 10);
  select (i ->> 'alreadyKnown')::boolean into found
  from jsonb_array_elements(res -> 'ideas') i
  where (i ->> 'id')::uuid = mill_id;

  if coalesce(found, true) then
    raise exception
      'alreadyKnown was true for a reader with no knowledge_states row, so it '
      'is not reading this reader''s memory at all.';
  end if;

  -- ------------------------------------- 3. private material is not findable
  res := public.search_catalogue(secret_token, 20, 10);

  if coalesce((res -> 'counts' ->> 'ideas')::int, 0) <> 0 then
    raise exception
      'another author''s private pull was findable by search. summary_is_readable '
      'is not reaching the search path. Got: %', res;
  end if;
  if coalesce((res -> 'counts' ->> 'sources')::int, 0) <> 0 then
    raise exception
      'a private summary leaked its work into the sources list. A work is only '
      'a result because something readable sits behind it.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(res -> 'alsoClose') a
    where (a ->> 'id')::uuid = private_pull_id
  ) then
    raise exception
      'the vector expansion returned a private pull. The centroid path must be '
      'filtered by the same predicate as the lexical path.';
  end if;

  -- ------------------------------------------------------- 4. deterministic
  res       := public.search_catalogue('opinion', 5, 3);
  res_again := public.search_catalogue('opinion', 5, 3);
  if res is distinct from res_again then
    raise exception
      'two identical searches returned different results. Search must be '
      'deterministic -- the feed is the surface that is allowed to vary.';
  end if;

  -- ------------------------------------------- 5. hostile input does not raise
  -- `to_tsquery` raises 42601 on several of these. `websearch_to_tsquery` does
  -- not, which is the entire reason the RPC uses it -- so this section is
  -- guarding a specific decision, not being defensive in general.
  perform public.search_catalogue('a & & b ""');
  perform public.search_catalogue('!!! ??? &&&');
  perform public.search_catalogue('''unbalanced');
  perform public.search_catalogue(null);
  perform public.search_catalogue(repeat('z ', 2000));

  if (public.search_catalogue('x') ->> 'tooShort')::boolean is not true then
    raise exception 'a one-character query was not reported as too short.';
  end if;
  if (public.search_catalogue('opinion') ->> 'tooShort')::boolean is not false then
    raise exception 'a real query was reported as too short.';
  end if;

  -- --------------------------------------------------------- 6. related_pulls
  -- An anchor the reader cannot read must yield nothing, and must not raise --
  -- raising would confirm the id exists.
  if public.related_pulls(private_pull_id, 6) is distinct from '[]'::jsonb then
    raise exception
      'related_pulls returned neighbours for a pull the reader cannot read.';
  end if;

  related := public.related_pulls(mill_id, 6);

  if (select count(*) <> count(distinct r ->> 'workId')
      from jsonb_array_elements(related) r) then
    raise exception
      'related_pulls returned two ideas from the same source. Six ideas from '
      'one book is the same result six times, not an expansion.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(related) r
    where (r ->> 'id')::uuid = private_pull_id
  ) then
    raise exception 'related_pulls surfaced another author''s private pull.';
  end if;

  raise notice 'SEARCH OK: finds seeded ideas, annotates what the reader knows '
               'without hiding it, keeps private material unfindable, is '
               'deterministic, survives hostile input, and never repeats a source';
end $$;

rollback;
