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
  private_work_id    uuid;
  private_summary_id uuid;
  private_pull_id    uuid;
  buried_work_id     uuid;
  buried_summary_id  uuid;
  buried_pull_id     uuid;
  -- A token that cannot occur in the public-domain corpus, so a hit on it is
  -- proof of a leak rather than a coincidence.
  secret_token text := 'zqxjvwk';
  -- A second one, for section 9. It needs more matches than any single word in
  -- the public-domain corpus has, so it brings its own.
  bulk_token   text := 'qzzytrb';
  bulk_work    uuid;
  bulk_summary uuid;
  -- `bulk_i`, not `i`. A plpgsql variable shadows a table alias of the same
  -- name anywhere in the block, and this file uses `jsonb_array_elements(...) i`
  -- in a dozen assertions -- so declaring `i` made every one of them fail with
  -- "column reference i is ambiguous". It passed every check that runs a
  -- statement at a time and failed the moment the file ran as one block.
  bulk_i       int;
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

  -- Another author's private summary, on a work OF ITS OWN.
  --
  -- Attaching it to `on-liberty` -- the anchor's work -- made the related_pulls
  -- assertion below pass for the wrong reason: `related_pulls` drops anything
  -- from the anchor's own source regardless of who may read it, so the check
  -- could not tell a visibility regression from the same-work rule. A separate
  -- work leaves visibility as the only thing standing between the reader and
  -- this pull.
  insert into public.works (kind, title, slug, rights_status)
  values ('essay', 'A private counterpoint', 'private-counterpoint-test', 'public_domain')
  returning id into strict private_work_id;

  insert into public.summaries (work_id, title, status, visibility, author_id,
                                published_at)
  values (private_work_id, 'Private note ' || secret_token, 'published', 'private',
          author_id, now())
  returning id into strict private_summary_id;

  -- THE CENTROID ITSELF, not Mill's vector.
  --
  -- This fixture used to carry `mill_id`'s embedding, on the stated theory that
  -- a search for 'opinion' would put the centroid "right on top of it". It does
  -- the opposite. The centroid is the MEAN of the five top-ranked hits, and a
  -- mean of five vectors is not near any one of them: measured, Mill's own pull
  -- sat 0.678 away and ranked 127th of the candidates, against a nearest of
  -- 0.195. It could never reach `near`'s limit of 24, let alone the six of
  -- `alsoClose` -- so the assertion below passed for every implementation,
  -- including one with the visibility predicate deleted outright.
  --
  -- Giving it the centroid makes the distance exactly zero, which is strictly
  -- less than every real pull's, so this row is unambiguously first the moment
  -- the predicate stops excluding it. The expression mirrors `search_catalogue`
  -- rather than hardcoding an id, so it stays correct as the corpus grows -- and
  -- it is deliberately written out rather than factored into a helper, because a
  -- fixture that shares code with the thing it tests can be wrong in the same
  -- direction twice.
  insert into public.pulls (summary_id, ordinal, headline, body, embedding,
                            estimated_read_seconds)
  select private_summary_id, 1,
         'A private objection ' || secret_token,
         'Visible only to its author ' || secret_token,
         (select extensions.avg(t.embedding)::extensions.vector(1536)
          from (
            select p.embedding
            from public.pulls p
            join public.summaries s on s.id = p.summary_id
            join public.works     w on w.id = s.work_id
            where s.status = 'published'
              and s.visibility = 'public'
              and p.embedding is not null
              and (
                p.search_tsv @@ websearch_to_tsquery('pg_catalog.english', 'opinion')
                or p.headline OPERATOR(extensions.%) 'opinion'
              )
            order by (  0.55 * ts_rank_cd(p.search_tsv,
                          websearch_to_tsquery('pg_catalog.english', 'opinion'), 32)
                      + 0.20 * coalesce(extensions.similarity(p.headline, 'opinion'), 0.0)
                      + 0.15 * w.quality_score
                      + 0.10 * w.trust_score) desc,
                     p.id
            limit 5
          ) t),
         30
  returning id into strict private_pull_id;

  -- A LEXICAL MATCH THAT LOSES THE RANKING CUT.
  --
  -- Section 8 pins 20260901020000's fix: `near` must exclude all of `ranked`,
  -- every lexical match, and not merely the page of them in `top_ideas`. On the
  -- seeded corpus that section could not fail. Reverting the predicate left the
  -- file green, because the twenty-four rows `near` returns for 'opinion' hold
  -- no keyword hit at any limit -- all twelve of the real ones sit far enough
  -- from the centroid to lose to something the words never matched, so the
  -- assertion was comparing two sets the corpus keeps disjoint by accident.
  --
  -- This row is the one case the old predicate lets through, and it is three
  -- things at once:
  --
  --   * A REAL LEXICAL HIT. 'opinion' occurs exactly once, in the BODY, so
  --     `ts_rank_cd` sees a single weight-B position (0.2857) and the headline
  --     carries no trigram of the query at all (similarity 0.0).
  --   * RANKED LAST OF THE THIRTEEN, at 0.1821 against a floor of 0.2821 among
  --     the seeded hits, so `search_catalogue('opinion', 1, 1)` cannot put it in
  --     `top_ideas`. The work scores 0.1 rather than the 0.5 default precisely
  --     so that is a gap rather than a tie -- at the default it would land on
  --     0.2821 exactly, level with two real hits, and which of them `order by
  --     rank desc, id` put first would be a fact about generated uuids.
  --   * SITTING ON THE CENTROID of that same call. With `p_limit_ideas = 1`,
  --     `top_ideas` is a single row and the mean of five collapses to it, so the
  --     distance here is exactly zero -- against 0.439 for the nearest real
  --     candidate. The mirror below is the one above with `limit 1` for
  --     `p_limit_ideas`, written out for the same reason.
  --
  -- Published and public, because a private summary never reaches `ranked` and
  -- the whole point is a row that IS in `ranked` and would still be offered as
  -- something the words had missed. It is inserted after the private fixture and
  -- ranks thirteenth of thirteen, so it stays out of the five the 20/10 centroid
  -- averages and leaves that fixture's distance untouched.
  insert into public.works (kind, title, slug, rights_status,
                            quality_score, trust_score)
  values ('essay', 'The Cost of an Unprinted Dissent', 'unprinted-dissent-test',
          'public_domain', 0.1, 0.1)
  returning id into strict buried_work_id;

  insert into public.summaries (work_id, title, status, visibility, published_at)
  values (buried_work_id, 'The Cost of an Unprinted Dissent', 'published',
          'public', now())
  returning id into strict buried_summary_id;

  insert into public.pulls (summary_id, ordinal, headline, body, embedding,
                            estimated_read_seconds)
  select buried_summary_id, 1,
         'What goes untested when a dissent is never printed',
         'A dissent that never reaches print costs the majority more than it '
         'costs the dissenter, because the thing left untested is not the '
         'objection but the settled opinion it was aimed at.',
         (select extensions.avg(t.embedding)::extensions.vector(1536)
          from (
            select ti.embedding
            from (
              select p.embedding, p.id,
                     (  0.55 * ts_rank_cd(p.search_tsv,
                          websearch_to_tsquery('pg_catalog.english', 'opinion'), 32)
                      + 0.20 * coalesce(extensions.similarity(p.headline, 'opinion'), 0.0)
                      + 0.15 * w.quality_score
                      + 0.10 * w.trust_score) as rank
              from public.pulls p
              join public.summaries s on s.id = p.summary_id
              join public.works     w on w.id = s.work_id
              where s.status = 'published'
                and s.visibility = 'public'
                and (
                  p.search_tsv @@ websearch_to_tsquery('pg_catalog.english', 'opinion')
                  or p.headline OPERATOR(extensions.%) 'opinion'
                )
              order by rank desc, p.id
              limit 1
            ) ti
            where ti.embedding is not null
            order by ti.rank desc, ti.id
            limit 5
          ) t),
         30
  returning id into strict buried_pull_id;

  -- FIFTY-ONE SOURCES THAT NOTHING ELSE IN THIS FILE CAN SEE.
  --
  -- Section 9 asserts that a caller-supplied limit has a ceiling, and the corpus
  -- cannot make that assertion fail: the widest single word in the seeded
  -- library matches twelve pulls, so `search_catalogue(word, 100000, 100000)`
  -- returns twelve under a ceiling of fifty and twelve under no ceiling at all.
  -- The check would pass against exactly the code it exists to catch. Fifty-one
  -- is one more than the ceiling, which is the smallest number that can tell
  -- them apart.
  --
  -- Built to be invisible to every other section, and both halves of that
  -- matter:
  --
  --   * The token occurs nowhere else, so no other query reaches them.
  --   * They carry NO EMBEDDING, so they cannot enter `alsoClose`, cannot enter
  --     `related_pulls`, and cannot shift the centroid that `private_pull_id`
  --     and `buried_pull_id` are positioned exactly on top of. A fixture that
  --     moved that centroid would break section 3 and section 8 without either
  --     of them being wrong.
  for bulk_i in 1..51 loop
    insert into public.works (kind, title, slug, rights_status)
    values ('essay', 'Bounded source ' || bulk_token || ' ' || bulk_i,
            'bounded-' || bulk_token || '-' || bulk_i, 'public_domain')
    returning id into strict bulk_work;

    insert into public.summaries (work_id, title, status, visibility, published_at)
    values (bulk_work, 'Bounded source ' || bulk_token || ' ' || bulk_i,
            'published', 'public', now())
    returning id into strict bulk_summary;

    insert into public.pulls (summary_id, ordinal, headline, body,
                              estimated_read_seconds)
    values (bulk_summary, 1,
            'An idea about ' || bulk_token || ', number ' || bulk_i,
            'A body that also says ' || bulk_token || ', so the lexical half '
            'matches it and the vector half never sees it.', 30);
  end loop;

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
  --
  -- Worth being precise about what this proves. `search_catalogue` filters on
  -- `status = 'published' and visibility = 'public'`, which is STRICTLY NARROWER
  -- than `summary_is_readable` -- so it is the RPC's own predicate, not RLS,
  -- that keeps this out, and a regression in either policy would not show up
  -- here. That is the intended design rather than an accident, and the last
  -- assertion in this section is the one that pins it down.
  res := public.search_catalogue(secret_token, 20, 10);

  if coalesce((res -> 'counts' ->> 'ideas')::int, 0) <> 0 then
    raise exception
      'another author''s private pull was findable by search. Got: %', res;
  end if;
  if coalesce((res -> 'counts' ->> 'sources')::int, 0) <> 0 then
    raise exception
      'a private summary put its work into the sources list. A work is only a '
      'result because something readable sits behind it.';
  end if;

  -- The vector half, exercised rather than assumed.
  --
  -- Searching the secret token proved nothing about the expansion: no lexical
  -- hit means no centroid, `near` is empty for ANY implementation, and deleting
  -- its visibility predicate left this green. Carrying Mill's embedding did not
  -- fix that -- see the fixture above for why it made the row 127th rather than
  -- first. The private pull now carries the centroid exactly, so its distance is
  -- zero and it sorts ahead of every real candidate.
  --
  -- Which is what gives this assertion teeth: it was verified by deleting
  -- `s.visibility = 'public'` from `near` and watching it FAIL, rather than by
  -- assuming it would.
  res := public.search_catalogue('opinion', 20, 10);
  if exists (
    select 1 from jsonb_array_elements(res -> 'alsoClose') a
    where (a ->> 'id')::uuid = private_pull_id
  ) then
    raise exception
      'the vector expansion returned a private pull. The centroid path must '
      'carry the same predicate as the lexical path.';
  end if;

  -- And it is unfindable by its own author too, which is the behaviour the
  -- narrower predicate actually produces. Asserted so that making search
  -- author-aware later is a deliberate change to this line rather than a
  -- surprise.
  perform set_config('request.jwt.claims',
    json_build_object('sub', author_id, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();
  if coalesce((public.search_catalogue(secret_token, 20, 10)
               -> 'counts' ->> 'ideas')::int, 0) <> 0 then
    raise exception
      'search found an author''s own private summary. It is meant to be narrower '
      'than RLS: search covers the published, public library only.';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', reader_blank, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

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

  if jsonb_array_length(related) = 0 then
    raise exception
      'related_pulls returned nothing for a seeded pull that has an opposes '
      'edge, so every assertion below it would pass vacuously.';
  end if;

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
    raise exception
      'related_pulls surfaced another author''s private pull. It is on its own '
      'work, so only visibility keeps it out.';
  end if;

  -- ------------------------------------------- 7. related_pulls is determinate
  --
  -- The seed stores both directions of the Mill/Walden `opposes` edge with a
  -- DIFFERENT rationale on each. They tie on every column the ranking reads, so
  -- before the direction tiebreak the reader saw one of two sentences depending
  -- on scan order. Two calls must agree, and the rationale must be the one
  -- written from this pull.
  if public.related_pulls(mill_id, 6) is distinct from related then
    raise exception
      'two identical related_pulls calls disagreed. Where both directions of an '
      'edge exist, the choice between their rationales must be made rather than '
      'stumbled upon.';
  end if;

  if not exists (
    select 1 from jsonb_array_elements(related) r
    where r ->> 'relation' = 'opposes'
      and r ->> 'rationale' like 'Mill argues%'
  ) then
    raise exception
      'the opposing edge did not carry the rationale written from Mill''s side. '
      'An edge stored FROM this pull is the one whose sentence describes it.';
  end if;

  -- ------------------------- 8. the expansion holds no keyword match at all
  --
  -- "Close to these, in other words" is a claim about the rows in it. `near`
  -- excluded only the page of lexical hits, so a match below the cut was
  -- eligible -- and was then shown as something the words had missed, under a
  -- line that had just said it was withheld. Asking for one idea and then for
  -- fifty makes the whole lexical set visible to the comparison.
  --
  -- The pair of calls is not what gives this teeth, and it is worth being blunt
  -- about that: the seeded corpus never puts a keyword hit near the centroid, so
  -- for a while this passed against the old predicate as readily as against the
  -- new one, and the sentence above described a bug the file was not testing.
  -- `buried_pull_id` is what separates them -- last of the thirteen hits for
  -- 'opinion', therefore outside `top_ideas` at `p_limit_ideas = 1`, and sitting
  -- on the centroid at distance zero. Under `not exists (... top_ideas ...)` it
  -- is the FIRST row of `alsoClose` and this raises; under the shipped
  -- `not exists (... ranked ...)` it is gone and the nearest survivor is 0.439
  -- away. Both directions were run before this comment was written.
  res       := public.search_catalogue('opinion', 1, 1);
  res_again := public.search_catalogue('opinion', 50, 50);
  if exists (
    select 1
    from jsonb_array_elements(res -> 'alsoClose') a
    join jsonb_array_elements(res_again -> 'ideas') i
      on (i ->> 'id') = (a ->> 'id')
  ) then
    raise exception
      'the vector expansion returned an idea the words already matched.';
  end if;

  -- And the fixture really is reaching the expansion, rather than being kept out
  -- by something incidental. A `near` that returned nothing at all would satisfy
  -- the assertion above without proving anything, which is the exact failure
  -- this whole section exists to stop repeating.
  if jsonb_array_length(res -> 'alsoClose') = 0 then
    raise exception
      'the vector expansion came back empty, so the check above holds vacuously.';
  end if;

  -- ------------------------- 9. a limit a stranger passes has a ceiling too
  --
  -- `greatest(p_limit_ideas, 1)` was a floor and nothing else, and this RPC is
  -- granted to `anon`. An unauthenticated caller could ask for every matching
  -- row and be handed it, bodies included -- past the 200-character query cap,
  -- and past a results page that deliberately has no expansion control.
  -- 20260901090000 clamps each page to 50.
  res := public.search_catalogue(bulk_token, 100000, 100000);

  if jsonb_array_length(res -> 'ideas') <> 50
     or jsonb_array_length(res -> 'sources') <> 50 then
    raise exception
      'search_catalogue answered a request for 100000 with % ideas and % '
      'sources. Both pages are clamped to 50: a limit with no ceiling is how a '
      'stranger makes the database build the whole library into one document.',
      jsonb_array_length(res -> 'ideas'), jsonb_array_length(res -> 'sources');
  end if;

  -- Clamped, and saying so. `counts` is what the interface reads to tell the
  -- reader how much it is not showing, and `capped` is what makes a short list
  -- legible as a short list. A clamp that shrank those too would leave the page
  -- quietly claiming the library is smaller than it is.
  if (res -> 'counts' ->> 'ideas')::int <> 51
     or (res -> 'counts' ->> 'capped')::boolean is not true then
    raise exception
      'a clamped search stopped reporting the true totals: %. The ceiling '
      'bounds what is sent, never what is counted.', res -> 'counts';
  end if;

  -- And the floor is exactly what it was before the ceiling arrived. `greatest`
  -- ignores nulls, so a null limit still means one row rather than fifty --
  -- which is what a client sends the moment it passes an absent value through.
  if jsonb_array_length(public.search_catalogue(bulk_token, 0, 0) -> 'ideas') <> 1
     or jsonb_array_length(public.search_catalogue(bulk_token, null, null) -> 'ideas') <> 1
     or jsonb_array_length(public.related_pulls(mill_id, 0)) <> 1 then
    raise exception
      'the lower bound on a limit moved when the upper bound was added.';
  end if;

  -- `related_pulls` and `get_topic` carry the same clamp and are not asserted
  -- here. Making either ceiling bite needs more than fifty sources whose pulls
  -- carry EMBEDDINGS -- and those are visible to the vector half of sections 3,
  -- 6 and 8, which are positioned against a centroid this file computes by
  -- hand. Buying one assertion by making four others measure a different corpus
  -- is a bad trade; `get_topic` belongs to catalogue.sql either way.

  raise notice 'SEARCH OK: finds seeded ideas, annotates what the reader knows '
               'without hiding it, keeps private material out of both the '
               'lexical and the vector half, is deterministic in results and in '
               'rationale, survives hostile input, never repeats a source, and '
               'never presents a keyword match as something the words missed, '
               'and clamps a caller-supplied page size at both ends';
end $$;

rollback;
