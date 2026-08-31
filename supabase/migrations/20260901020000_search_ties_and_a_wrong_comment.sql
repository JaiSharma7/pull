-- Five things review found in the search migration, and one sentence it taught
-- that is not true.
--
-- None of them leaks a row. All of them are the same species of defect: a result
-- that depends on which way the executor happened to walk, or a label that
-- describes something other than what the query returns.
--
-- 1. `related_pulls` showed one of two rationales at random.
--
--    The seed stores BOTH directions of the Mill/Walden `opposes` edge, with a
--    DIFFERENT sentence on each -- "Mill argues for engaging with opinions you
--    reject..." one way, "Thoreau treats attention as the scarce resource..."
--    the other. `union` only collapses identical tuples, so both survived, and
--    the two rows then tied on every column the ranking looked at: same pull,
--    same work, same tier, same `1.0 - 0.75` sort key. Which sentence a reader
--    saw was decided by scan order.
--
--    The previous comment said `union` was there "so a reciprocal pair does not
--    appear twice". It never did that. `partition by work_id` was removing the
--    duplicate, by a coin flip. So the choice is made explicit instead: an edge
--    stored FROM this pull is preferred over one stored toward it, because that
--    is the direction somebody wrote the rationale from, and kind and rationale
--    break any remaining tie. `union all` now, since the dedupe is a window
--    function rather than a side effect of set semantics.
--
-- 2. `near`'s `limit 24` was the one ordering in `search_catalogue` with no
--    tiebreak. Two seeded pulls share an axes map, and `synthetic_embedding` is
--    a pure function of it, so their vectors are identical -- once more than 24
--    candidates exist, which of a tied pair survives the cut is plan-dependent.
--    Exactly the reasoning 20260830222533 recorded for `known_ideas`.
--
-- 3. "Close to these, in other words" could contain a keyword match. `near`
--    excluded `top_ideas` -- the twelve on screen -- but not `ranked`, so the
--    thirteenth lexical hit was eligible for the vector expansion and was then
--    presented as something the words had missed, under a terminal line that
--    had just said it was withheld.
--
-- 4. `edge_rows` did not apply the rule `near` did: another idea from the same
--    source is not "related", because the source page already lists every one of
--    them in reading order. An authored edge between two pulls of one work
--    pointed the reader back into the page they were on.
--
-- 5. THE WRONG SENTENCE, corrected here because a false rule in a comment is
--    worse than no comment. The previous migration claimed a bare regconfig like
--    `to_tsvector('english', ...)` "is resolved through `search_path`, which is
--    pinned to '' inside every function here" -- implying it would fail. It does
--    not: `pg_catalog` is always implicitly searched, and the English
--    configuration lives there, so the unqualified name resolves fine even under
--    `search_path = ''`. The explicit `'pg_catalog.english'` is better style and
--    is kept, but the reason to write it is clarity, not necessity. The load-
--    bearing half of that comment was the OTHER half: the one-argument
--    `to_tsvector(text)` is merely STABLE, and a generated column rejects it.
--
--    No column is rewritten here. The generated expressions already resolved the
--    configuration to an OID at DDL time and are correct as they stand; this
--    records the correction so the next person does not carry the rule somewhere
--    it does not hold.

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
      -- Every lexical match, not just the page of them. This section is
      -- labelled "close to these, in other words"; a keyword hit that lost the
      -- ranking cut is still a keyword hit, and showing it here contradicts the
      -- terminal line that has just said it was withheld.
      and not exists (select 1 from ranked r where r.id = p.id)
    -- `p.id` because a tie here decides which row survives the cut, and two
    -- seeded pulls have byte-identical vectors.
    order by dist, p.id
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
  'Lexical search over published ideas and sources, expanded by the stored embeddings of its own best hits. No model is called: the reader''s query is never embedded. Results a reader already knows are annotated, never filtered. The expansion excludes every lexical match, not only the page of them.';

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
  'Ideas close to one idea: authored pull_relations edges first, then nearest stored embeddings, at most one per source and never from the anchor''s own source. Deterministic: where both directions of an edge exist, the one written from this pull wins. Reads a column, never a model.';
