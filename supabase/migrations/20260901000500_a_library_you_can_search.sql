-- 156 ideas across 42 sources, and no way to find one of them.
--
-- Search is the largest hole in the product and the cheapest to close, because
-- most of what it needs is already in the database: `pulls_headline_trgm`,
-- `works_title_trgm` and `pulls_embedding_hnsw` have all existed since round 1
-- and nothing has ever queried them.
--
-- THE CONSTRAINT, and the whole reason this migration is shaped the way it is:
-- law 2 says no model runs in the read path, ever, and the README promises that
-- "ranking, search and the Delta are SQL and vector maths". A search box that
-- embeds the reader's query is a provider call per read. It is not rescued by a
-- cache -- free-text queries have a long tail, so the cold path is the common
-- path, and bounding the spend would mean rate-limiting reading, which law 3
-- forbids in spirit. It also puts a provider on the availability path of a text
-- input, and `docs/roadmap.md` already records two Gemini models returning 503
-- under load.
--
-- So the query is never embedded. Semantic recall comes from the corpus instead:
--
--   1. lexical retrieval    tsvector + websearch_to_tsquery, ranked ts_rank_cd,
--                           with trigram similarity for typos and title lookup
--   2. vector expansion     average the STORED embeddings of the best lexical
--                           hits into a centroid, then search the HNSW index for
--                           neighbours of that centroid
--   3. merge                one deterministic score
--
-- Step 2 is blind relevance feedback. It is what makes a search for "willpower"
-- surface a card about designing your environment that shares no keyword with
-- the query -- and it costs nothing, because every vector it touches was written
-- at generation time. That is what makes the README sentence literally true
-- rather than aspirational: search here demonstrably uses SQL *and* vector maths,
-- and calls nothing.
--
-- TWO INVARIANTS, asserted in `supabase/tests/search.sql` rather than trusted:
--
-- * The Delta must not filter search. Hiding a result because the reader already
--   knows it would mean the app refuses to find something you read last week,
--   which is the opposite of what a search box is for. Known results are
--   ANNOTATED (`alreadyKnown`) and still returned. The Delta earns its keep by
--   deciding what to *serve* unbidden; it has no business deciding what you may
--   *look for*.
-- * Search is deterministic. No `seeded_unit` jitter, no recency term. The feed
--   is supposed to vary between sittings; a search that reorders between two
--   identical queries is broken.

-- ---------------------------------------------------------------------------
-- Stored search vectors
-- ---------------------------------------------------------------------------
--
-- Generated columns rather than expression indexes. An expression index only
-- serves a query that repeats the expression character for character, so the
-- first caller to write it slightly differently silently gets a sequential scan
-- and nobody finds out until the corpus is large enough to hurt.
--
-- `'pg_catalog.english'`, not `'english'`. A bare regconfig name is resolved
-- through `search_path`, which is pinned to '' inside every function here -- the
-- same class of trap as the unqualified vector operator that
-- 20260829131539_vector_operator_qualification.sql exists to fix. Spelling it out
-- also makes the two-argument form explicit, which is the immutable one; the
-- one-argument `to_tsvector(text)` is merely stable and a generated column
-- rejects it.
--
-- `||` with `coalesce`, not `concat_ws`: `concat_ws` is STABLE, not IMMUTABLE,
-- so a generated column built on it does not compile.

alter table public.pulls
  add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector('pg_catalog.english', coalesce(headline, '')), 'A') ||
    setweight(to_tsvector('pg_catalog.english', coalesce(body, '')), 'B') ||
    setweight(to_tsvector('pg_catalog.english',
      coalesce(why_it_matters, '') || ' ' ||
      coalesce(example, '') || ' ' ||
      coalesce(explanation, '')), 'C')
  ) stored;

create index pulls_search_gin on public.pulls using gin (search_tsv);

alter table public.works
  add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector('pg_catalog.english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('pg_catalog.english', coalesce(subtitle, '')), 'B') ||
    setweight(to_tsvector('pg_catalog.english', coalesce(description, '')), 'C')
  ) stored;

create index works_search_gin on public.works using gin (search_tsv);

-- `works` is the one content table without a table-wide select grant:
-- 20260831013500_actually_hide_the_content_hash.sql dropped it and re-granted
-- named columns so `content_hash` stays server-side. A column added afterwards
-- therefore carries NO grant, and a `security invoker` function needs SELECT on
-- every column it touches -- including ones that only appear in a WHERE clause.
-- Without this line the search RPC returns nothing and the reason is invisible.
grant select (search_tsv) on public.works to anon, authenticated;

comment on column public.pulls.search_tsv is
  'Weighted full-text vector over headline (A), body (B) and the supporting fields (C). Generated, so it cannot drift from the row it describes.';
comment on column public.works.search_tsv is
  'Weighted full-text vector over title (A), subtitle (B) and description (C).';

-- ---------------------------------------------------------------------------
-- The search RPC
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
  uid     uuid := (select auth.uid());
  trimmed text := btrim(coalesce(p_query, ''));
  q       tsquery;
  lexical boolean;
  floor_r double precision := public.known_retrievability_floor();
  result  jsonb;
begin
  -- One character matches a large slice of the corpus by trigram and nothing by
  -- word, so it is noise rather than a search. Return the empty shape rather
  -- than a partial one: the client then has exactly one result contract to
  -- render, and "too short" is a flag on it rather than a fourth code path.
  if length(trimmed) < 2 then
    return jsonb_build_object(
      'query', trimmed,
      'ideas', '[]'::jsonb,
      'sources', '[]'::jsonb,
      'alsoClose', '[]'::jsonb,
      'counts', jsonb_build_object('ideas', 0, 'sources', 0, 'capped', false),
      'tooShort', true
    );
  end if;

  -- `websearch_to_tsquery`, not `to_tsquery`. The latter raises 42601 on input a
  -- person types by accident -- `a & & b`, an unbalanced quote -- and a search
  -- field that 500s on a stray ampersand is a bug class deleted by choosing the
  -- right parser rather than by sanitising input at every caller.
  q := websearch_to_tsquery('pg_catalog.english', trimmed);

  -- An all-stopword query ("the and of") parses to the empty tsquery, which
  -- matches nothing at all. Fall through to trigram alone instead of returning
  -- an empty page for a query that plainly has letters in it.
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
    -- RLS already restricts this to readable rows. Repeating the predicate is
    -- belt and braces, and it is also what lets the planner start from
    -- `summaries_published_idx` rather than filtering after the join.
    where s.status = 'published'
      and s.visibility = 'public'
      and (p_kinds is null or w.kind = any (p_kinds))
      and (
        -- The operator form, not `similarity(a, b) > 0.3`: only the operator is
        -- index-usable against `pulls_headline_trgm`. The function form is for
        -- scoring rows the operator has already found.
        (lexical and p.search_tsv @@ q)
        or p.headline OPERATOR(extensions.%) trimmed
      )
  ),
  -- Deterministic by construction: four terms summing to 1.00, none of them
  -- seeded, none of them time-dependent. Two identical queries a minute apart
  -- return the same order.
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
  -- Blind relevance feedback. The centroid is an average of vectors WRITTEN AT
  -- GENERATION TIME; nothing here embeds the reader's query, which is the whole
  -- law-2 argument made executable. Cosine distance is scale-invariant, so an
  -- average of unit vectors needs no renormalisation to compare correctly.
  centroid as (
    select extensions.avg(t.embedding) as v
    from (
      select ti.embedding
      from top_ideas ti
      where ti.embedding is not null
      order by ti.rank desc, ti.id
      limit 5
    ) t
  ),
  near as (
    select p.id, p.summary_id, p.headline,
           w.id as work_id, w.title as work_title,
           (p.embedding OPERATOR(extensions.<=>) c.v) as dist
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
    join public.works     w on w.id = s.work_id
    cross join centroid c
    where c.v is not null
      and s.status = 'published'
      and s.visibility = 'public'
      and p.embedding is not null
      and (p_kinds is null or w.kind = any (p_kinds))
      and not exists (select 1 from top_ideas t where t.id = p.id)
    order by dist
    limit 24
  ),
  -- One per source. Six ideas from the same book is not an expansion of the
  -- search, it is the same result six times.
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
  -- A source can match because its ideas do, or because its own title and
  -- description do. Both paths, merged on the better score.
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
      -- `works_read_all` is `using (true)`, so a work with nothing readable
      -- behind it would otherwise surface as a result you cannot open. Same
      -- rule 20260831025500 established for topics.
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
  -- ANNOTATED, never filtered. A reader looking for something they read last
  -- week must find it; the Delta decides what to serve unbidden, not what may
  -- be looked for.
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
    'ideas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', im.id,
        'summaryId', im.summary_id,
        'workId', im.work_id,
        'headline', im.headline,
        'body', im.body,
        'workTitle', im.work_title,
        'workKind', im.work_kind,
        'workYear', im.work_year,
        'estimatedReadSeconds', im.estimated_read_seconds,
        'alreadyKnown', im.already_known
      ) order by im.rank desc, im.id)
      from ideas_marked im), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ts.work_id,
        'title', ts.title,
        'subtitle', ts.subtitle,
        'slug', ts.slug,
        'kind', ts.kind,
        'year', ts.year,
        'matchingIdeas', ts.hit_count
      ) order by ts.rank desc, ts.work_id)
      from top_sources ts), '[]'::jsonb),
    'alsoClose', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ac.id,
        'summaryId', ac.summary_id,
        'workId', ac.work_id,
        'headline', ac.headline,
        'workTitle', ac.work_title
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
  'Lexical search over published ideas and sources, expanded by the stored embeddings of its own best hits. No model is called: the reader''s query is never embedded. Results a reader already knows are annotated, never filtered.';

-- Postgres grants EXECUTE to PUBLIC on a new function, so an explicit grant to
-- `authenticated` alone would not narrow anything. Revoke first, then name the
-- roles -- the pattern 20260829165938 established. `anon` is included on
-- purpose: these are `security invoker`, so RLS is what decides what comes back,
-- and a signed-out visitor may read published public rows.
revoke all on function public.search_catalogue(text, int, int, public.work_kind[])
  from public, anon, authenticated;
grant execute on function public.search_catalogue(text, int, int, public.work_kind[])
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Ideas close to one idea
-- ---------------------------------------------------------------------------
--
-- The other half of "search is vector maths", and the first visible surface for
-- Idea Lineage. Authored `pull_relations` edges come first because somebody
-- asserted them; vector neighbours fill the rest, because at ~0% edge coverage
-- on generated content the graph alone would return nothing.
--
-- No query is embedded here either -- the anchor is a column.

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
  -- RLS applies to this read, so an unreadable anchor yields null and the
  -- function returns nothing rather than leaking that the id exists.
  select p.embedding, s.work_id
    into anchor, anchor_work
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
  where p.id = p_pull_id;

  if anchor_work is null then
    return '[]'::jsonb;
  end if;

  with edges as (
    -- `pull_relations` is undirected in practice: an edge is stored once and
    -- means the same thing read from either end. Both directions, UNION rather
    -- than UNION ALL so a reciprocal pair does not appear twice.
    select pr.to_pull_id as other_id, pr.kind, pr.rationale, pr.weight
    from public.pull_relations pr where pr.from_pull_id = p_pull_id
    union
    select pr.from_pull_id, pr.kind, pr.rationale, pr.weight
    from public.pull_relations pr where pr.to_pull_id = p_pull_id
  ),
  edge_rows as (
    select p.id, p.summary_id, p.headline,
           w.id as work_id, w.title as work_title,
           e.kind::text as relation, e.rationale,
           (1.0 - coalesce(e.weight, 0.5))::double precision as sort_key
    from edges e
    join public.pulls p on p.id = e.other_id
    join public.summaries s on s.id = p.summary_id
    join public.works w on w.id = s.work_id
    where s.status = 'published' and s.visibility = 'public'
  ),
  near as (
    select p.id, p.summary_id, p.headline,
           w.id as work_id, w.title as work_title,
           null::text as relation, null::text as rationale,
           (p.embedding OPERATOR(extensions.<=>) anchor)::double precision as sort_key,
           row_number() over (
             partition by w.id
             order by p.embedding OPERATOR(extensions.<=>) anchor, p.id
           ) as rn
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
    join public.works w on w.id = s.work_id
    where s.status = 'published'
      and s.visibility = 'public'
      and p.embedding is not null
      and anchor is not null
      -- Another idea from the same source is not "related"; the source page
      -- already lists every one of them in reading order.
      and s.work_id <> anchor_work
      and p.id <> p_pull_id
      and not exists (select 1 from edge_rows er where er.id = p.id)
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
  -- One per source across BOTH tiers, not within each. An authored edge and a
  -- vector neighbour can land on the same book -- the seeded Mill/Walden
  -- `opposes` edge does exactly that -- and two rows from one source is the
  -- same result twice however each of them was found. `tier` leads the
  -- ordering, so where they collide the authored edge keeps the slot.
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
  'Ideas close to one idea: authored pull_relations edges first, then nearest stored embeddings, at most one per source. Reads a column, never a model.';

revoke all on function public.related_pulls(uuid, int)
  from public, anon, authenticated;
grant execute on function public.related_pulls(uuid, int)
  to anon, authenticated, service_role;
