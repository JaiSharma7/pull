-- ---------------------------------------------------------------------------
-- A work is readable when something readable sits behind it.
--
-- `works` was `for select using (true)`: a bibliographic record the feed needs, and
-- every path that lists works filtered harder than the policy. Imports change what
-- a `works` row can be -- a book one reader is privately reading -- so 20260905101000
-- narrows the policy to "a summary of this work is readable by the caller".
--
-- Asserted in both directions:
--
--   * a work with no summary at all is invisible to a reader and to a visitor
--   * a work whose only summary is private is invisible to everyone but its author
--   * its author sees it, through the same policy, with no special case
--   * a seeded public work is still visible to a reader and to a visitor -- the
--     narrowing must not cost the catalogue a single row
--   * and the attack the narrowing invites, by both its doors: a reader holding a
--     private work's UUID can neither INSERT a summary onto it nor UPDATE one they
--     already own onto it. Both are refused and the work stays hidden. A summary on
--     an already-public work is still allowed, because that is the feature the
--     author policy exists for
--
-- Everything runs as the roles that reach the table. The whole file rolls back.
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

create or replace function pg_temp.assert_is_visitor() returns void
language plpgsql as $fn$
begin
  if current_user <> 'anon' then
    raise exception
      'the visitor assertions must run as anon, not as %.', current_user;
  end if;
end $fn$;

do $$
declare
  reader     uuid := extensions.gen_random_uuid();
  author     uuid := extensions.gen_random_uuid();
  bare_work  uuid;
  private_work uuid;
  public_work  uuid;
  seen       int;
  refused    boolean;
  own_summary uuid;
begin
  if (select count(*) from public.pulls) > 500 then
    raise exception
      'refusing to run: found % pulls, which is not a seed corpus.',
      (select count(*) from public.pulls);
  end if;

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values
    (reader, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'works-r-' || left(reader::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
    (author, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'works-a-' || left(author::text, 8) || '@example.test', '', now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  -- Fixture, as the owner: one work with nothing behind it, one with only a
  -- private summary, and a seeded public one for the control.
  insert into public.works (kind, title, slug, rights_status)
  values ('book', 'A book nobody has summarised', 'a-bare-work-test', 'public_domain')
  returning id into strict bare_work;

  insert into public.works (kind, title, slug, rights_status)
  values ('book', 'A book one reader is reading', 'a-private-work-test', 'user_owned')
  returning id into strict private_work;

  insert into public.summaries (work_id, title, status, visibility, author_id, published_at)
  values (private_work, 'My highlights', 'published', 'private', author, now());

  select w.id into strict public_work from public.works w where w.slug = 'on-liberty';

  -- ------------------------------------------------------------- as a reader
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  select count(*) into seen from public.works where id in (bare_work, private_work);
  if seen <> 0 then
    raise exception 'a reader can see % work(s) with nothing readable behind them', seen;
  end if;

  select count(*) into seen from public.works where id = public_work;
  if seen <> 1 then
    raise exception 'a reader lost a seeded public work (saw %)', seen;
  end if;

  -- The work_id is not a secret -- work_topics_read_all is still `using (true)` --
  -- so the policy has to hold against a reader who simply has it. Authoring a
  -- summary onto a stranger's private work would satisfy summary_is_readable for a
  -- row this reader owns, and the EXISTS above would then hand over the title.
  refused := false;
  begin
    insert into public.summaries (work_id, author_id, title, status, visibility)
    values (private_work, reader, 'Mine now', 'draft', 'private');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception
      'a reader authored a summary onto a private work they do not own; '
      'summaries_author_insert must require the work to be public already.';
  end if;

  select count(*) into seen from public.works where id = private_work;
  if seen <> 0 then
    raise exception 'a reader reached a private work by authoring a summary onto it';
  end if;

  -- The other direction: commentary on something already in the catalogue is what
  -- the author policy is for, and it still works.
  insert into public.summaries (work_id, author_id, title, status, visibility)
  values (public_work, reader, 'My notes on a public work', 'draft', 'private')
  returning id into strict own_summary;

  -- The second door. Guarding only the insert would have moved the attack one
  -- statement to the right: author onto a public work, then walk the row over.
  refused := false;
  begin
    update public.summaries set work_id = private_work where id = own_summary;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception
      'a reader moved their own summary onto a private work; '
      'summaries_author_update must check the work as well.';
  end if;

  select count(*) into seen from public.works where id = private_work;
  if seen <> 0 then
    raise exception 'a reader reached a private work by moving a summary onto it';
  end if;

  -- And an ordinary edit of their own summary, in place, is untouched.
  update public.summaries set title = 'My notes, revised' where id = own_summary;
  if not exists (select 1 from public.summaries where id = own_summary
                 and title = 'My notes, revised') then
    raise exception 'a reader could no longer edit their own summary';
  end if;

  -- ------------------------------------------------------------- as the author
  perform set_config('request.jwt.claims',
    json_build_object('sub', author, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  select count(*) into seen from public.works where id = private_work;
  if seen <> 1 then
    raise exception 'the author cannot see the work behind their own private summary';
  end if;

  select count(*) into seen from public.works where id = bare_work;
  if seen <> 0 then
    raise exception 'the author can see a work they have no summary on';
  end if;

  -- ------------------------------------------------------------- as a visitor
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform pg_temp.assert_is_visitor();

  select count(*) into seen from public.works where id in (bare_work, private_work);
  if seen <> 0 then
    raise exception 'a visitor can see % work(s) with nothing readable behind them', seen;
  end if;

  select count(*) into seen from public.works where id = public_work;
  if seen <> 1 then
    raise exception 'a visitor lost a seeded public work (saw %)', seen;
  end if;

  raise notice 'works: visible only behind a readable summary, unreachable by authoring '
    'or moving a summary onto one, and the catalogue kept every row';
end $$;

rollback;
