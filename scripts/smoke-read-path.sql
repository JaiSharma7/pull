-- End-to-end smoke test of the read path against a freshly seeded local stack.
--
-- Exercises what the app actually calls on first load: a reader is created the
-- way auth creates one (so the handle_new_user trigger runs), then get_feed and
-- get_due_reviews are called *as that reader* through the same RLS the browser
-- gets. Running these as a superuser would prove nothing — RLS is the part most
-- likely to be wrong, and it is invisible to an owner-role query.
--
-- Read-only in effect: everything happens inside a transaction that rolls back.
begin;

do $$
declare
  uid uuid := extensions.gen_random_uuid();
  feed jsonb;
  due jsonb;
  card_count int;
begin
  -- Mimic a signup. The trigger on auth.users creates the profile and the
  -- default preference row the feed scorer reads.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'smoke-' || left(uid::text, 8) || '@example.test', '', now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  if not exists (select 1 from public.profiles where id = uid) then
    raise exception 'handle_new_user did not create a profile';
  end if;
  if not exists (select 1 from public.preference_profiles where user_id = uid) then
    raise exception 'handle_new_user did not create preferences';
  end if;

  -- Become that reader: `authenticated` role plus the JWT claims PostgREST sets,
  -- which is what auth.uid() reads.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);

  feed := public.get_feed(p_limit := 8, p_seed := 424242, p_page := 0);
  card_count := jsonb_array_length(feed -> 'rows');

  -- `is distinct from` rather than `= 0`: a missing key makes jsonb_array_length
  -- return NULL, and `NULL = 0` is NULL, which an IF treats as false. The first
  -- version of this check passed against a feed it had failed to read at all.
  if card_count is null or card_count = 0 then
    raise exception 'get_feed returned no rows on a seeded database (got: %)', feed;
  end if;

  due := public.get_due_reviews(p_limit := 5);

  raise notice 'feed rows: %', card_count;
  raise notice 'first headline: %', feed -> 'rows' -> 0 ->> 'headline';
  raise notice 'first source: %', feed -> 'rows' -> 0 -> 'work' ->> 'title';
  raise notice 'delta skippedKnownCount: %', feed ->> 'skippedKnownCount';
  raise notice 'delta minutesSaved: %', feed ->> 'minutesSaved';
  raise notice 'interleave slots: %', coalesce(jsonb_array_length(feed -> 'interleaveSlots'), 0);
  raise notice 'due reviews: %', coalesce(jsonb_array_length(due), 0);
  raise notice 'READ PATH OK';
end;
$$;

rollback;
