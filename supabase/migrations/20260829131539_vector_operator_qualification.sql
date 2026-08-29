-- `set search_path = ''` is the right hardening, but it also means operators are
-- not resolved from any schema — and pgvector's `<=>` lives in `extensions`.
-- Schema-qualify it with OPERATOR(extensions.<=>) rather than putting
-- `extensions` back on the path, so the hardening survives.

create or replace function public.get_source_delta(p_work_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid       uuid := (select auth.uid());
  total     int;
  known     int;
  minutes   double precision;
begin
  select count(*) into total
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
  where s.work_id = p_work_id and s.status = 'published';

  if uid is null or total = 0 then
    return jsonb_build_object('total', coalesce(total, 0), 'known', 0,
                              'new', coalesce(total, 0), 'minutesSaved', 0);
  end if;

  with known_ideas as (
    select p2.embedding
    from public.knowledge_states ks
    join public.pulls p2 on p2.id = ks.pull_id
    where ks.user_id = uid
      and p2.embedding is not null
      and public.retrievability(ks.stability, ks.last_seen_at) > 0.7
  ),
  candidates as (
    select p.id, p.embedding, p.estimated_read_seconds,
           exists (
             select 1 from public.knowledge_states ks
             where ks.user_id = uid and ks.pull_id = p.id
               and public.retrievability(ks.stability, ks.last_seen_at) > 0.7
           ) as seen_directly
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
    where s.work_id = p_work_id and s.status = 'published'
  ),
  judged as (
    select c.*,
           c.embedding is not null and exists (
             select 1 from known_ideas ki
             where (ki.embedding OPERATOR(extensions.<=>) c.embedding) < 0.14
           ) as covered
    from candidates c
  )
  select count(*) filter (where j.seen_directly or j.covered),
         coalesce(sum(j.estimated_read_seconds)
                  filter (where j.seen_directly or j.covered), 0) / 60.0
    into known, minutes
  from judged j;

  return jsonb_build_object(
    'total', total,
    'known', coalesce(known, 0),
    'new', total - coalesce(known, 0),
    'minutesSaved', round(coalesce(minutes, 0)::numeric, 1)
  );
end;
$$;

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
  uid        uuid := (select auth.uid());
  weights    jsonb := '{}'::jsonb;
  excluded   text[] := '{}';
  media      public.work_kind[];
  uvec       extensions.vector(1536);
  skipped    int := 0;
  saved_secs int := 0;
  out_rows   jsonb;
  out_slots  jsonb;
begin
  select coalesce(pp.topic_weights, '{}'::jsonb), coalesce(pp.excluded_topics, '{}'),
         pp.media_kinds
    into weights, excluded, media
  from public.preference_profiles pp where pp.user_id = uid;

  select ukv.embedding into uvec
  from public.user_knowledge_vectors ukv where ukv.user_id = uid;

  with known_ideas as (
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
      (uid is not null and exists (
        select 1 from public.knowledge_states ks
        where ks.user_id = uid and ks.pull_id = c.id
          and public.retrievability(ks.stability, ks.last_seen_at) > 0.7
      )) as seen_directly,
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
  surviving as (select * from scored where not (seen_directly or covered)),
  diversified as (
    select s.*, row_number() over (partition by s.work_id order by s.score desc) as per_work
    from surviving s
  ),
  final as (select * from diversified where per_work <= 2 order by score desc limit p_limit)
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
    ) order by f.score desc), '[]'::jsonb)
    into out_rows
  from final f;

  select count(*), coalesce(sum(estimated_read_seconds), 0)
    into skipped, saved_secs
  from scored where seen_directly or covered;

  select coalesce(jsonb_agg(jsonb_build_object('slotIndex', pi.slot_index, 'kind', pi.kind)
                            order by pi.slot_index), '[]'::jsonb)
    into out_slots
  from public.plan_interleave(uid, p_seed, p_page, p_limit, p_cards_before, p_used_budget) pi;

  return jsonb_build_object(
    'rows', out_rows,
    'skippedKnownCount', coalesce(skipped, 0),
    'minutesSaved', round((coalesce(saved_secs, 0) / 60.0)::numeric, 1),
    'interleaveSlots', out_slots,
    'page', p_page
  );
end;
$$;

comment on function public.get_feed is
  'Personalised feed page: rows, Delta skip count, and interleaved question slots. No LLM.';
