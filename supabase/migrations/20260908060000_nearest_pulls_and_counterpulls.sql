-- -----------------------------------------------------------------------------
-- Package 10b: nearest_pulls and counterpulls_for_work
--
-- nearest_pulls(p_pull_id, p_k):
--   security definer, service_role only.
--   Returns k HNSW nearest neighbour pulls from other public works.
--
-- counterpulls_for_work(p_work_id):
--   security invoker, authenticated/anon.
--   Returns pulls from this work that oppose ideas the reader currently holds
--   above the retrievability floor.
-- -----------------------------------------------------------------------------

-- --------------------------------------------------------------- nearest_pulls

create or replace function public.nearest_pulls(
  p_pull_id uuid,
  p_k       int default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public', 'extensions', 'pg_temp'
as $$
declare
  anchor      extensions.vector(1536);
  anchor_work uuid;
  v_limit     int := least(greatest(coalesce(p_k, 8), 1), 50);
  v_res       jsonb;
begin
  select p.embedding, s.work_id
    into anchor, anchor_work
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
  where p.id = p_pull_id;

  if anchor is null or anchor_work is null then
    return '[]'::jsonb;
  end if;

  with candidates as (
    select
      p.id,
      p.headline,
      p.body,
      w.id as work_id,
      w.title as work_title,
      (p.embedding OPERATOR(extensions.<=>) anchor)::double precision as distance
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
    join public.works w on w.id = s.work_id
    where s.status = 'published'
      and s.visibility = 'public'
      and s.work_id <> anchor_work
      and p.id <> p_pull_id
      and p.embedding is not null
    order by p.embedding OPERATOR(extensions.<=>) anchor asc, p.id asc
    limit v_limit
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'headline', c.headline,
        'body', c.body,
        'workId', c.work_id,
        'workTitle', c.work_title,
        'distance', c.distance
      ) order by c.distance asc, c.id asc
    ),
    '[]'::jsonb
  ) into v_res
  from candidates c;

  return v_res;
end;
$$;

revoke all on function public.nearest_pulls(uuid, int) from public, anon, authenticated;
grant execute on function public.nearest_pulls(uuid, int) to service_role;

-- -------------------------------------------------------- counterpulls_for_work

create or replace function public.counterpulls_for_work(p_work_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = 'public', 'pg_temp'
as $$
declare
  uid     uuid := (select auth.uid());
  v_floor double precision := public.known_retrievability_floor();
  v_res   jsonb;
begin
  if uid is null then
    return '[]'::jsonb;
  end if;

  with work_pulls as (
    select p.id, p.headline, p.body
    from public.pulls p
    join public.summaries s on s.id = p.summary_id and public.summary_is_readable(s)
    where s.work_id = p_work_id
  ),
  opposed_edges as (
    select
      wp.id as pull_id,
      wp.headline,
      wp.body,
      other.id as opposing_pull_id,
      other.headline as opposing_headline,
      ow.id as opposing_work_id,
      ow.title as opposing_work_title,
      pr.rationale,
      pr.weight,
      public.retrievability(ks.stability, ks.last_seen_at) as retrievability
    from work_pulls wp
    join public.pull_relations pr
      on (pr.from_pull_id = wp.id or pr.to_pull_id = wp.id)
     and pr.kind = 'opposes'
    join public.pulls other
      on other.id = case when pr.from_pull_id = wp.id then pr.to_pull_id else pr.from_pull_id end
    join public.summaries os
      on os.id = other.summary_id and public.summary_is_readable(os)
    join public.works ow
      on ow.id = os.work_id
    join public.knowledge_states ks
      on ks.user_id = uid and ks.pull_id = other.id
    where public.retrievability(ks.stability, ks.last_seen_at) >= v_floor
  ),
  deduped as (
    select distinct on (oe.pull_id, oe.opposing_pull_id)
      oe.*
    from opposed_edges oe
    order by oe.pull_id, oe.opposing_pull_id, oe.retrievability desc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'pullId', d.pull_id,
        'headline', d.headline,
        'body', d.body,
        'opposingPullId', d.opposing_pull_id,
        'opposingHeadline', d.opposing_headline,
        'opposingWorkId', d.opposing_work_id,
        'opposingWorkTitle', d.opposing_work_title,
        'rationale', d.rationale,
        'weight', d.weight,
        'retrievability', d.retrievability
      ) order by d.retrievability desc, d.pull_id asc
    ),
    '[]'::jsonb
  ) into v_res
  from deduped d;

  return v_res;
end;
$$;

revoke all on function public.counterpulls_for_work(uuid) from public;
grant execute on function public.counterpulls_for_work(uuid) to anon, authenticated;
