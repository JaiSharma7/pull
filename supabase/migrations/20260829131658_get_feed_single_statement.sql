-- Fix: the Delta skip count was computed in a second statement that referenced
-- the `scored` CTE from the first. CTEs are scoped to one statement, so that
-- could never resolve. Compute the rows, the skip count and the interleave plan
-- in a single statement instead — which also means the candidate set is scanned
-- once rather than twice.
create or replace function public.get_feed(
  p_limit        int    default 20,
  p_seed         bigint default 0,
  p_page         int    default 0,
  p_cards_before int    default 0,
  p_used_budget  int    default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid      uuid := (select auth.uid());
  weights  jsonb := '{}'::jsonb;
  excluded text[] := '{}';
  media    public.work_kind[];
  uvec     extensions.vector(1536);
  result   jsonb;
begin
  select coalesce(pp.topic_weights, '{}'::jsonb), coalesce(pp.excluded_topics, '{}'),
         pp.media_kinds
    into weights, excluded, media
  from public.preference_profiles pp where pp.user_id = uid;

  select ukv.embedding into uvec
  from public.user_knowledge_vectors ukv where ukv.user_id = uid;

  with known_ideas as (
    -- Ideas this user still remembers, used for the Delta filter and novelty.
    select p2.embedding
    from public.knowledge_states ks
    join public.pulls p2 on p2.id = ks.pull_id
    where uid is not null and ks.user_id = uid and p2.embedding is not null
      and public.retrievability(ks.stability, ks.last_seen_at) > 0.7
  ),
  candidates as (
    select p.id, p.summary_id, p.ordinal, p.headline, p.body, p.explanation,
           p.example, p.why_it_matters, p.estimated_read_seconds, p.embedding,
           s.id as sum_id, s.title as summary_title, s.published_at,
           w.id as work_id, w.title as work_title, w.slug as work_slug,
           w.kind as work_kind, w.year as work_year,
           w.quality_score, w.trust_score
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
    join public.works w on w.id = s.work_id
    where s.status = 'published'
      and s.visibility = 'public'
      and (media is null or w.kind = any (media))
      and not exists (
        select 1 from public.work_topics wt
        join public.topics t on t.id = wt.topic_id
        where wt.work_id = w.id and t.slug::text = any (excluded)
      )
      and (uid is null or not exists (
        select 1 from public.feed_impressions fi
        where fi.user_id = uid and fi.pull_id = p.id
          and fi.shown_at > now() - interval '30 days'
      ))
  ),
  marked as (
    select c.*,
      -- Directly known: they have actually studied this exact card.
      (uid is not null and exists (
        select 1 from public.knowledge_states ks
        where ks.user_id = uid and ks.pull_id = c.id
          and public.retrievability(ks.stability, ks.last_seen_at) > 0.7
      )) as seen_directly,
      -- Semantically covered: a specific idea they remember says the same thing.
      -- Deliberately not measured against the centroid, which drifts toward the
      -- mean and would start matching everything.
      (c.embedding is not null and exists (
        select 1 from known_ideas ki
        where (ki.embedding OPERATOR(extensions.<=>) c.embedding) < 0.14
      )) as covered,
      coalesce((
        select min(ki.embedding OPERATOR(extensions.<=>) c.embedding) from known_ideas ki
      ), 1.0) as novelty_distance
    from candidates c
  ),
  scored as (
    select m.*,
      (  0.28 * public.topic_affinity(m.work_id, weights)
       + 0.18 * case
                  when uvec is null or m.embedding is null then 0.5
                  else greatest(0.0, 1.0 - (m.embedding OPERATOR(extensions.<=>) uvec))
                end
       + 0.16 * m.quality_score
       + 0.12 * least(1.0, m.novelty_distance)
       + 0.08 * case
                  when m.published_at is null then 0.5
                  else greatest(0.0, 1.0 - extract(epoch from (now() - m.published_at))
                                            / (86400.0 * 365.0))
                end
       + 0.08 * m.trust_score
       + 0.10 * public.seeded_unit(p_seed, p_page, m.ordinal, 'jitter')
      ) as score
    from marked m
  ),
  diversified as (
    -- At most two cards per work per page, so one prolific source cannot take
    -- over the feed.
    select s.*, row_number() over (partition by s.work_id order by s.score desc) as per_work
    from scored s
    where not (s.seen_directly or s.covered)
  ),
  final as (
    select * from diversified where per_work <= 2 order by score desc limit p_limit
  ),
  rows_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'summaryId', f.sum_id, 'ordinal', f.ordinal,
      'headline', f.headline, 'body', f.body, 'explanation', f.explanation,
      'example', f.example, 'whyItMatters', f.why_it_matters,
      'estimatedReadSeconds', f.estimated_read_seconds,
      'summaryTitle', f.summary_title,
      'work', jsonb_build_object('id', f.work_id, 'title', f.work_title,
                                 'slug', f.work_slug, 'kind', f.work_kind,
                                 'year', f.work_year),
      'score', round(f.score::numeric, 4)
    ) order by f.score desc), '[]'::jsonb) as v
    from final f
  ),
  delta as (
    select count(*) as n, coalesce(sum(estimated_read_seconds), 0) as secs
    from scored where seen_directly or covered
  ),
  slots as (
    select coalesce(jsonb_agg(jsonb_build_object('slotIndex', pi.slot_index, 'kind', pi.kind)
                              order by pi.slot_index), '[]'::jsonb) as v
    from public.plan_interleave(uid, p_seed, p_page, p_limit, p_cards_before, p_used_budget) pi
  )
  select jsonb_build_object(
    'rows',              (select v from rows_json),
    'skippedKnownCount', (select n from delta),
    'minutesSaved',      round(((select secs from delta) / 60.0)::numeric, 1),
    'interleaveSlots',   (select v from slots),
    'page',              p_page
  ) into result;

  return result;
end;
$$;

comment on function public.get_feed is
  'Personalised feed page: rows, Delta skip count, and interleaved question slots. No LLM.';
