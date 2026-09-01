-- Four findings from the review round, all in SQL, all verified against the
-- hosted project before this file was written.
--
-- ===========================================================================
-- 1. The vector half of search could never use the HNSW index.
-- ===========================================================================
--
-- 20260901000500's header promises the reader "then search the HNSW index for
-- neighbours of that centroid". It has never done that, and not because the
-- planner preferred otherwise -- because the query made the index structurally
-- unreachable.
--
-- The centroid arrived via `cross join centroid c`, which makes the `<=>`
-- operand a Var of another relation. pgvector's index scan cannot supply
-- pathkeys for that, so no plan using `pulls_embedding_hnsw` exists to choose.
-- Proven by forcing every alternative off:
--
--     set local enable_seqscan = off;
--     ... cross join centroid c order by (p.embedding <=> c.v), p.id limit 24
--     ->  Sort
--           ->  Nested Loop
--                 ->  Seq Scan on pulls p          -- still, with seqscan off
--
-- while the same distance written as an InitPlan does reach it:
--
--     ->  Index Scan using pulls_embedding_hnsw on pulls p
--           Order By: (embedding <=> (InitPlan 1).col1)
--
-- WHAT WAS NOT TRUE about the finding, because it matters for the fix: an
-- InitPlan alone is not enough. With the summaries/works joins and the
-- anti-join against `ranked` sitting above it, the planner still picks
-- `pulls_pkey` and sorts -- an ordered index scan cannot be pushed through
-- them. The ordered scan has to be ON `pulls` ALONE, with everything else
-- applied afterwards. That is the shape below, and it is the standard
-- over-fetch-then-filter pattern for approximate neighbours.
--
-- THE OVER-FETCH IS SIZED, not guessed. The rows this excludes are exactly
-- `ranked` -- every lexical match -- and those are the rows *nearest* the
-- centroid, because the centroid is the mean of the top five of them. So a
-- fixed over-fetch would be eaten entirely by the exclusion on a broad query.
-- It is `count(ranked) + 120`: the exclusion can consume at most `count(ranked)`
-- of it, leaving 120 candidates for a limit of 24, which visibility and kind
-- filtering then thin by the handful of rows that are neither published nor
-- public. If a query ever matches so much of the corpus that fewer than 24
-- survive, `alsoClose` renders short -- which is the correct failure for a
-- "you might also like" strip, and not a correctness claim anyone relies on.
--
-- Worth stating plainly: at today's 156 pulls this changes no plan and saves no
-- time. `limit count(ranked) + 120` is larger than the table, so a sequential
-- scan is genuinely the cheaper plan and the planner will keep choosing it.
-- The point is that at the roadmap's ~4,800 pulls the index is now a plan the
-- planner is *able* to choose, where before it was not, at any size.
--
-- ===========================================================================
-- 2. `related_pulls` ranked the whole corpus on every source-page render.
-- ===========================================================================
--
-- Its `anchor` is already a plpgsql variable, so the operand was never the
-- problem. The unbounded window was: `row_number() over (partition by w.id
-- order by p.embedding <=> anchor, p.id)` has to compute a distance for every
-- published pull and sort all of them before it can number anything.
--
--     WindowAgg (rows=152)  Buffers: shared hit=1018
--       ->  Sort  Sort Key: w.id, ((p.embedding <=> p_1.embedding)), p.id
--             ->  Seq Scan on pulls p (rows=156)
--
-- Same fix, same reason: bound the ordered scan first, partition afterwards.
-- 200 neighbours for a limit of 6 distinct works is generous -- the per-work
-- dedup is what consumes it, and 200 neighbours span far more than 6 works.
--
-- ===========================================================================
-- 3. `search_catalogue` bounded query length from below only.
-- ===========================================================================
--
-- `length(trimmed) < 2` was the only guard, and the RPC is granted to `anon`.
-- Cost is roughly linear in query length, measured on the 156-pull corpus so
-- this is the query's cost and not the corpus's:
--
--     'opinion'                        27.6 ms
--     repeat('z ', 2000)      (4 kB)  213.6 ms
--     repeat('lorem ipsum ', 5000) (60 kB)  1901.8 ms
--
-- 200 characters. A search box entry longer than that is not a query, and the
-- cap is applied before `websearch_to_tsquery` and `similarity` rather than
-- after, which is the only place it saves anything.
--
-- The response now carries `truncated` so the interface CAN tell the reader
-- their query was shortened rather than silently answering a different
-- question. Nothing reads it yet -- `search.ts` shapes `tooShort` and ignores
-- it too -- but a flag the client may ignore is a smaller lie than a truncation
-- it cannot see.
--
-- ===========================================================================
-- 4. `generation_secret` could read a name `set_worker_secret` refuses to write.
-- ===========================================================================
--
-- 20260901060000 extended the reader's allowlist to `anthropic_api_key` and
-- stopped there. The writer is a separate function with a separate copy of the
-- same list, and it still refuses:
--
--     select public.generation_secret('anthropic_api_key');   -- null, fine
--     select public.set_worker_secret('anthropic_api_key','x');
--     ERROR:  42501: set_worker_secret: anthropic_api_key is not a worker secret
--
-- So that migration's stated purpose -- "a deployment that keeps its key in
-- Vault rather than the environment" -- had no supported way to put the key
-- there. The operator hits the identical error one function over. Half a fix is
-- worse than none here, because the reader now works and the failure has moved
-- somewhere nobody would look for it.
--
-- The two lists must move together. They are not merged into one function
-- because read and write want different privileges, and they are not read from
-- a shared table because a table is a thing that can be edited at runtime,
-- which is the property an allowlist must not have.

-- ---------------------------------------------------------------------------

-- Reproduced from 20260830051355 with ONE line changed -- the allowlist. The
-- return type, the empty-value guard and the secret description are carried
-- over verbatim rather than rewritten from memory: `create or replace` cannot
-- change a return type, so a `void` here would not have been a subtle
-- regression, it would have been a migration that fails to apply.
create or replace function public.set_worker_secret(p_name text, p_value text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing uuid;
begin
  -- Kept in lockstep with `generation_secret`. A name readable but not writable
  -- is a fix that only looks finished.
  if p_name not in ('google_ai_api_key', 'anthropic_api_key', 'worker_dispatch_token') then
    raise exception 'set_worker_secret: % is not a worker secret', p_name
      using errcode = 'insufficient_privilege';
  end if;

  if p_value is null or length(p_value) = 0 then
    raise exception 'set_worker_secret: % cannot be empty', p_name
      using errcode = 'check_violation';
  end if;

  select id into existing from vault.secrets where name = p_name;

  if existing is null then
    perform vault.create_secret(p_value, p_name, 'What a Pull generation worker secret');
  else
    perform vault.update_secret(existing, p_value);
  end if;

  return p_name;
end;
$function$;

comment on function public.set_worker_secret(text, text) is
  'Writes one of the three named worker secrets to Vault. Its allowlist is the same enumeration `generation_secret` reads by, and the two must be extended in the same migration -- a name one accepts and the other refuses is a failure that surfaces one function away from the change that caused it.';

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
    limit greatest(p_limit_ideas, 1)
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
    limit greatest(p_limit_sources, 1)
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
      'capped', (select count(*) from ranked) > greatest(p_limit_ideas, 1)
    )
  ) into result;

  return result;
end;
$$;

comment on function public.search_catalogue(text, int, int, public.work_kind[]) is
  'Lexical retrieval plus semantic expansion from stored vectors. No model runs: the centroid is an average of embeddings the corpus already holds, and the reader''s query is never embedded. Query length is capped at 200 characters before any ranking function sees it.';

-- ---------------------------------------------------------------------------

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
    order by tier, sort_key, id limit greatest(p_limit, 1)
  ) c;

  return result;
end;
$$;

comment on function public.related_pulls(uuid, int) is
  'Authored relation edges first, then nearest stored vectors, deduplicated to one idea per source. The neighbour scan is bounded at 200 so a source page does not rank the whole corpus to show six rows.';
