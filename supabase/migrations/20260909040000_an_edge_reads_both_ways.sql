/*
 * An edge reads the same in both directions.
 *
 * `pull_relations.kind` describes the `to` pull relative to the `from` pull: the seed's
 * edge from the Enchiridion to Marcus is `descendant` ("restated by a later Stoic"),
 * and the edge back is `ancestor` ("traces back to the Enchiridion"). `related_pulls`
 * walks the table in both directions, computes a `direction` marker, uses it to pick
 * the edge written FROM the anchor when both exist -- and then drops it: `edge_rows`
 * projected `kind` alone, and the payload said `relation` with no side.
 *
 * `Source.tsx` had one label map, written as if the anchor were always the `from`
 * side. For the symmetric kinds that read oddly at worst. For `ancestor` and
 * `descendant` it was inverted whenever the anchor was the `to` side: "Grew out of
 * this idea" over the idea it grew out of. Today every seeded lineage and counterpull
 * pair is stored in both directions, so the `from` edge wins the tiebreak and the page
 * happens to be right, and the one seeded edge stored one way is `related`, which
 * reads the same from either side; the first one-way `ancestor`, `descendant`,
 * `elaborates` or `supports` -- the last has had no writer since 20260908050000 added
 * it, and the pipeline will be the first -- would read backwards, and the only fix
 * would be a label map that lies for the other side.
 *
 * So the side reaches the client. `direction` is `'from'` when the edge was written
 * from the anchor (the kind describes the neighbour relative to this idea), `'to'`
 * when it was written from the neighbour (the kind describes this idea relative to
 * the neighbour), and null for a vector neighbour, which has no kind and no author.
 * The client keeps two label maps and picks by side; `lib/relations.ts`. Nothing
 * about the ranking changes: the same tiebreak, the same tiers, the same cut.
 *
 * WHY THE WHOLE FUNCTION IS RESTATED. Migrations are append-only (law 6), so a change
 * to a `create or replace` function is a new file carrying the whole body. Against
 * 20260901090000 the body differs in exactly these places: `edge_rows` projects
 * `e.direction`; `near` projects `null::int as direction`; both halves of `combined`
 * carry it; and the payload gains `'direction'`, rendered as the two words above.
 * Everything else is verbatim, including the comments; diff the two before reviewing
 * it. The ACL is untouched: `create or replace` keeps the grants 20260901000500 gave,
 * anon and authenticated included, because a source page is public.
 */

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
           e.kind::text as relation, e.rationale, e.direction,
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
           null::text as relation, null::text as rationale, null::int as direction,
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
    select id, summary_id, headline, work_id, work_title, relation, rationale, direction,
           sort_key, 0 as tier
    from edge_rows
    union all
    select id, summary_id, headline, work_id, work_title, relation, rationale, direction,
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
    'rationale', c.rationale,
    'direction', case c.direction when 0 then 'from' when 1 then 'to' end
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
  'Authored relation edges first, then nearest stored vectors, deduplicated to one idea per source. Each authored row says which side the anchor is on: direction ''from'' when the edge was written from it (the kind describes the neighbour relative to this idea), ''to'' when it was written from the neighbour, null for a vector neighbour. The neighbour scan is bounded at 200 so a source page does not rank the whole corpus to show six rows, and the answer is bounded at 50 -- ten times what the page asks for, and well short of one row per source in the library.';

-- The convention the two label maps depend on, on the column a writer will look at
-- rather than only in prose (review finding): `\d+ pull_relations` shows it, and the
-- pipeline that writes the first one-way edge has it in front of it.
comment on column public.pull_relations.kind is
  'Describes the TO pull relative to the FROM pull: from A to B, ''descendant'' means B '
  'grew out of A, ''ancestor'' means B is what A came from, ''supports'' and '
  '''elaborates'' mean B supports or elaborates on A, ''opposes'' and ''related'' read '
  'the same either way. related_pulls reports which side its anchor is on as '
  'direction; the seed stores lineage and counterpull pairs in both directions with a '
  'rationale written from each. See 20260909040000.';
