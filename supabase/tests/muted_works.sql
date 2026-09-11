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
--     is rated below neutral -- a term at or under its neutral is never the reason
--   * a reader who asked for a topic is told so, when nothing else about the card is
--     measured -- and told so over a well-regarded source too, because a reason is
--     about the reader before it is about the source
--   * a mute cannot be moved onto a work the reader cannot read
--   * chance alone is never the reason: a card nothing lifted says nothing
--   * the day's picks never include a muted work
--   * the served score of one fully known card is 20260831210000's weighted sum
--
-- Every assertion runs as a real reader under RLS; the fixture, including the one
-- edit to a work's scores, is the owner's. The whole file rolls back.
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

do $$
declare
  reader_a  uuid := extensions.gen_random_uuid();  -- asked for philosophy
  reader_b  uuid := extensions.gen_random_uuid();  -- has read nothing, asked nothing
  reader_c  uuid := extensions.gen_random_uuid();  -- asked for philosophy, mildly
  page_size int;      -- two rows per public work, so every work is on the page
  rated_work uuid;    -- a second philosophy work, left at its seeded, high scores
  rated_w   double precision;
  author_c  uuid := extensions.gen_random_uuid();  -- owns a private summary
  signup_id uuid;
  target_work uuid;   -- a public philosophy work, rated below neutral for the test
  topic_w   double precision;  -- its weight on the philosophy topic
  other_work  uuid;   -- a second public work, which nobody has muted
  private_work uuid;
  old_work    uuid;   -- public, published two years ago, scores at the default
  old_pull    uuid;
  chance_seed bigint; -- a seed under which the old pull's jitter sits above neutral
  seed_i      int;
  picked_work uuid;
  daily       jsonb;
  row_json    jsonb;
  pub_at      timestamptz;
  expected    double precision;
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

  foreach signup_id in array array[reader_a, reader_b, reader_c, author_c] loop
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
  -- its quality and trust set BELOW neutral: they still count in the score, and must
  -- never be the reason -- so for a reader who asked for philosophy the topic is the
  -- only thing that lifts it.
  -- Every public work is served at two rows each, so no assertion below depends on
  -- where a work ranks (review finding): the page is the whole ranked set.
  select 2 * count(*) + 5 into page_size
  from public.works w
  join public.summaries s on s.work_id = w.id and s.status = 'published' and s.visibility = 'public';

  select w.id, wt.weight into strict target_work, topic_w
  from public.works w
  join public.summaries s on s.work_id = w.id and s.status = 'published' and s.visibility = 'public'
  join public.work_topics wt on wt.work_id = w.id
  join public.topics t on t.id = wt.topic_id and t.slug::text = 'philosophy'
  order by w.slug
  limit 1;

  update public.works set quality_score = 0.3, trust_score = 0.3 where id = target_work;

  select w.id into strict other_work
  from public.works w
  join public.summaries s on s.work_id = w.id and s.status = 'published' and s.visibility = 'public'
  where w.id <> target_work
  order by w.slug
  limit 1;

  -- Reader A's weight is set so that the affinity TERM is 0.6: a lift of
  -- 0.20 * 0.6 = 0.12, above recency's at most 0.04 and chance's at most 0.05 --
  -- while the raw value, 0.6, sits below a fresh work's recency. A reason picked by
  -- comparing raw terms says "Recently added" here; section 4 asks for the topic.
  if topic_w is null or topic_w < 0.6 then
    raise exception 'fixture: the work''s philosophy weight (%) cannot carry a 0.6 affinity', topic_w;
  end if;
  insert into public.preference_profiles (user_id, topic_weights)
  values (reader_a, jsonb_build_object('philosophy', 0.6 / topic_w))
  on conflict (user_id) do update set topic_weights = excluded.topic_weights;

  -- Reader C asked for philosophy mildly -- an affinity term of 0.3, a lift of 0.06 --
  -- and meets a second philosophy work at its seeded scores, whose "well-regarded"
  -- lift is larger. A reason is about the reader first, so the topic still wins.
  select w.id, wt.weight into strict rated_work, rated_w
  from public.works w
  join public.summaries s on s.work_id = w.id and s.status = 'published' and s.visibility = 'public'
  join public.work_topics wt on wt.work_id = w.id
  join public.topics t on t.id = wt.topic_id and t.slug::text = 'philosophy'
  where w.id <> target_work and w.quality_score > 0.8 and w.trust_score > 0.8
  order by w.slug
  limit 1;
  if rated_w is null or rated_w < 0.3 then
    raise exception 'fixture: no second well-rated philosophy work can carry a 0.3 affinity';
  end if;
  insert into public.preference_profiles (user_id, topic_weights)
  values (reader_c, jsonb_build_object('philosophy', 0.3 / rated_w))
  on conflict (user_id) do update set topic_weights = excluded.topic_weights;

  -- A work nothing lifts for a reader with no history: published two years ago, so
  -- recency is below neutral; quality and trust at the schema default; one pull.
  insert into public.works (kind, title, slug, rights_status)
  values ('essay', 'An old essay', 'muted-works-old-test', 'public_domain')
  returning id into strict old_work;
  insert into public.summaries (work_id, title, status, visibility, published_at)
  values (old_work, 'An old essay', 'published', 'public', now() - interval '2 years');
  insert into public.pulls (summary_id, ordinal, headline, body, estimated_read_seconds)
  select s.id, 1, 'An old idea', 'Nothing about this reader lifts it.', 5
  from public.summaries s where s.work_id = old_work
  returning id into strict old_pull;

  -- A seed under which that pull's jitter is above 0.5, so that chance alone WOULD
  -- have a positive lift -- which is exactly what must not become the reason.
  -- A FOR loop's control variable is its own, declared by the loop and gone after
  -- it, so the seed is copied out explicitly rather than read off the loop.
  for seed_i in 1..500 loop
    if public.seeded_unit(seed_i, 0, 1, 'jitter') > 0.5 then
      chance_seed := seed_i;
      exit;
    end if;
  end loop;
  if chance_seed is null then
    raise exception 'fixture: no seed in 1..500 puts ordinal 1''s jitter above neutral';
  end if;

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

  feed := public.get_feed(page_size, 7, 0);
  if not exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = target_work
  ) then
    raise exception 'fixture: the target work is not in reader A''s feed, so muting it proves nothing';
  end if;

  insert into public.muted_works (user_id, work_id) values (reader_a, target_work);

  feed := public.get_feed(page_size, 7, 0);
  if exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = target_work
  ) then
    raise exception 'a muted work was still served. The pool is not consulting muted_works.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 1b. The day's picks never include a muted work. Two clauses, each proven on its
  --     own: with every work muted the day must CHOOSE nothing (the selection table
  --     stays empty, not merely hidden), and a work muted after the day was chosen
  --     must leave the read-back.
  -- ---------------------------------------------------------------------------
  insert into public.muted_works (user_id, work_id)
  select reader_a, w.id
  from public.works w
  join public.summaries s on s.work_id = w.id and s.status = 'published' and s.visibility = 'public'
  where w.id <> target_work
  on conflict do nothing;

  daily := public.get_daily_pulls((now() at time zone 'UTC')::date);
  if jsonb_array_length(daily -> 'pulls') <> 0 then
    raise exception
      'the day''s picks served % idea(s) from muted works.', jsonb_array_length(daily -> 'pulls');
  end if;
  select count(*) into n from public.daily_pull_selections d
  where d.user_id = reader_a and d.day = (now() at time zone 'UTC')::date;
  if n <> 0 then
    raise exception
      'the day chose % idea(s) from muted works and only hid them. The eligible set '
      'in get_daily_pulls is not consulting muted_works.', n;
  end if;

  -- Unmute everything but the work under test; the day, still unchosen, now picks
  -- from the rest. Then mute one of the picks and read the day back.
  delete from public.muted_works where user_id = reader_a and work_id <> target_work;
  daily := public.get_daily_pulls((now() at time zone 'UTC')::date);
  if jsonb_array_length(daily -> 'pulls') < 2 then
    raise exception 'fixture: the day picked % idea(s); the read-back check needs at least two',
      jsonb_array_length(daily -> 'pulls');
  end if;
  picked_work := (daily -> 'pulls' -> 0 ->> 'workId')::uuid;
  insert into public.muted_works (user_id, work_id) values (reader_a, picked_work);
  daily := public.get_daily_pulls((now() at time zone 'UTC')::date);
  if exists (
    select 1 from jsonb_array_elements(daily -> 'pulls') r
    where (r ->> 'workId')::uuid = picked_work
  ) then
    raise exception
      'a work muted after the day was chosen was still read back. The read-back in '
      'get_daily_pulls is not consulting muted_works.';
  end if;
  delete from public.muted_works where user_id = reader_a and work_id = picked_work;

  perform pg_temp.become(reader_b);

  select count(*) into n from public.muted_works;
  if n <> 0 then
    raise exception 'reader B can see reader A''s mutes (% rows)', n;
  end if;

  feed := public.get_feed(page_size, 7, 0);
  if not exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = target_work
  ) then
    raise exception 'reader A''s mute removed the work from reader B''s feed';
  end if;

  -- ---------------------------------------------------------------------------
  -- 2. A mute is the reader's own, on a work they can read
  -- ---------------------------------------------------------------------------
  -- On a work B can read and A has not muted, so that only the ownership leg can
  -- refuse it -- not readability, and not the primary key.
  code := null;
  begin
    insert into public.muted_works (user_id, work_id) values (reader_a, other_work);
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

  -- Nor moved onto one: reader A holds a mute and may not point it at a private work.
  perform pg_temp.become(reader_a);
  code := null;
  begin
    update public.muted_works set work_id = private_work where work_id = target_work;
  exception when others then
    code := sqlstate;
  end;
  if code is distinct from '42501' then
    raise exception
      'reader A moved a mute onto a work they cannot read (got %). The update policy '
      'has no readability leg, and the foreign key would tell them which private ids '
      'are real.', coalesce(code, 'no error');
  end if;
  perform pg_temp.become(reader_b);

  -- ---------------------------------------------------------------------------
  -- 3. Deleting the row brings the work back
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_a);

  delete from public.muted_works where work_id = target_work;
  select count(*) into n from public.muted_works;
  if n <> 0 then
    raise exception 'reader A could not delete their own mute';
  end if;

  feed := public.get_feed(page_size, 7, 0);
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
      'reader A asked for philosophy and was told % for a philosophy work that nothing '
      'else lifts. Lifts are not being compared, or the affinity term is not a candidate.',
      (select coalesce(r ->> 'reason', 'nothing')
         from jsonb_array_elements(feed -> 'rows') r
        where (r -> 'work' ->> 'id')::uuid = target_work limit 1);
  end if;

  -- ---------------------------------------------------------------------------
  -- 4b. A reason is about the reader before it is about the source
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_c);
  feed := public.get_feed(page_size, 7, 0);
  if not exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = rated_work
  ) then
    raise exception 'fixture: the well-rated philosophy work is not on reader C''s page';
  end if;
  if exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r -> 'work' ->> 'id')::uuid = rated_work
      and r ->> 'reason' is distinct from 'A topic you asked for'
  ) then
    raise exception
      'reader C asked for philosophy and was told "%" about a well-rated philosophy '
      'work. A lift about the reader is the reason before a lift about the source, '
      'however large the source''s.',
      (select coalesce(r ->> 'reason', 'nothing') from jsonb_array_elements(feed -> 'rows') r
        where (r -> 'work' ->> 'id')::uuid = rated_work limit 1);
  end if;

  -- ---------------------------------------------------------------------------
  -- 5. The neutral-default trap: a reader who has read nothing
  -- ---------------------------------------------------------------------------
  perform pg_temp.become(reader_b);
  feed := public.get_feed(page_size, 7, 0);

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
      'a work rated 0.3 for quality and trust was called well regarded. A term at or '
      'below its neutral must not be the reason.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 5b. Chance alone is never the reason
  -- ---------------------------------------------------------------------------
  feed := public.get_feed(page_size, chance_seed, 0);
  select r into row_json
  from jsonb_array_elements(feed -> 'rows') r
  where (r ->> 'id')::uuid = old_pull;
  if row_json is null then
    raise exception 'fixture: the old pull is not on reader B''s page, so 5b proves nothing';
  end if;
  if row_json ->> 'reason' is not null then
    raise exception
      'a card nothing lifts for this reader was given the reason "%". Chance is a '
      'candidate only beside a measured signal.', row_json ->> 'reason';
  end if;

  -- ---------------------------------------------------------------------------
  -- 6. The served score is 20260831210000's weighted sum, computed here by hand for
  --    a card whose eight terms are all known: reader B has no preferences (affinity
  --    0), no dwell and no vector (both neutral, 0.5), knows nothing (novelty 1.0);
  --    the work is rated 0.3 and 0.3; recency and jitter are computable.
  -- ---------------------------------------------------------------------------
  feed := public.get_feed(page_size, 7, 0);
  select r into strict row_json
  from jsonb_array_elements(feed -> 'rows') r
  where (r -> 'work' ->> 'id')::uuid = target_work
  order by (r ->> 'ordinal')::int
  limit 1;
  select s.published_at into strict pub_at
  from public.pulls p join public.summaries s on s.id = p.summary_id
  where p.id = (row_json ->> 'id')::uuid;
  expected :=
      0.20 * 0
    + 0.08 * 0.5
    + 0.18 * 0.5
    + 0.16 * 0.3
    + 0.12 * 1.0
    + 0.08 * greatest(0.0, 1.0 - extract(epoch from (now() - pub_at)) / (86400.0 * 365.0))
    + 0.08 * 0.3
    + 0.10 * public.seeded_unit(7, 0, (row_json ->> 'ordinal')::int, 'jitter');
  if abs((row_json ->> 'score')::double precision - expected) > 0.00011 then
    raise exception
      'the served score % is not the weighted sum % of the eight terms as '
      '20260831210000 weights them. A weight has moved.',
      row_json ->> 'score', round(expected::numeric, 4);
  end if;

  raise notice 'muted_works.sql: a muted work leaves the reader''s feed and the day''s picks and nobody else''s, comes back when unmuted, cannot be set for a stranger or on a work the reader cannot read, every row says why it is there in terms that lifted it or says nothing, and the score is the sum it always was';
end $$;

rollback;
