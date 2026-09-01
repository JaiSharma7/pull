-- Topics existed only as a preference input.
--
-- Thirty of them, twenty-eight with something behind them, and the only routes
-- into a source page were a card chip, a Daily Pull item, a History row, or --
-- since the previous migration -- a search. A reader who wants a *subject*
-- rather than a phrase had nowhere to go. That is precisely the complaint
-- reviewers level at Deepstash: no path from "interested in a topic" to
-- "actually understand it". We had it worse, because we had no path at all.
--
-- EXPLORE IS A CATALOGUE, NOT A FEED, and law 7 is why. A browse surface is the
-- easiest place in a product to build an unbounded list by accident, so both
-- functions here are shaped to make the page finite:
--
-- * `get_catalogue` returns the WHOLE taxonomy in one call. Six parents and
--   twenty-four children is a page and a half; there is nothing to paginate, so
--   there is no control that can lengthen the page.
-- * It leads with the size of the entire library, so a reader knows what they
--   are looking at before they start rather than discovering it by running out.
-- * `get_topic` takes a limit and returns the true total alongside it, so the
--   screen can say "40 of 57" and ask for a narrower topic instead of scrolling.
--
-- A topic with nothing readable behind it is never returned -- the rule
-- 20260831025500 established, applied to the browse surface rather than to the
-- preferences picker. `astronomy` and `chemistry` are both empty today.

-- ---------------------------------------------------------------------------
-- The whole taxonomy, with counts
-- ---------------------------------------------------------------------------

create or replace function public.get_catalogue()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with readable as (
    -- A work is in the catalogue because something readable sits behind it.
    -- `works_read_all` is `using (true)`, so without this a work whose only
    -- summary is a draft would be offered as a result you cannot open.
    select distinct s.work_id
    from public.summaries s
    where s.status = 'published' and s.visibility = 'public'
  ),
  work_ideas as (
    select s.work_id, count(p.id)::int as ideas
    from public.summaries s
    join public.pulls p on p.summary_id = s.id
    where s.status = 'published' and s.visibility = 'public'
    group by s.work_id
  ),
  topic_direct as (
    select wt.topic_id, wt.work_id
    from public.work_topics wt
    join readable r on r.work_id = wt.work_id
  ),
  -- A parent counts its children's works as well as its own.
  --
  -- The taxonomy is two levels deep and works are tagged at both, so
  -- `philosophy` carries twenty-four works directly *and* has `ethics`,
  -- `stoicism` and three more beneath it. Summing the children would double-count
  -- anything tagged to both, and counting only the parent's own rows would
  -- under-report it. The self-join covers a topic by itself plus anything whose
  -- parent it is; `distinct` below does the rest.
  topic_scope as (
    select t.id as topic_id, td.work_id
    from public.topics t
    join public.topics c on c.id = t.id or c.parent_id = t.id
    join topic_direct td on td.topic_id = c.id
  ),
  topic_counts as (
    select d.topic_id,
           count(*)::int as sources,
           coalesce(sum(d.ideas), 0)::int as ideas
    from (
      select distinct ts.topic_id, ts.work_id, coalesce(wi.ideas, 0) as ideas
      from topic_scope ts
      left join work_ideas wi on wi.work_id = ts.work_id
    ) d
    group by d.topic_id
  ),
  children as (
    select t.parent_id,
           jsonb_agg(jsonb_build_object(
             'slug', t.slug::text,
             'label', t.label,
             'sources', tc.sources,
             'ideas', tc.ideas
           ) order by t.label) as items
    from public.topics t
    join topic_counts tc on tc.topic_id = t.id
    where t.parent_id is not null and tc.sources > 0
    group by t.parent_id
  ),
  parents as (
    -- Alphabetical, not by size. This is a card catalogue: a reader finds a
    -- drawer by name, and an order that moves as the corpus grows is one nobody
    -- can build a habit on. The count sits beside each name, so depth is still
    -- visible without being what the ordering encodes.
    select jsonb_agg(jsonb_build_object(
             'slug', t.slug::text,
             'label', t.label,
             'sources', tc.sources,
             'ideas', tc.ideas,
             'children', coalesce(ch.items, '[]'::jsonb)
           ) order by t.label) as items
    from public.topics t
    join topic_counts tc on tc.topic_id = t.id
    left join children ch on ch.parent_id = t.id
    where t.parent_id is null and tc.sources > 0
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'sources', (select count(*)::int from readable),
      'ideas', (select coalesce(sum(wi.ideas), 0)::int from work_ideas wi),
      'topics', (select count(*)::int from topic_counts where sources > 0)
    ),
    'parents', coalesce((select p.items from parents p), '[]'::jsonb)
  );
$$;

comment on function public.get_catalogue() is
  'The whole topic taxonomy with per-topic source and idea counts, plus the size of the library. Returns every topic in one call because the page is meant to have a bottom. Topics with nothing readable behind them are omitted.';

revoke all on function public.get_catalogue() from public, anon, authenticated;
grant execute on function public.get_catalogue() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- One topic, and every source under it
-- ---------------------------------------------------------------------------

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
    select * from sources order by quality_score desc, title, id limit greatest(p_limit, 1)
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
  'One topic and the sources under it, a parent including its children. Reports the true source count alongside the limited list so the page can say how many it is not showing. `known` is the directly-remembered count, not the Delta''s semantic coverage.';

revoke all on function public.get_topic(text, int) from public, anon, authenticated;
grant execute on function public.get_topic(text, int) to anon, authenticated, service_role;
