-- ---------------------------------------------------------------------------
-- Less like this: a muted work leaves the feed, and every row says why it is there.
--
-- Asserted, and each is a way 20260909050000 could be wrong:
--
--   * a reader can mute a work they can read, and it leaves their feed on the next
--     page -- and nobody else's
--   * a reader cannot mute on another reader's behalf, and cannot mute a work they
--     cannot read
--   * deleting the row brings the work back
--   * every reason is one of the six sentences or nothing
--   * a reader who has read nothing is never told a card is close to what they have
--     been reading, or new to them, or from a well-regarded source when the source
--     sits at the schema default -- the neutral-default trap
--   * a reader who asked for a topic is told so, when nothing else about the card is
--     measured
--
-- Every assertion runs as a real reader under RLS; the fixture and the one edit to
-- a work's scores are the owner's. The whole file rolls back.
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

do $$
declare
  reader_a  uuid := extensions.gen_random_uuid();  -- asked for philosophy
  reader_b  uuid := extensions.gen_random_uuid();  -- has read nothing, asked nothing
  author_c  uuid := extensions.gen_random_uuid();  -- owns a private summary
  signup_id uuid;
  target_work uuid;   -- a public philosophy work, scores set to the schema default
  topic_w   double precision;  -- its weight on the philosophy topic
  private_work uuid;
  feed      jsonb;
  labels    text[] := array['A topic you asked for', 'Close to what you have been reading',
                            'A well-regarded source', 'New to you', 'Recently added',
                            'A little chance'];
  code      text;
  n         int;
begin
  if (select count(*) from public.pulls) > 500 then
    raise exception 'refusing to run: % pulls is not a seed corpus', (select count(*) from public.pulls);
  end if;

  foreach signup_id in array array[reader_a, reader_b, author_c] loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values (signup_id, '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated',
            'muted-' || left(signup_id::text, 8) || '@example.test', '',
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  end loop;

  -- A public philosophy work, chosen by slug order so the fixture is stable, with
  -- its quality and trust set to the schema default: neutral, so that for a reader
  -- who asked for philosophy the topic is the only measured thing about it.
  select w.id, wt.weight into strict target_work, topic_w
  from public.works w
  join public.summaries s on s.work_id = w.id and s.status = 'published' and s.visibility = 'public'
  join public.work_topics wt on wt.work_id = w.id
  join public.topics t on t.id = wt.topic_id and t.slug::text = 'philosophy'
  order by w.slug
  limit 1;

  update public.works set quality_score = 0.5, trust_score = 0.5 where id = target_work;

  -- Reader A's weight is set so that the affinity TERM is 0.6: a contribution of
  -- 0.20 * 0.6 = 0.12, above recency's 0.08 and chance's ceiling of 0.10 -- while the
  -- raw value, 0.6, sits below both. A reason picked by comparing raw terms rather
  -- than contributions says "Recently added" or "A little chance" here; section 4
  -- asks for the topic.
  if topic_w is null or topic_w < 0.6 then
    raise exception 'fixture: the work''s philosophy weight (%) cannot carry a 0.6 affinity', topic_w;
  end if;
  insert into public.preference_profiles (user_id, topic_weights)
  values (reader_a, jsonb_build_object('philosophy', 0.6 / topic_w))
  on conflict (user_id) do update set topic_weights = excluded.topic_weights;

  -- Another author's private work, which neither reader can see.
  insert into public.works (kind, title, slug, rights_status)
  values ('essay', 'A private essay', 'muted-works-private-test', 'public_domain')
  returning id into strict private_work;
  insert into public.summaries (work_id, title, status, visibility, author_id, published_at)
  values (private_work, 'Private', 'published', 'private', author_c, now());

  -- ---------------------------------------------------------------------------
  -- 1. The work is in A's feed, A mutes it, and it is gone -- from A's feed only
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_a);

  feed := public.get_feed(50, 7, 0);
  if not exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = target_work
  ) then
    raise exception 'fixture: the target work is not in reader A''s feed, so muting it proves nothing';
  end if;

  insert into public.muted_works (user_id, work_id) values (reader_a, target_work);

  feed := public.get_feed(50, 7, 0);
  if exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = target_work
  ) then
    raise exception 'a muted work was still served. The pool is not consulting muted_works.';
  end if;

  perform pg_temp.become(reader_b);

  select count(*) into n from public.muted_works;
  if n <> 0 then
    raise exception 'reader B can see reader A''s mutes (% rows)', n;
  end if;

  feed := public.get_feed(50, 7, 0);
  if not exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = target_work
  ) then
    raise exception 'reader A''s mute removed the work from reader B''s feed';
  end if;

  -- ---------------------------------------------------------------------------
  -- 2. A mute is the reader's own, on a work they can read
  -- ---------------------------------------------------------------------------
  code := null;
  begin
    insert into public.muted_works (user_id, work_id) values (reader_a, private_work);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception 'reader B muted a work on reader A''s behalf (got %)', coalesce(code, 'no error');
  end if;

  code := null;
  begin
    insert into public.muted_works (user_id, work_id) values (reader_b, private_work);
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader B muted a work they cannot read (got %). The insert policy has no '
      'readability leg.', coalesce(code, 'no error');
  end if;

  -- ---------------------------------------------------------------------------
  -- 3. Deleting the row brings the work back
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_a);

  delete from public.muted_works where work_id = target_work;
  select count(*) into n from public.muted_works;
  if n <> 0 then
    raise exception 'reader A could not delete their own mute';
  end if;

  feed := public.get_feed(50, 7, 0);
  if not exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = target_work
  ) then
    raise exception 'an unmuted work did not come back';
  end if;

  -- ---------------------------------------------------------------------------
  -- 4. Every reason is one of six sentences, or nothing
  -- ---------------------------------------------------------------------------
  if exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where r ->> 'reason' is not null and not (r ->> 'reason' = any (labels))
  ) then
    raise exception 'a feed row carried a reason that is none of the six: %',
      (select string_agg(distinct r ->> 'reason', ' | ')
         from jsonb_array_elements(feed -> 'rows') r
        where r ->> 'reason' is not null and not (r ->> 'reason' = any (labels)));
  end if;

  -- Reader A asked for philosophy; on the neutralised work that is the only measured
  -- thing, so it is the reason.
  if not exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = target_work
      and r ->> 'reason' = 'A topic you asked for'
  ) then
    raise exception
      'reader A asked for philosophy and was told % for a philosophy work whose other '
      'terms sit at their defaults. Contributions are not being compared, or the '
      'affinity term is not a candidate.',
      (select coalesce(r ->> 'reason', 'nothing')
         from jsonb_array_elements(feed -> 'rows') r
        where (r -> 'work' ->> 'id')::uuid = target_work limit 1);
  end if;

  -- ---------------------------------------------------------------------------
  -- 5. The neutral-default trap: a reader who has read nothing
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_b);
  feed := public.get_feed(50, 7, 0);

  if exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where r ->> 'reason' in ('Close to what you have been reading', 'New to you')
  ) then
    raise exception
      'a reader with no knowledge vector, no dwell and nothing known was told a card '
      'is "%". A term at its neutral default was allowed to be the reason.',
      (select r ->> 'reason' from jsonb_array_elements(feed -> 'rows') r
        where r ->> 'reason' in ('Close to what you have been reading', 'New to you') limit 1);
  end if;

  if exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = target_work
      and r ->> 'reason' = 'A well-regarded source'
  ) then
    raise exception
      'a work at the schema default of 0.5 for quality and trust was called well '
      'regarded. The default is neutral and must not be a reason.';
  end if;

  raise notice 'muted_works.sql: a muted work leaves the reader''s feed and nobody else''s, comes back when unmuted, cannot be set for a stranger or on a work the reader cannot read, and every row says why it is there in terms that were measured';
end $$;

rollback;
