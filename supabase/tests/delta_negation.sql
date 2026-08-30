-- ---------------------------------------------------------------------------
-- The Delta must not file a contradiction as something you already know.
--
-- Embeddings barely encode negation: measured against real Gemini vectors, a
-- claim and its opposite sit 0.0618 apart while two paraphrases of the SAME
-- claim sit 0.0987 apart. So a pure distance test rates a contradiction as
-- MORE redundant than a restatement, and the Delta hides exactly the material
-- Counterpull exists to surface.
--
-- The fix removes opposed pairs from the distance comparison, so `covered` and
-- `novelty_distance` are both computed against what the reader knows MINUS the
-- ideas this candidate contradicts.
--
-- This cannot be demonstrated against the seed as it stands: under the current
-- synthetic concept-axis embeddings the two seeded `opposes` pulls are 1.0198
-- apart, nowhere near the 0.14 cut, so the defect does not fire. The test
-- therefore CONSTRUCTS the condition -- which is the same reason the fix has to
-- land before the real-embedding backfill rather than after it.
--
-- Everything runs as a real reader under RLS. Asserting as superuser would
-- prove nothing: RLS is the part most likely to be wrong and it is invisible to
-- an owner-role query. The whole file rolls back.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

begin;

do $$
declare
  reader_knows   uuid := extensions.gen_random_uuid();  -- knows the Mill pull
  reader_blank   uuid := extensions.gen_random_uuid();  -- knows nothing
  reader_lineage uuid := extensions.gen_random_uuid();  -- knows the Epictetus pull
  mill_id     uuid;   -- 'Silencing an opinion...'      (On Liberty)
  thoreau_id  uuid;   -- 'Living deliberately...'       (Walden) -- opposes Mill
  epi_id      uuid;   -- 'You are disturbed by...'      (Enchiridion)
  marcus_id   uuid;   -- 'It is your opinion...'        (Meditations) -- restates epi
  mill_echo_id uuid;  -- a second On Liberty pull, made a paraphrase of Mill
  seed        constant bigint := 424242;
  feed        jsonb;
  delta       jsonb;
  score_knows numeric;
  score_blank numeric;
  skipped     int;
  present     boolean;
  signup_id   uuid;
begin
  -- ---------------------------------------------------------------- fixture
  select p.id into mill_id    from public.pulls p where p.headline like 'Silencing an opinion%';
  select p.id into thoreau_id from public.pulls p where p.headline like 'Living deliberately%';
  select p.id into epi_id     from public.pulls p where p.headline like 'You are disturbed by your judgement%';
  select p.id into marcus_id  from public.pulls p where p.headline like 'It is your opinion of the thing%';
  -- Any other On Liberty pull; section 3 turns it into a restatement of Mill
  -- carrying no `opposes` edge of its own.
  select p.id into mill_echo_id from public.pulls p where p.headline like 'An unchallenged truth%';

  if mill_id is null or thoreau_id is null or epi_id is null or marcus_id is null
     or mill_echo_id is null then
    raise exception 'seed corpus is missing a pull this test depends on';
  end if;

  -- The seeded `opposes` edge is real editorial disagreement (Mill wants you to
  -- engage every opinion; Thoreau wants attention spent selectively). Give the
  -- pair the distance that REAL embeddings would give it. Zero rather than
  -- 0.0618 so the assertion cannot drift with the threshold.
  update public.pulls set embedding = (select embedding from public.pulls where id = mill_id)
  where id = thoreau_id;

  -- Walden's other two pulls are removed so `per_work <= 2` in get_feed cannot
  -- silently drop the card under test for a reason unrelated to the Delta.
  delete from public.pulls p
  using public.summaries s, public.works w
  where p.summary_id = s.id and s.work_id = w.id and w.slug = 'walden'
    and p.id <> thoreau_id;

  -- Mimic three signups. Going through auth.users rather than inserting
  -- profiles directly is deliberate: handle_new_user is what creates the
  -- preference row get_feed scores against.
  foreach signup_id in array array[reader_knows, reader_blank, reader_lineage] loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values (signup_id, '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated',
            'delta-' || left(signup_id::text, 8) || '@example.test', '',
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  end loop;

  -- Stability 100 with last_seen_at now() puts retrievability comfortably above
  -- the 0.7 floor, so these count as known by the same test the read path uses.
  insert into public.knowledge_states (user_id, pull_id, stability, last_seen_at)
  values (reader_knows,   mill_id, 100, now()),
         (reader_lineage, epi_id,  100, now());

  -- ------------------------------------------------- 1. the contradiction shows
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);

  select exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r ->> 'id')::uuid = thoreau_id
  ) into present;

  if not present then
    raise exception
      'REGRESSION: the Delta hid a contradiction. The reader knows Mill; the '
      'Thoreau pull opposes it and sits at distance 0, so a pure distance test '
      'files it as already-known. It must be shown.';
  end if;

  select (r ->> 'score')::numeric into score_knows
  from jsonb_array_elements(feed -> 'rows') r where (r ->> 'id')::uuid = thoreau_id;

  -- ...and is not counted as a saving. The reader knows Mill directly, which is
  -- one genuine skip; the contradiction must not make it two.
  skipped := (feed ->> 'skippedKnownCount')::int;
  if skipped <> 1 then
    raise exception
      'expected exactly 1 skipped card (the directly-known Mill pull), got %. '
      'A contradiction counted as a saving is a false claim in the banner.', skipped;
  end if;

  -- --------------------- 2. it is judged on its merits, not handed a rank
  -- The reader knows ONE idea, and the candidate opposes it. Excluding that
  -- pair leaves nothing to compare against, so novelty must be identical to a
  -- reader who knows nothing at all. Same seed, so every other scoring term is
  -- held constant. This is the assertion that fails under a "floor the novelty"
  -- design, which leaves the contradiction scored as a near-duplicate.
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_blank, 'role', 'authenticated')::text, true);
  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);
  select (r ->> 'score')::numeric into score_blank
  from jsonb_array_elements(feed -> 'rows') r where (r ->> 'id')::uuid = thoreau_id;

  if score_blank is null then
    raise exception 'control reader did not receive the Thoreau pull at all';
  end if;
  if score_knows <> score_blank then
    raise exception
      'a contradiction was scored as redundant: % for the reader who knows the '
      'opposed idea vs % for a reader who knows nothing. Excluding the opposed '
      'pair should make these identical.', score_knows, score_blank;
  end if;

  -- ------------- 3. it survives a reader who knows the claim several ways
  -- The edge names two pulls, but a reader knows a CLAIM, usually through more
  -- than one phrasing. Give this reader a second restatement of Mill carrying
  -- no edge of its own: on proximity alone it would re-cover the contradiction,
  -- and the exclusion would then work only for readers who barely know the
  -- topic and fail for the ones with a stake in the disagreement.
  --
  -- Opposition therefore propagates through paraphrase, and this is the
  -- assertion that holds it there.
  perform set_config('role', 'postgres', true);
  insert into public.knowledge_states (user_id, pull_id, stability, last_seen_at)
  values (reader_knows, mill_echo_id, 100, now());
  update public.pulls set embedding = (select embedding from public.pulls where id = mill_id)
  where id = mill_echo_id;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);

  select exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r ->> 'id')::uuid = thoreau_id
  ) into present;

  if not present then
    raise exception
      'the contradiction was re-covered by a restatement. The reader knows Mill '
      'AND a paraphrase of Mill; only the first carries an `opposes` edge. '
      'Opposition must propagate through paraphrase, or this fix only works for '
      'readers who barely know the topic.';
  end if;

  -- ------------------------------------------ 4. get_source_delta agrees
  -- The same rule has to hold on a source page, which counts rather than ranks.
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  delta := public.get_source_delta(
    (select w.id from public.works w where w.slug = 'walden'));

  if (delta ->> 'known')::int <> 0 then
    raise exception
      'get_source_delta counted a contradiction as known: %. The reader knows '
      'nothing in Walden -- only an idea that the Walden pull opposes.', delta;
  end if;

  -- ----------------------------------- 5. control: the edge is what does it
  -- Remove the opposition and the very same card must go back to being covered.
  -- Without this, the test would still pass if the covered check were simply
  -- broken.
  perform set_config('role', 'postgres', true);
  delete from public.pull_relations
  where kind = 'opposes'
    and (from_pull_id in (mill_id, thoreau_id) or to_pull_id in (mill_id, thoreau_id));

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);

  select exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r ->> 'id')::uuid = thoreau_id
  ) into present;

  if present then
    raise exception
      'control failed: with the `opposes` edge deleted the card is 0 distance '
      'from a known idea and must be covered. Something other than the '
      'exclusion is keeping it in the feed.';
  end if;

  -- Three: Mill and its restatement are both known directly, and the Thoreau
  -- pull is now covered again because the opposition that was protecting it is
  -- gone. That third one is the whole point of the control.
  skipped := (feed ->> 'skippedKnownCount')::int;
  if skipped <> 3 then
    raise exception 'control failed: expected 3 skipped cards without the edge, got %', skipped;
  end if;

  -- ------------------------ 6. the exclusion is `opposes`-only, not any edge
  -- Marcus restates Epictetus -- a genuine `descendant` edge, and genuinely
  -- 0.0500 apart. Knowing one DOES mean you know the other, and that must not
  -- regress: a restatement is covered, a contradiction is not.
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_lineage, 'role', 'authenticated')::text, true);
  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);

  select exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r ->> 'id')::uuid = marcus_id
  ) into present;

  if present then
    raise exception
      'a restatement of a known idea was shown as new. The exclusion must apply '
      'to `opposes` edges only, not to ancestor/descendant lineage.';
  end if;

  raise notice 'DELTA IS NEGATION-AWARE: contradiction shown, scored on merit, '
               'restatement still covered, source delta agrees';
end $$;

rollback;
