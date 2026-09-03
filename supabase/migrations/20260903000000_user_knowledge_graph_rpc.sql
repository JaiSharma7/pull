-- Returns the nodes and edges of the user's personal knowledge graph.
--
-- Joins the reader's knowledge states with published pulls, works, and
-- relation edges (lineage and counterpoints). Retrievability is computed
-- on read via retrievability(). For a reader with no knowledge states yet
-- or a signed-out visitor, returns the published canonical seed graph, and says
-- so in `source` so a caller cannot report the corpus back as personal progress.
create or replace function public.get_user_knowledge_graph(
  p_limit int default 150
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- `auth.uid()` and nothing else. This is `security invoker`, so RLS on
  -- `knowledge_states` is what scopes the read; a `p_user_id` argument could only ever
  -- name the caller, and naming anyone else returned an empty personal set and the seed
  -- graph. A parameter that cannot do what its name says is one a caller eventually
  -- believes, so it is gone rather than ignored.
  uid uuid := (select auth.uid());
  nodes_json jsonb;
  edges_json jsonb;
  -- Which graph the caller is actually looking at. Without this the seed fallback is
  -- indistinguishable from a personal graph, and anything downstream that counts nodes
  -- reports the seed corpus to a brand-new reader as though it were their own history.
  graph_source text := 'personal';
begin
  if uid is not null then
    with user_nodes as (
      select
        p.id as pull_id,
        w.id as work_id,
        w.title as work_title,
        w.kind::text as work_kind,
        p.headline,
        p.body,
        round(ks.stability::numeric, 2) as stability,
        round(ks.difficulty::numeric, 2) as difficulty,
        round(public.retrievability(ks.stability, ks.last_seen_at)::numeric, 3) as retrievability,
        ks.last_seen_at,
        case
          when public.retrievability(ks.stability, ks.last_seen_at) >= 0.8 then 'solid'
          when public.retrievability(ks.stability, ks.last_seen_at) >= 0.6 then 'refreshing'
          else 'fading'
        end as status
      from public.knowledge_states ks
      join public.pulls p on p.id = ks.pull_id
      join public.summaries s on s.id = p.summary_id
      join public.works w on w.id = s.work_id
      where ks.user_id = uid and s.status = 'published'
      order by ks.last_seen_at desc
      limit p_limit
    ),
    active_pull_ids as (
      select pull_id from user_nodes
    ),
    user_edges as (
      select
        pr.from_pull_id as from_pull_id,
        pr.to_pull_id as to_pull_id,
        pr.kind::text as kind,
        round(pr.weight::numeric, 2) as weight,
        pr.rationale
      from public.pull_relations pr
      where pr.from_pull_id in (select pull_id from active_pull_ids)
        and pr.to_pull_id in (select pull_id from active_pull_ids)
    )
    select
      coalesce(jsonb_agg(
        jsonb_build_object(
          'pullId', un.pull_id,
          'workId', un.work_id,
          'workTitle', un.work_title,
          'workKind', un.work_kind,
          'headline', un.headline,
          'body', un.body,
          'stability', un.stability,
          'difficulty', un.difficulty,
          'retrievability', un.retrievability,
          'lastSeenAt', un.last_seen_at,
          'status', un.status
        )
      ), '[]'::jsonb),
      (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'fromPullId', ue.from_pull_id,
            'toPullId', ue.to_pull_id,
            'kind', ue.kind,
            'weight', ue.weight,
            'rationale', ue.rationale
          )
        ), '[]'::jsonb)
        from user_edges ue
      )
    into nodes_json, edges_json
    from user_nodes un;
  end if;

  -- Fallback to seed corpus when no knowledge states exist
  if nodes_json is null or jsonb_array_length(nodes_json) = 0 then
    graph_source := 'seed';
    with seed_nodes as (
      select
        p.id as pull_id,
        w.id as work_id,
        w.title as work_title,
        w.kind::text as work_kind,
        p.headline,
        p.body,
        1.0::real as stability,
        0.3::real as difficulty,
        1.0::real as retrievability,
        p.created_at as last_seen_at,
        'solid'::text as status
      from public.pulls p
      join public.summaries s on s.id = p.summary_id
      join public.works w on w.id = s.work_id
      where s.status = 'published'
      order by p.created_at desc
      limit least(p_limit, 40)
    ),
    seed_pull_ids as (
      select pull_id from seed_nodes
    ),
    seed_edges as (
      select
        pr.from_pull_id as from_pull_id,
        pr.to_pull_id as to_pull_id,
        pr.kind::text as kind,
        round(pr.weight::numeric, 2) as weight,
        pr.rationale
      from public.pull_relations pr
      where pr.from_pull_id in (select pull_id from seed_pull_ids)
        and pr.to_pull_id in (select pull_id from seed_pull_ids)
    )
    select
      coalesce(jsonb_agg(
        jsonb_build_object(
          'pullId', sn.pull_id,
          'workId', sn.work_id,
          'workTitle', sn.work_title,
          'workKind', sn.work_kind,
          'headline', sn.headline,
          'body', sn.body,
          'stability', sn.stability,
          'difficulty', sn.difficulty,
          'retrievability', sn.retrievability,
          'lastSeenAt', sn.last_seen_at,
          'status', sn.status
        )
      ), '[]'::jsonb),
      (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'fromPullId', se.from_pull_id,
            'toPullId', se.to_pull_id,
            'kind', se.kind,
            'weight', se.weight,
            'rationale', se.rationale
          )
        ), '[]'::jsonb)
        from seed_edges se
      )
    into nodes_json, edges_json
    from seed_nodes sn;
  end if;

  return jsonb_build_object(
    'nodes', coalesce(nodes_json, '[]'::jsonb),
    'edges', coalesce(edges_json, '[]'::jsonb),
    'source', graph_source
  );
end;
$$;

comment on function public.get_user_knowledge_graph is
  'Returns the nodes and edges of a user knowledge graph with real-time retrievability values, plus a source of personal or seed. A caller that reports counts to a reader must check source: seed is the published corpus, not their history.';

grant execute on function public.get_user_knowledge_graph(int) to anon, authenticated;
