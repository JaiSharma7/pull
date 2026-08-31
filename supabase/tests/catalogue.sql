-- The catalogue, exercised as a real reader through the same RLS the browser gets.
--
-- Most of what can go wrong here is arithmetic rather than access control, and
-- the arithmetic is the kind that looks right until the corpus grows:
--
--   * A parent topic must count its children's sources as well as its own, and
--     must not double-count a work tagged to both. Getting this wrong makes the
--     catalogue page and the topic page disagree about the same topic, which is
--     the specific failure that makes a count worse than no count.
--   * A limit must bound the LIST without bounding the COUNT. Law 7 says the
--     page states how much there is; if the limit truncates the total too, the
--     screen can only ever say "showing all of what I showed you".
--   * A topic with nothing readable behind it is not a topic a reader can open.
--
-- And one that is access control: a work whose only summary is private must not
-- appear in a topic, because `works_read_all` is `using (true)` and the join
-- goes through `work_topics`, not through `summaries`.
--
-- Read-only in effect: everything below rolls back.
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
  reader      uuid := extensions.gen_random_uuid();
  author_id   uuid := extensions.gen_random_uuid();
  signup_id   uuid;
  private_work_id    uuid;
  private_summary_id uuid;
  ethics_id   uuid;
  cat  jsonb;
  top  jsonb;
  before_sources int;
  before_total   int;
begin
  foreach signup_id in array array[reader, author_id] loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values (signup_id, '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated',
            'catalogue-' || left(signup_id::text, 8) || '@example.test', '',
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  end loop;

  select t.id into strict ethics_id from public.topics t where t.slug = 'ethics';

  -- ---------------------------------------------------- 1. shape and totals
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  cat := public.get_catalogue();

  before_total := (cat -> 'totals' ->> 'sources')::int;
  if coalesce(before_total, 0) = 0 then
    raise exception 'the catalogue reports an empty library on a seeded database.';
  end if;
  if jsonb_array_length(cat -> 'parents') = 0 then
    raise exception 'the catalogue returned no parent topics.';
  end if;

  -- ------------------------------- 2. no topic is offered with nothing behind it
  if exists (
    select 1 from jsonb_array_elements(cat -> 'parents') p
    where (p ->> 'sources')::int = 0
  ) then
    raise exception
      'a parent topic with no readable sources was offered. `works_read_all` is '
      '`using (true)`, so a topic is only openable when something published and '
      'public sits behind it.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(cat -> 'parents') p,
                  jsonb_array_elements(p -> 'children') c
    where (c ->> 'sources')::int = 0
  ) then
    raise exception 'a child topic with no readable sources was offered.';
  end if;

  -- --------------------------------- 3. a parent is never smaller than a child
  if exists (
    select 1 from jsonb_array_elements(cat -> 'parents') p,
                  jsonb_array_elements(p -> 'children') c
    where (c ->> 'sources')::int > (p ->> 'sources')::int
  ) then
    raise exception
      'a child reports more sources than its parent, so the parent is not '
      'counting its children. Opening it would list fewer works than the '
      'catalogue just promised.';
  end if;

  -- ------------------------- 4. the two functions agree about the same topic
  top := public.get_topic('ethics', 200);
  if top is null then
    raise exception 'get_topic returned nothing for a topic the catalogue lists.';
  end if;
  if (top -> 'counts' ->> 'sources')::int <> (
       select (c ->> 'sources')::int
       from jsonb_array_elements(cat -> 'parents') p,
            jsonb_array_elements(p -> 'children') c
       where c ->> 'slug' = 'ethics')
  then
    raise exception
      'the catalogue and the topic page disagree about how many sources Ethics '
      'has. A count that contradicts itself across two screens is worse than no '
      'count at all.';
  end if;

  -- ------------------------------ 5. the limit bounds the list, not the count
  before_sources := (top -> 'counts' ->> 'sources')::int;
  if before_sources > 1 then
    top := public.get_topic('ethics', 1);
    if jsonb_array_length(top -> 'sources') <> 1 then
      raise exception 'get_topic ignored its limit.';
    end if;
    if (top -> 'counts' ->> 'sources')::int <> before_sources then
      raise exception
        'the limit truncated the total as well as the list, so the page can '
        'never say how many it is not showing.';
    end if;
    if (top -> 'counts' ->> 'shown')::int <> 1 then
      raise exception 'counts.shown does not describe the list that came back.';
    end if;
  end if;

  -- ------------------------------------------- 6. lookups that must return null
  if public.get_topic('no-such-topic-anywhere') is not null then
    raise exception 'an unknown slug returned a page.';
  end if;
  if public.get_topic(null) is not null then
    raise exception 'a null slug returned a page.';
  end if;
  if public.get_topic('') is not null then
    raise exception 'an empty slug returned a page.';
  end if;
  -- Case and surrounding space are a URL's business, not a reason to 404.
  if public.get_topic('ETHICS') is null then
    raise exception 'slug lookup is case sensitive; /topic/Ethics would 404.';
  end if;
  if public.get_topic('  ethics  ') is null then
    raise exception 'slug lookup does not trim.';
  end if;

  -- --------------------------- 7. a private work never enters the catalogue
  perform set_config('role', 'postgres', true);

  insert into public.works (kind, title, slug, rights_status)
  values ('essay', 'A private essay', 'a-private-essay-test', 'public_domain')
  returning id into strict private_work_id;

  insert into public.work_topics (work_id, topic_id, weight)
  values (private_work_id, ethics_id, 1.0);

  insert into public.summaries (work_id, title, status, visibility, author_id, published_at)
  values (private_work_id, 'Private', 'published', 'private', author_id, now())
  returning id into strict private_summary_id;

  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  values (private_summary_id, 1, 'Private idea', 'Author only', 30);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  top := public.get_topic('ethics', 200);
  if exists (
    select 1 from jsonb_array_elements(top -> 'sources') s
    where (s ->> 'id')::uuid = private_work_id
  ) then
    raise exception
      'a work whose only summary is private was listed under a topic. The join '
      'runs through work_topics, so nothing about `summaries` protects it '
      'automatically.';
  end if;
  if (top -> 'counts' ->> 'sources')::int <> before_sources then
    raise exception
      'the private work changed the topic''s source count without appearing in '
      'the list, so the page would claim a source the reader cannot open.';
  end if;

  cat := public.get_catalogue();
  if (cat -> 'totals' ->> 'sources')::int <> before_total then
    raise exception
      'the library total moved when a private work was added. `readable` '
      'requires published AND public, so a private summary must not enlarge the '
      'number the catalogue page leads with.';
  end if;

  raise notice 'CATALOGUE OK: counts agree across both screens, a parent counts '
               'its children, the limit bounds the list but not the total, and '
               'private work stays out of the taxonomy';
end $$;

rollback;
