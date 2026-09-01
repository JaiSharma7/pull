-- Two findings from the review of 20260901070000 and 20260901080000. Both are
-- in SQL, both were reproduced against the hosted project before this file was
-- written, and both have the same shape: a bound enforced from one side only.
--
-- Everything below was measured inside `begin ... rollback` against the corpus
-- this file ships against -- 42 works, 156 pulls, one reader with 33 knowledge
-- states -- and left nothing behind.
--
-- ===========================================================================
-- 1. A tombstoned centroid was never refreshed once its embeddings arrived.
-- ===========================================================================
--
-- `refresh_knowledge_vector` writes a row with a NULL embedding and
-- `idea_count = 0` when a reader's known pulls carry no embeddings, stamping
-- `updated_at` with the newest `knowledge_states.last_seen_at` it saw.
-- 20260901070000 argues for that tombstone at length and the argument holds:
-- without it such a reader looks permanently un-computed, is re-selected on
-- every tick forever, and spends the batch the other readers need.
--
-- What it did not follow through on is what happens when the embeddings turn
-- up. A backfill writes to `pulls`. NOTHING IN `knowledge_states` MOVES. So the
-- watermark still equals that reader's newest knowledge state and the second
-- branch of the staleness predicate is false; the first branch wants a missing
-- row and there is one; and the centroid stays neutral until the reader happens
-- to read something new. The feed's 0.18 interest term goes on scoring the
-- constant 0.5 that migration existed to end -- for precisely the readers whose
-- material was generated rather than seeded, since `docs/roadmap.md` gates the
-- embedding backfill on relation extraction. That is the population the product
-- is growing into, not an edge case it is leaving behind.
--
-- Reproduced on the hosted project, transaction rolled back: the one real
-- reader, their 33 known pulls stripped of embeddings, their centroid deleted.
--
--     tick 1   {"refreshed": 1}   idea_count=0, embedding null, watermark stamped
--     tick 2   {"refreshed": 0}   correct -- nothing has changed
--     ... the 33 embeddings restored, as a backfill would restore them ...
--     tick 3   {"refreshed": 0}   THE BUG. Still the tombstone.
--
-- THE THIRD BRANCH is deliberately the narrowest predicate that closes this: a
-- reader whose stored `idea_count` is 0 is stale as soon as ANY pull they know
-- carries an embedding. `idea_count = 0` is exactly the tombstone and nothing
-- else -- `refresh_knowledge_vector` takes the count from `count(*)` over the
-- same subquery that produced the vector, so a null embedding and a zero count
-- are written together and cannot occur apart.
--
-- It cannot churn, which is the property to check rather than assume. That
-- subquery filters `p.embedding is not null` BEFORE it applies
-- `knowledge_vector_cap()`, so a probe that finds an embedded pull guarantees
-- the refresh behind it averages at least that one and writes `idea_count >= 1`
-- -- and the branch stops matching. Same transaction, same reader:
--
--     tick 4   {"refreshed": 1}   idea_count=33, centroid norm 0.5574
--     tick 5   {"refreshed": 0}   steady state, nothing rewritten
--     ... embeddings stripped again, centroid deleted ...
--     tick 6   {"refreshed": 1}   the tombstone is written again
--     tick 7   {"refreshed": 0}   a reader with genuinely nothing embedded is
--     tick 8   {"refreshed": 0}   still not re-selected, tick after tick
--
-- WHAT THE PROBE COSTS, planned rather than guessed. `explain (analyze,
-- buffers)` over six readers, five holding a healthy centroid and one holding a
-- tombstone:
--
--     Join Filter: (... OR ((ukv.idea_count = 0) AND EXISTS(SubPlan 1)))
--     SubPlan 1
--       ->  Nested Loop  (actual rows=1 loops=1)        -- loops=1, not 6
--
-- One probe, for the one reader whose centroid is empty. The planner costs the
-- SubPlan last and the AND short-circuits on the other five, so the extra work
-- is paid only by readers already known to hold nothing: 36 shared buffers for
-- the candidate scan with the branch, 38 without it.
--
-- The probe's own worst case is the tombstoned reader whose pulls really are
-- unembedded, because the existence test then has to look at all of them:
-- `Index Only Scan using knowledge_states_pkey` plus one `pulls_pkey` lookup
-- per row, 94 shared buffers for 30 known ideas, roughly three per idea, once
-- per tick. That is the price of the fix, and it is the right way round --
-- readers waiting on a backfill are re-examined cheaply every tick instead of
-- never being looked at again.
--
-- KNOWN INCOMPLETENESS, in the register of the migration this supersedes: a
-- reader whose embedded pulls average to a zero-length vector trips the
-- degenerate-centroid guard, is written back as `idea_count = 0`, and then
-- matches this branch on every tick. It costs one probe and one refresh out of
-- a batch of 200, it requires a centroid of norm exactly 0 against a smallest
-- observed 0.5574, and the only way to rule it out in advance is to compute the
-- centroid in order to decide whether to compute the centroid.
--
-- CONSIDERED AND NOT DONE: having the embedding backfill clear tombstones
-- itself. That is strictly cheaper and probably right eventually -- but there
-- is no backfill in this repository yet, and a knowledge model that is only
-- correct while a job which has never heard of it remembers to call something
-- is the coupling this predicate exists to avoid. A trigger on `pulls` was
-- rejected for the reason 20260901070000 rejected one on `knowledge_states`:
-- a single embedding write would fan out to every reader who knows that pull.
--
-- ===========================================================================
-- 2. Caller-supplied limits were bounded from below only.
-- ===========================================================================
--
-- `greatest(p_limit_ideas, 1)`, `greatest(p_limit_sources, 1)`,
-- `greatest(p_limit, 1)`: a floor, four times over, and a ceiling nowhere.
-- `search_catalogue`, `related_pulls` and `get_topic` are all granted to
-- `anon`, so an unauthenticated caller could ask for every matching row and be
-- given it. The 200-character query cap added in 20260901080000 bounds what the
-- ranking functions read; nothing bounded what the JSON construction wrote, and
-- the ideas array carries whole bodies.
--
-- Measured on the hosted corpus with 180 extra readable sources inserted and
-- rolled back, asking for 100000 of everything:
--
--                                       before        after
--     search_catalogue  ideas          180 rows      50 rows
--                       sources        180 rows      50 rows
--                       payload        108,134 B     31,239 B
--     related_pulls     ideas          193 rows      50 rows
--                       payload        54,510 B      14,047 B
--     get_topic         sources        207 rows      200 rows
--
-- Today the corpus is its own ceiling -- the widest query the seeded library
-- answers matches 65 of 156 pulls and builds 42 kB. The measurement that
-- matters is the rate: about 650 bytes of JSON per idea, so at the roadmap's
-- ~4,800 pulls that same 42% query is roughly 1.3 MB per request, from `anon`,
-- with no session and no cost to whoever asks.
--
-- THE CEILINGS ARE THE INTERFACE'S OWN, which is the only defensible way to
-- choose them.
--
--   * 12 and 8 are what `apps/web/src/lib/search-api.ts` sends, and
--     `routes/Search.tsx` never overrides either: the results page has no
--     expansion control at all, because design law 7 says a session shows its
--     bounds, so what was withheld is a sentence rather than a button. 50 is
--     four times the ideas page and six times the sources page, and it is the
--     largest limit anything in this repository asks for -- `supabase/tests/
--     search.sql` calls `search_catalogue('opinion', 50, 50)` to put the whole
--     lexical set in front of its section-8 comparison. Setting the ceiling
--     there leaves every existing caller byte-identical, which was checked
--     rather than assumed: `md5` of the response for twelve calls, including
--     all six the test file makes, is unchanged.
--   * `related_pulls` returns one idea per source and `routes/Source.tsx` asks
--     for five. 50 is ten times that, and still far short of handing a stranger
--     the whole library one source at a time.
--   * `get_topic` gets 200 because `apps/web/src/lib/explore.ts` defines
--     `TOPIC_MAX = 200`, the single expansion `expandLimit` will ever offer
--     before it returns null rather than a larger number. The RPC ceiling is
--     the client ceiling, so the page can always be given exactly what it asks
--     for and never more.
--
-- The clamp does not lie about itself, which matters more than the numbers.
-- `counts.ideas` and `counts.sources` still report true totals and `capped` is
-- now computed against the effective limit, so a caller who asks for 100000 and
-- receives 50 is told that 180 matched and that the list was cut. `get_topic`
-- reports `counts.shown` beside `counts.sources` for the same reason.
-- `related_pulls` returns a bare array and says nothing -- it is one idea per
-- source on a page that shows five, and there is nothing a caller could do with
-- the knowledge.
--
-- `least(greatest(x, 1), N)` rather than `least(x, N)`: the floor is preserved
-- exactly, including the detail that `greatest` ignores nulls, so a null limit
-- still lands on 1 rather than on the ceiling. Verified for every parameter at
-- null, 0 and -5.
--
-- NOT A NAMED CONSTANT, unlike `knowledge_vector_cap()` two migrations back,
-- and the difference is what the number is for. That one is a tuning knob for a
-- quantity nobody outside the database can see, so hiding it behind a function
-- makes a re-tune a one-line migration. These are ceilings on what a stranger
-- may ask for; they move only when the interface moves, and the interface's own
-- limit already lives in TypeScript where a SQL function cannot help it. A
-- constant would put each number one indirection away from the paragraph that
-- justifies it.
--
-- ---------------------------------------------------------------------------
-- Provenance, because four functions are reproduced whole below.
--
-- Every body here was taken from the file that last defined it and then checked
-- against the hosted project rather than trusted. `md5(prosrc)` matches for
-- `refresh_stale_knowledge_vectors` (51c5ad06), `search_catalogue` (a026aecf)
-- and `related_pulls` (80efd3fc), so what is reproduced is byte-for-byte what
-- is running.
--
-- `get_topic` is the exception, and it is worth recording rather than quietly
-- resolving. Its executable text matches -- both bodies hash to b118cac1 with
-- whole-line comments stripped -- but the hosted body carries an EARLIER DRAFT
-- of five comment blocks than 20260901010000 does, so that function was applied
-- from a working copy before the file was finished. This migration reproduces
-- the committed prose, which converges the two; the executable difference
-- between what is running and what is below is three lines, and all three are
-- the clamp.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Finding 1 -- the staleness predicate, with the tombstone's way out.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_stale_knowledge_vectors(p_limit int default 200)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n_limit   int := greatest(coalesce(p_limit, 0), 0);
  target    uuid;
  refreshed int := 0;
  started   timestamptz := clock_timestamp();
begin
  for target in
    select pr.id
    from public.profiles pr
    left join public.user_knowledge_vectors ukv on ukv.user_id = pr.id
    -- One backwards probe of `knowledge_recent_idx` per reader. CROSS JOIN
    -- rather than LEFT JOIN because an aggregate over no rows still returns
    -- one row holding null -- which is itself a case the predicate reads.
    cross join lateral (
      select max(ks.last_seen_at) as newest
      from public.knowledge_states ks
      where ks.user_id = pr.id
    ) k
    where (ukv.user_id is null and k.newest is not null)
       or (ukv.user_id is not null and ukv.updated_at is distinct from k.newest)
       -- The way out of a tombstone, and the only one there is.
       -- `refresh_knowledge_vector` writes `idea_count = 0` with the watermark
       -- already stamped when a reader's known pulls carry no embeddings, so
       -- neither branch above can select them again: the backfill that fixes
       -- them writes to `pulls`, and nothing in `knowledge_states` moves. The
       -- probe is paid only by readers already holding an empty centroid, and
       -- one refresh takes `idea_count` above zero, so it stops matching.
       or (ukv.user_id is not null and ukv.idea_count = 0
           and exists (select 1
                       from public.knowledge_states ks
                       join public.pulls p on p.id = ks.pull_id
                       where ks.user_id = pr.id and p.embedding is not null))
    order by ukv.updated_at asc nulls first, pr.id
    limit n_limit
  loop
    -- One definition of how a centroid is computed, called in a bounded loop,
    -- rather than a second copy of the same arithmetic inlined here. Two
    -- functions drifting apart about how much a reader knows is a bug this
    -- repo has already paid for once, between `get_feed` and
    -- `get_source_delta`; a batch path and a single-reader path that averaged
    -- different sets would be the same bug in a new place.
    perform public.refresh_knowledge_vector(target);
    refreshed := refreshed + 1;
  end loop;

  return jsonb_build_object(
    'refreshed', refreshed,
    'limit',     n_limit,
    'saturated', n_limit > 0 and refreshed >= n_limit,
    'elapsedMs', round((extract(epoch from (clock_timestamp() - started)) * 1000)::numeric, 1)
  );
end;
$$;

comment on function public.refresh_stale_knowledge_vectors(int) is
  'Recomputes the knowledge centroids of up to p_limit readers whose vector is missing, older than their newest knowledge state, empty while a pull they know has since been embedded, or left over after they forgot everything. Bounded per call and idempotent: a second run immediately after the first selects nobody and writes nothing. `saturated` in the result means the backlog did not clear.';

-- ---------------------------------------------------------------------------
-- Finding 2 -- the three RPCs a stranger can call, clamped at both ends.
-- ---------------------------------------------------------------------------

create or replace function public.search_catalogue(
  p_query         text,
  p_limit_ideas   int default 12,
  p_limit_sources int default 8,
  p_kinds         public.work_kind[] default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid       uuid := (select auth.uid());
  raw       text := btrim(coalesce(p_query, ''));
  -- Truncated before any of the expensive functions see it, which is the only
  -- position where the cap is worth anything.
  trimmed   text := left(raw, 200);
  cut       boolean := length(raw) > 200;
  -- Both ends of the page size, clamped once so `top_ideas`, `top_sources`
  -- and the `capped` flag cannot disagree about what it is. `greatest`
  -- ignores nulls, so a null limit still lands on 1 exactly as it did.
  n_ideas   int := least(greatest(p_limit_ideas, 1), 50);
  n_sources int := least(greatest(p_limit_sources, 1), 50);
  q         tsquery;
  lexical   boolean;
  floor_r   double precision := public.known_retrievability_floor();
  result    jsonb;
begin
  if length(trimmed) < 2 then
    return jsonb_build_object(
      'query', trimmed,
      'ideas', '[]'::jsonb,
      'sources', '[]'::jsonb,
      'alsoClose', '[]'::jsonb,
      'counts', jsonb_build_object('ideas', 0, 'sources', 0, 'capped', false),
      'tooShort', true,
      'truncated', false
    );
  end if;

  q := websearch_to_tsquery('pg_catalog.english', trimmed);
  lexical := q is not null and q::text <> '';

  with matched as (
    select
      p.id, p.summary_id, p.headline, p.body, p.estimated_read_seconds,
      p.embedding,
      w.id    as work_id,
      w.title as work_title,
      w.kind  as work_kind,
      w.year  as work_year,
      w.quality_score, w.trust_score,
      case when lexical then ts_rank_cd(p.search_tsv, q, 32) else 0.0 end as lex,
      extensions.similarity(p.headline, trimmed) as trg
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
    join public.works     w on w.id = s.work_id
    where s.status = 'published'
      and s.visibility = 'public'
      and (p_kinds is null or w.kind = any (p_kinds))
      and (
        (lexical and p.search_tsv @@ q)
        or p.headline OPERATOR(extensions.%) trimmed
      )
  ),
  ranked as (
    select m.*,
           (  0.55 * m.lex
            + 0.20 * coalesce(m.trg, 0.0)
            + 0.15 * m.quality_score
            + 0.10 * m.trust_score)::double precision as rank
    from matched m
  ),
  top_ideas as (
    select r.* from ranked r
    order by r.rank desc, r.id
    limit n_ideas
  ),
  centroid as (
    select extensions.avg(t.embedding)::extensions.vector(1536) as v
    from (
      select ti.embedding
      from top_ideas ti
      where ti.embedding is not null
      order by ti.rank desc, ti.id
      limit 5
    ) t
  ),
  -- The ordered scan, on `pulls` and nothing else, so an HNSW plan exists to be
  -- chosen. Every join and filter moves to `near` below. The distance is a
  -- scalar sub-select rather than a joined column for the same reason: as a Var
  -- of another relation it carries no pathkeys and the index is unreachable.
  nearest as (
    select p.id,
           p.summary_id,
           (p.embedding OPERATOR(extensions.<=>) (select cv.v from centroid cv)) as dist
    from public.pulls p
    where p.embedding is not null
      and (select cv.v from centroid cv) is not null
    order by p.embedding OPERATOR(extensions.<=>) (select cv.v from centroid cv)
    limit ((select count(*) from ranked) + 120)
  ),
  near as (
    select n.id, n.summary_id, pp.headline,
           w.id as work_id, w.title as work_title,
           n.dist
    from nearest n
    join public.pulls     pp on pp.id = n.id
    join public.summaries s  on s.id = n.summary_id
    join public.works     w  on w.id = s.work_id
    where s.status = 'published'
      and s.visibility = 'public'
      and (p_kinds is null or w.kind = any (p_kinds))
      -- Every lexical match, not just the page of them. This section is
      -- labelled "close to these, in other words"; a keyword hit that lost the
      -- ranking cut is still a keyword hit, and showing it here contradicts the
      -- terminal line that has just said it was withheld.
      and not exists (select 1 from ranked r where r.id = n.id)
    -- `n.id` because a tie here decides which row survives the cut, and two
    -- seeded pulls have byte-identical vectors.
    order by n.dist, n.id
    limit 24
  ),
  also_close as (
    select nn.id, nn.summary_id, nn.headline, nn.work_id, nn.work_title, nn.dist
    from (
      select n.*, row_number() over (partition by n.work_id order by n.dist, n.id) as rn
      from near n
    ) nn
    where nn.rn = 1
    order by nn.dist, nn.id
    limit 6
  ),
  source_from_ideas as (
    select r.work_id, max(r.rank) as rank, count(*)::int as hit_count
    from ranked r group by r.work_id
  ),
  source_from_works as (
    select w.id as work_id,
           (  0.55 * (case when lexical then ts_rank_cd(w.search_tsv, q, 32) else 0.0 end)
            + 0.20 * coalesce(extensions.similarity(w.title, trimmed), 0.0)
            + 0.15 * w.quality_score
            + 0.10 * w.trust_score)::double precision as rank,
           0 as hit_count
    from public.works w
    where (p_kinds is null or w.kind = any (p_kinds))
      and exists (
        select 1 from public.summaries s
        where s.work_id = w.id and s.status = 'published' and s.visibility = 'public'
      )
      and (
        (lexical and w.search_tsv @@ q)
        or w.title OPERATOR(extensions.%) trimmed
      )
  ),
  source_union as (
    select u.work_id, max(u.rank) as rank, max(u.hit_count) as hit_count
    from (
      select work_id, rank, hit_count from source_from_ideas
      union all
      select work_id, rank, hit_count from source_from_works
    ) u
    group by u.work_id
  ),
  top_sources as (
    select su.work_id, su.rank, su.hit_count,
           w.title, w.subtitle, w.slug, w.kind, w.year
    from source_union su
    join public.works w on w.id = su.work_id
    order by su.rank desc, su.work_id
    limit n_sources
  ),
  ideas_marked as (
    select t.*,
           (uid is not null and exists (
              select 1 from public.knowledge_states ks
              where ks.user_id = uid
                and ks.pull_id = t.id
                and public.retrievability(ks.stability, ks.last_seen_at) > floor_r
           )) as already_known
    from top_ideas t
  )
  select jsonb_build_object(
    'query', trimmed,
    'tooShort', false,
    'truncated', cut,
    'ideas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', im.id, 'summaryId', im.summary_id, 'workId', im.work_id,
        'headline', im.headline, 'body', im.body, 'workTitle', im.work_title,
        'workKind', im.work_kind, 'workYear', im.work_year,
        'estimatedReadSeconds', im.estimated_read_seconds,
        'alreadyKnown', im.already_known
      ) order by im.rank desc, im.id)
      from ideas_marked im), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ts.work_id, 'title', ts.title, 'subtitle', ts.subtitle,
        'slug', ts.slug, 'kind', ts.kind, 'year', ts.year,
        'matchingIdeas', ts.hit_count
      ) order by ts.rank desc, ts.work_id)
      from top_sources ts), '[]'::jsonb),
    'alsoClose', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ac.id, 'summaryId', ac.summary_id, 'workId', ac.work_id,
        'headline', ac.headline, 'workTitle', ac.work_title
      ) order by ac.dist, ac.id)
      from also_close ac), '[]'::jsonb),
    'counts', jsonb_build_object(
      'ideas', (select count(*)::int from ranked),
      'sources', (select count(*)::int from source_union),
      'capped', (select count(*) from ranked) > n_ideas
    )
  ) into result;

  return result;
end;
$$;

comment on function public.search_catalogue(text, int, int, public.work_kind[]) is
  'Lexical retrieval plus semantic expansion from stored vectors. No model runs: the centroid is an average of embeddings the corpus already holds, and the reader''s query is never embedded. Query length is capped at 200 characters before any ranking function sees it, and each page size is clamped to 50 -- `counts` still reports the true totals, so a clamped answer is a visible one.';

create or replace function public.related_pulls(p_pull_id uuid, p_limit int default 6)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  anchor      extensions.vector(1536);
  anchor_work uuid;
  -- One idea per source, so 50 sits far above what the page asks for (five)
  -- and far below handing a stranger the whole library one work at a time.
  n_limit     int := least(greatest(p_limit, 1), 50);
  result      jsonb;
begin
  select p.embedding, s.work_id
    into anchor, anchor_work
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
  where p.id = p_pull_id;

  if anchor_work is null then
    return '[]'::jsonb;
  end if;

  with edges as (
    -- `union all`, and a direction marker. An edge is stored once per direction
    -- and the seed writes BOTH, with a different rationale on each -- so set
    -- semantics never collapsed them, and every downstream tiebreak was blind
    -- to the only column that differed.
    select pr.to_pull_id as other_id, pr.kind, pr.rationale, pr.weight, 0 as direction
    from public.pull_relations pr where pr.from_pull_id = p_pull_id
    union all
    select pr.from_pull_id, pr.kind, pr.rationale, pr.weight, 1
    from public.pull_relations pr where pr.to_pull_id = p_pull_id
  ),
  edge_pick as (
    -- One row per neighbouring pull, chosen rather than stumbled upon: an edge
    -- written FROM this pull wins, because that is the direction its rationale
    -- was written from. Kind and rationale settle anything still tied, so the
    -- same anchor always renders the same sentence.
    select e.*,
           row_number() over (
             partition by e.other_id
             order by e.direction, e.kind::text, coalesce(e.rationale, '')
           ) as rn
    from edges e
  ),
  edge_rows as (
    select p.id, p.summary_id, p.headline,
           w.id as work_id, w.title as work_title,
           e.kind::text as relation, e.rationale,
           (1.0 - coalesce(e.weight, 0.5))::double precision as sort_key
    from edge_pick e
    join public.pulls p on p.id = e.other_id
    join public.summaries s on s.id = p.summary_id
    join public.works w on w.id = s.work_id
    where e.rn = 1
      and s.status = 'published' and s.visibility = 'public'
      -- The same rule the vector half applies, and it was missing here: another
      -- idea from this source is not "related", because the source page already
      -- lists every one of them in reading order.
      and s.work_id <> anchor_work
      and p.id <> p_pull_id
  ),
  -- Bounded, and on `pulls` alone. The window below needs a distance for every
  -- row it numbers, so leaving it unbounded meant ranking the entire corpus to
  -- return six rows -- on every source-page render.
  nearest as (
    select p.id,
           p.summary_id,
           (p.embedding OPERATOR(extensions.<=>) anchor)::double precision as dist
    from public.pulls p
    where p.embedding is not null
      and anchor is not null
      and p.id <> p_pull_id
    order by p.embedding OPERATOR(extensions.<=>) anchor
    limit 200
  ),
  near as (
    select n.id, n.summary_id, pp.headline,
           w.id as work_id, w.title as work_title,
           null::text as relation, null::text as rationale,
           n.dist as sort_key,
           row_number() over (partition by w.id order by n.dist, n.id) as rn
    from nearest n
    join public.pulls     pp on pp.id = n.id
    join public.summaries s  on s.id = n.summary_id
    join public.works     w  on w.id = s.work_id
    where s.status = 'published'
      and s.visibility = 'public'
      and s.work_id <> anchor_work
      and not exists (select 1 from edge_rows er where er.id = n.id)
  ),
  combined as (
    select id, summary_id, headline, work_id, work_title, relation, rationale,
           sort_key, 0 as tier
    from edge_rows
    union all
    select id, summary_id, headline, work_id, work_title, relation, rationale,
           sort_key, 1 as tier
    from near where rn = 1
  ),
  deduped as (
    select c.*,
           row_number() over (
             partition by c.work_id order by c.tier, c.sort_key, c.id
           ) as pick
    from combined c
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'summaryId', c.summary_id,
    'workId', c.work_id,
    'headline', c.headline,
    'workTitle', c.work_title,
    'relation', c.relation,
    'rationale', c.rationale
  ) order by c.tier, c.sort_key, c.id), '[]'::jsonb)
    into result
  from (
    select * from deduped where pick = 1
    order by tier, sort_key, id limit n_limit
  ) c;

  return result;
end;
$$;

comment on function public.related_pulls(uuid, int) is
  'Authored relation edges first, then nearest stored vectors, deduplicated to one idea per source. The neighbour scan is bounded at 200 so a source page does not rank the whole corpus to show six rows, and the answer is bounded at 50 -- ten times what the page asks for, and well short of one row per source in the library.';

create or replace function public.get_topic(p_slug text, p_limit int default 40)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid       uuid := (select auth.uid());
  floor_r   double precision := public.known_retrievability_floor();
  t_id      uuid;
  t_slug    text;
  t_label   text;
  p_pslug   text;
  p_plabel  text;
  -- 200 is `TOPIC_MAX` in apps/web/src/lib/explore.ts: the one expansion the
  -- topic page offers, and so the largest limit the product can ask for.
  n_limit   int := least(greatest(p_limit, 1), 200);
  result    jsonb;
begin
  -- `lower(slug::text)` rather than the citext comparison. `topics.slug` is
  -- citext, so `=` would already fold case, but the cast keeps this function
  -- from depending on an extension type in its argument list -- and at thirty
  -- rows the unused unique index costs nothing worth naming.
  select t.id, t.slug::text, t.label, pt.slug::text, pt.label
    into t_id, t_slug, t_label, p_pslug, p_plabel
  from public.topics t
  left join public.topics pt on pt.id = t.parent_id
  where lower(t.slug::text) = lower(btrim(coalesce(p_slug, '')));

  if t_id is null then
    return null;
  end if;

  with scope as (
    -- Same self-join as the catalogue: a parent topic shows its children's
    -- sources too, or opening "Philosophy" would list fewer works than the
    -- catalogue page just said it had.
    select distinct wt.work_id
    from public.topics c
    join public.work_topics wt on wt.topic_id = c.id
    where c.id = t_id or c.parent_id = t_id
  ),
  sources as (
    select w.id, w.title, w.subtitle, w.slug::text as slug, w.kind::text as kind,
           w.year, w.quality_score,
           (select count(*)::int
              from public.summaries s
              join public.pulls p on p.summary_id = s.id
             where s.work_id = w.id
               and s.status = 'published' and s.visibility = 'public') as ideas,
           -- DIRECTLY known only -- a `knowledge_states` row above the
           -- retrievability floor -- not the Delta's semantic `covered` test.
           --
           -- The full Delta needs a vector comparison per candidate, and
           -- `get_source_delta` pays that for ONE work. Paying it for forty on a
           -- browse page is the shape docs/roadmap.md already warns about
           -- ("needs a precomputed neighbour table before a library grows
           -- large"). So this counts what it can count exactly and cheaply, and
           -- the screen says "you know" rather than "new to you", because that
           -- is what the number actually measures. The full Delta stays on the
           -- source page, where it is one work and it is honest.
           (select count(*)::int
              from public.summaries s
              join public.pulls p on p.summary_id = s.id
              join public.knowledge_states ks
                on ks.pull_id = p.id and ks.user_id = uid
             where s.work_id = w.id
               and s.status = 'published' and s.visibility = 'public'
               and uid is not null
               and public.retrievability(ks.stability, ks.last_seen_at) > floor_r) as known
    from public.works w
    join scope sc on sc.work_id = w.id
    where exists (
      select 1 from public.summaries s
      where s.work_id = w.id and s.status = 'published' and s.visibility = 'public'
    )
  ),
  shown as (
    -- Quality first so the ordering means something once the pipeline writes a
    -- real score; title second so it is deterministic today, when every
    -- generated work still sits at the 0.5 default and quality alone would
    -- leave the order to the planner.
    select * from sources order by quality_score desc, title, id limit n_limit
  )
  select jsonb_build_object(
    'topic', jsonb_build_object(
      'slug', t_slug, 'label', t_label,
      'parentSlug', p_pslug, 'parentLabel', p_plabel
    ),
    'counts', jsonb_build_object(
      'sources', (select count(*)::int from sources),
      'ideas', (select coalesce(sum(ideas), 0)::int from sources),
      'known', (select coalesce(sum(known), 0)::int from sources),
      'shown', (select count(*)::int from shown)
    ),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sh.id, 'title', sh.title, 'subtitle', sh.subtitle,
        'slug', sh.slug, 'kind', sh.kind, 'year', sh.year,
        'ideas', sh.ideas, 'known', sh.known
      ) order by sh.quality_score desc, sh.title, sh.id)
      from shown sh), '[]'::jsonb)
  ) into result;

  -- A topic that exists but holds nothing readable is not a topic a reader can
  -- open. Null, so the screen renders "not found" rather than an empty page
  -- that looks like a failed request.
  if (result -> 'counts' ->> 'sources')::int = 0 then
    return null;
  end if;

  return result;
end;
$$;

comment on function public.get_topic(text, int) is
  'One topic and the sources under it, a parent including its children. Reports the true source count alongside the limited list so the page can say how many it is not showing, and clamps that list to 200 -- `TOPIC_MAX` in the client, the one expansion the topic page offers. `known` is the directly-remembered count, not the Delta''s semantic coverage.';
