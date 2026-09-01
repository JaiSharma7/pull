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
-- Everything runs as a real reader under RLS, and section 7 is what makes that
-- claim mean something. The earlier sections would pass as a superuser too --
-- they assert paths whose predicates are written explicitly in the function
-- bodies (`ks.user_id = uid`, `status = 'published'`), so RLS is redundant for
-- them. Section 7 asserts a path that exists ONLY in a policy:
-- `pull_relations_read_readable`, which is what stops one reader's private
-- material from steering another reader's feed. `assert_is_reader` keeps the
-- rest honest by refusing to let an assertion run with owner rights.
--
-- The whole file rolls back.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

begin;

-- Refuses to let an assertion run with owner rights. Without it, a stray
-- `set role postgres` that outlives its section turns every check below into a
-- superuser query that proves nothing -- and does so silently, which is the
-- failure mode worth engineering against.
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
  reader_knows   uuid := extensions.gen_random_uuid();  -- knows the Mill pull
  reader_blank   uuid := extensions.gen_random_uuid();  -- knows nothing
  reader_lineage uuid := extensions.gen_random_uuid();  -- knows the Epictetus pull
  reader_both    uuid := extensions.gen_random_uuid();  -- knows Mill AND its opposite
  reader_oneside uuid := extensions.gen_random_uuid();  -- knows only the opposed idea
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
  skipped       int;
  skipped_blank int;
  present     boolean;
  signup_id   uuid;
  author_id          uuid := extensions.gen_random_uuid();
  private_summary_id uuid;
  private_pull_id    uuid;
begin
  -- This file DELETEs pulls and relations and INSERTs users. It is safe only
  -- because of the rollback at the end -- and `db:test` honours $DATABASE_URL,
  -- so "which database" is not a constant. Refuse anything that is not the
  -- freshly seeded local corpus rather than trusting the transaction alone.
  -- Identity and scale, not an exact count: the seed corpus grows, and a test
  -- that turns CI red for that reads like a Delta regression to whoever hits
  -- it. What actually matters is that this is a seeded development corpus and
  -- not somebody's data.
  if (select count(*) from public.pulls) > 500 then
    raise exception
      'refusing to run: found % pulls, which is not a seed corpus. This test '
      'writes before it rolls back and must not be pointed at real data.',
      (select count(*) from public.pulls);
  end if;

  -- ---------------------------------------------------------------- fixture
  -- STRICT: without it plpgsql silently takes an arbitrary row when a pattern
  -- matches twice, and these patterns are only unique by convention.
  select p.id into strict mill_id    from public.pulls p where p.headline like 'Silencing an opinion%';
  select p.id into strict thoreau_id from public.pulls p where p.headline like 'Living deliberately%';
  select p.id into strict epi_id     from public.pulls p where p.headline like 'You are disturbed by your judgement%';
  select p.id into strict marcus_id  from public.pulls p where p.headline like 'It is your opinion of the thing%';
  -- Another On Liberty pull; section 3 turns it into a restatement of Mill
  -- carrying no `opposes` edge of its own. Constrained by slug so the comment
  -- and the query cannot drift apart.
  select p.id into strict mill_echo_id
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
  join public.works w on w.id = s.work_id
  where w.slug = 'on-liberty' and p.headline like 'An unchallenged truth%';

  -- The seeded `opposes` edge is real editorial disagreement (Mill wants you to
  -- engage every opinion; Thoreau wants attention spent selectively). Give the
  -- pair the distance that REAL embeddings would give it. Zero rather than
  -- 0.0618 so the assertion cannot drift with the threshold.
  update public.pulls set embedding = (select embedding from public.pulls where id = mill_id)
  where id = thoreau_id;

  -- Walden's and Meditations' other pulls are removed so `per_work <= 2` in
  -- get_feed cannot silently drop a card under test for a reason unrelated to
  -- the Delta. Without this, section 6 passes even if the `opposes`-only
  -- restriction regresses: Marcus would be absent because he lost the per-work
  -- cut, not because he was correctly covered.
  delete from public.pulls p
  using public.summaries s, public.works w
  where p.summary_id = s.id and s.work_id = w.id
    and ((w.slug = 'walden' and p.id <> thoreau_id)
      or (w.slug = 'meditations' and p.id <> marcus_id));

  -- Mimic three signups. Going through auth.users rather than inserting
  -- profiles directly is deliberate: handle_new_user is what creates the
  -- preference row get_feed scores against.
  foreach signup_id in array array[reader_knows, reader_blank, reader_lineage, reader_both, reader_oneside] loop
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
  perform pg_temp.assert_is_reader();
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

  skipped := (feed ->> 'skippedKnownCount')::int;

  -- --------------------- 2. it is judged on its merits, not handed a rank
  -- The reader knows ONE idea, and the candidate opposes it. Excluding that
  -- pair leaves nothing to compare against, so novelty must be identical to a
  -- reader who knows nothing at all. Same seed, so every other scoring term is
  -- held constant. This is the assertion that fails under a "floor the novelty"
  -- design, which leaves the contradiction scored as a near-duplicate.
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_blank, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
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

  -- The comparison above is only meaningful while every other user-dependent
  -- term is equal. Both readers take default preferences from handle_new_user,
  -- and neither has a knowledge centroid -- but the REASON has changed, and it
  -- is worth writing down because it is now a weaker reason than it was.
  --
  -- `user_knowledge_vectors` used to be written only by an RPC nobody called.
  -- Since 20260901070000_the_feed_finally_knows_what_you_know.sql it is also
  -- written by `refresh_stale_knowledge_vectors`, which a pg_cron job runs
  -- every fifteen minutes, and that tick WOULD break the premise: run in this
  -- transaction it gives reader_knows a one-idea centroid and reader_blank
  -- none at all, because reader_blank has no knowledge states to average. That
  -- asymmetry is exactly the divergence this check exists to catch -- one
  -- reader scoring the uvec term as a real distance while the other scores the
  -- neutral 0.5.
  --
  -- What holds the premise up now is transaction isolation, not absence: these
  -- readers are created inside this transaction and rolled back, so no tick can
  -- ever see them. Which leaves precisely one way for this to fire, and it is
  -- the one worth catching -- somebody put a centroid write on the read path: a
  -- trigger on knowledge_states, or a refresh call inside record_read or
  -- get_feed. In that case the 0.18 uvec term diverges between these two
  -- readers and the failure above would blame the negation fix for it.
  if exists (
    select 1 from public.user_knowledge_vectors
    where user_id in (reader_knows, reader_blank)
  ) then
    raise exception
      'premise broken: a reader gained a knowledge vector inside this '
      'transaction, so the 0.18 uvec term is no longer equal for the two '
      'readers and the score comparison above no longer tests the Delta. The '
      'scheduled refresh cannot reach these readers -- look for a trigger on '
      'knowledge_states, or a refresh_knowledge_vector call on the read path.';
  end if;

  -- ...and the contradiction is not counted as a saving. Asserted as a
  -- difference against the reader who knows nothing rather than an absolute,
  -- so growing the seed corpus cannot fail this with a message blaming the
  -- Delta. Exactly one more skip than the blank reader: Mill itself.
  skipped_blank := (feed ->> 'skippedKnownCount')::int;
  if skipped <> skipped_blank + 1 then
    raise exception
      'expected the reader who knows Mill to skip exactly one more card than a '
      'reader who knows nothing (Mill itself), got % vs %. A contradiction '
      'counted as a saving is a false claim in the banner.', skipped, skipped_blank;
  end if;

  -- ------------------------------------------ 3. get_source_delta agrees
  -- The same rule has to hold on a source page, which counts rather than ranks.
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
  delta := public.get_source_delta(
    (select w.id from public.works w where w.slug = 'walden'));

  if (delta ->> 'known')::int <> 0 then
    raise exception
      'get_source_delta counted a contradiction as known: %. The reader knows '
      'nothing in Walden -- only an idea that the Walden pull opposes.', delta;
  end if;

  -- A mutant that deleted this function's exclusion used to leave the suite
  -- green, because every other assertion here only exercises get_feed and the
  -- two carry near-identical SQL. Pin the reported shape as well as the count,
  -- so the source page has an assertion of its own that bites.
  if (delta ->> 'new')::int <> 1 or (delta ->> 'total')::int <> 1 then
    raise exception
      'get_source_delta should report the single Walden pull as new: %', delta;
  end if;

  -- ------------------------------------------ 4. the limitation, on purpose
  -- Recorded as an assertion rather than a comment, because it is the boundary
  -- of what this fix claims and the next person will want to know it is known.
  --
  -- The reader holds a SECOND phrasing of Mill that carries no `opposes` edge
  -- of its own. Exclusion is edge-exact, so that phrasing still covers the
  -- contradiction and it disappears again. An earlier design widened the
  -- exclusion by distance to catch this; it was removed because distance cannot
  -- tell a restatement from a contradiction, so the widening also dropped ideas
  -- the candidate AGREED with and served them as novel. Incomplete beats wrong:
  -- this fails the way the old Delta already failed, rather than inventing a
  -- new way to mislead.
  --
  -- Relation extraction is what closes it, by annotating claims rather than
  -- pulls. When it does, this assertion should be inverted.
  perform set_config('role', 'postgres', true);
  insert into public.knowledge_states (user_id, pull_id, stability, last_seen_at)
  values (reader_knows, mill_echo_id, 100, now());
  update public.pulls set embedding = (select embedding from public.pulls where id = mill_id)
  where id = mill_echo_id;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);

  select exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r ->> 'id')::uuid = thoreau_id
  ) into present;

  if present then
    raise exception
      'the known limitation no longer holds: a contradiction survived a reader '
      'who knows an unannotated restatement of the opposed idea. If the edges '
      'became dense enough to cover restatements, invert this assertion. If '
      'something started widening the exclusion by distance instead, revert it '
      '-- section 7 explains why that cannot work.';
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
  perform pg_temp.assert_is_reader();
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

  -- Three more than a reader who knows nothing: Mill and its restatement are
  -- known directly, and the Thoreau pull is covered again now that the
  -- opposition protecting it is gone. That third one is the point of the control.
  skipped := (feed ->> 'skippedKnownCount')::int;
  if skipped <> skipped_blank + 3 then
    raise exception
      'control failed: expected 3 more skipped cards than the blank reader '
      'once the edge is deleted, got % vs %', skipped, skipped_blank;
  end if;

  -- ------------------------ 6. the exclusion is `opposes`-only, not any edge
  -- Marcus restates Epictetus -- a genuine `descendant` edge, and genuinely
  -- 0.0500 apart. Knowing one DOES mean you know the other, and that must not
  -- regress: a restatement is covered, a contradiction is not.
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_lineage, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
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

  -- ------- 7. the exclusion removes only what the candidate DISAGREES with
  -- The regression guard against re-adding the widening this design removed.
  --
  -- The reader holds Mill and Thoreau, which oppose each other. The candidate
  -- opposes Thoreau, so Thoreau leaves its comparison -- and Mill must NOT,
  -- because the candidate says nothing about Mill. Since the candidate restates
  -- Mill, keeping Mill is what covers it.
  --
  -- Any scheme that widens the exclusion beyond the annotated edge fails here:
  -- Mill sits inside the threshold of Thoreau (they are opposed, and opposed
  -- claims are near each other), so a distance-based widening drops Mill too,
  -- leaves nothing to compare against, and serves the reader an idea they
  -- already hold as maximally novel. Gating that widening on an `opposes` edge
  -- does not rescue it either -- the widening exists because edges are sparse,
  -- and such a gate reads a missing edge as "not opposed". If this assertion
  -- fails, the exclusion has started removing something the candidate agrees
  -- with; do not fix it by adding a gate.
  perform set_config('role', 'postgres', true);
  -- Section 5's control deleted the seeded Mill/Thoreau opposition to prove the
  -- exclusion depends on it. Put it back: this section is about what happens
  -- when the reader holds both sides, so both sides have to be opposed again.
  insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight)
  values (mill_id, thoreau_id, 'opposes', 0.75),
         (thoreau_id, mill_id, 'opposes', 0.75),
         -- ...and the candidate takes a side, against Thoreau.
         (mill_echo_id, thoreau_id, 'opposes', 0.75),
         (thoreau_id, mill_echo_id, 'opposes', 0.75)
  on conflict do nothing;

  insert into public.knowledge_states (user_id, pull_id, stability, last_seen_at)
  values (reader_both, mill_id, 100, now()), (reader_both, thoreau_id, 100, now());

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_both, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);

  select exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r ->> 'id')::uuid = mill_echo_id
  ) into present;

  if present then
    raise exception
      'the exclusion removed an idea the candidate AGREES with. A reader '
      'holding both sides of a debate was served a restatement of one side as '
      'new. Only what a candidate is annotated as opposing may leave its '
      'comparison -- never what it agrees with, and never by distance.';
  end if;

  -- ---------------------------- 8. a one-sided edge still works, either way
  -- Opposition is stored directionally and the seed writes both rows, so every
  -- assertion above passes whichever direction the code reads -- a mutant that
  -- deleted either union branch survived the whole suite. The migration claims
  -- a one-sided edge works anyway; this is what holds it to that.
  --
  -- The reader must know ONLY the opposed idea. Give them anything else at the
  -- same distance and it covers the candidate on its own, so the exclusion
  -- makes no observable difference and the assertion proves nothing -- which is
  -- how the first two versions of this section quietly failed to bite.
  perform set_config('role', 'postgres', true);
  insert into public.knowledge_states (user_id, pull_id, stability, last_seen_at)
  values (reader_oneside, thoreau_id, 100, now());
  delete from public.pull_relations
  where kind = 'opposes'
    and from_pull_id = mill_echo_id and to_pull_id = thoreau_id;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_oneside, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);

  -- Only (thoreau -> mill_echo) is left, and the candidate is its TO side, so
  -- the second union branch is the only one that can see it. Without that
  -- branch the candidate is covered by the very idea it contradicts.
  select exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r ->> 'id')::uuid = mill_echo_id
  ) into present;

  if not present then
    raise exception
      'an `opposes` edge stored only as (known -> candidate) was not honoured: '
      'the contradiction was covered by the idea it contradicts, so the union '
      'branch reading that direction is dead.';
  end if;

  -- The mirror image, for the other branch.
  perform set_config('role', 'postgres', true);
  insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight)
  values (mill_echo_id, thoreau_id, 'opposes', 0.75) on conflict do nothing;
  delete from public.pull_relations
  where kind = 'opposes'
    and from_pull_id = thoreau_id and to_pull_id = mill_echo_id;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_oneside, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);

  select exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r ->> 'id')::uuid = mill_echo_id
  ) into present;

  if not present then
    raise exception
      'an `opposes` edge stored only as (candidate -> known) was not honoured, '
      'so the union branch reading that direction is dead.';
  end if;

  -- ------------------- 9. another author's private material cannot reach in
  -- `opposed_pairs` reads `pull_relations`, and nothing in the function bodies
  -- re-checks who may see an edge -- that is `pull_relations_read_readable`'s
  -- job alone. This asserts the policy does it.
  --
  -- Being precise about what this does and does not prove, because the first
  -- version of this comment overclaimed: today no authenticated user can write
  -- an edge at all (there is no INSERT policy), and a private pull cannot enter
  -- the candidate pool anyway, so this is defence in depth rather than a live
  -- hole. It is worth keeping because both of those are properties of other
  -- objects that could change independently, and because a direct read of the
  -- edge is exactly what a future Counterpull UI will do.
  perform set_config('role', 'postgres', true);

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values (author_id, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'delta-author-' || left(author_id::text, 8) || '@example.test', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

  insert into public.summaries (work_id, title, status, visibility, author_id,
                                published_at)
  select w.id, 'Private counterpoint', 'published', 'private', author_id, now()
  from public.works w where w.slug = 'on-liberty'
  returning id into strict private_summary_id;

  insert into public.pulls (summary_id, ordinal, headline, body, embedding,
                            estimated_read_seconds)
  select private_summary_id, 1, 'A private objection to Mill.',
         'Visible only to its author.',
         (select embedding from public.pulls where id = mill_id), 30
  returning id into strict private_pull_id;

  -- An edge the reader must never be able to act on.
  insert into public.pull_relations (from_pull_id, to_pull_id, kind, weight)
  values (private_pull_id, mill_id, 'opposes', 0.75);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_knows, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  if exists (select 1 from public.pull_relations
             where from_pull_id = private_pull_id) then
    raise exception
      'a reader can see another author''s private `opposes` edge. '
      'pull_relations_read_readable is not doing its job.';
  end if;

  if exists (select 1 from public.pulls where id = private_pull_id) then
    raise exception 'a reader can read another author''s private pull.';
  end if;

  feed := public.get_feed(p_limit := 20, p_seed := seed, p_page := 0);
  if exists (
    select 1 from jsonb_array_elements(feed -> 'rows') r
    where (r ->> 'id')::uuid = private_pull_id
  ) then
    raise exception 'another author''s private pull was served in the feed.';
  end if;

  raise notice 'DELTA IS NEGATION-AWARE: contradiction shown, scored on merit, '
               'restatement still covered, source delta agrees, '
               'both-sides reader keeps their coverage, one-sided edges work both '
               'ways, private material stays out';
end $$;

rollback;
