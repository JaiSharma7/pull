-- The Delta banner reported a lifetime total on every page.
--
-- Counting directly-known cards over `visible` -- the whole published catalogue
-- minus 30 days of impressions -- was meant to keep the reported saving complete
-- after known cards stopped reaching the vector phase. But `visible` is not a
-- page, it is the corpus: a reader who has learned 4,000 ideas saw "Skipped 4000
-- ideas you already know" on page 0 and the identical number on page 1, while
-- the copy beside it claims a saving for this sitting.
--
-- It was also a cost regression against the migration it superseded. The
-- `seen_directly` test is a correlated EXISTS with a retrievability() call, and
-- putting it in `visible` meant evaluating it for every published pull on every
-- feed request -- tens of thousands of index probes -- rather than for the few
-- hundred rows that could actually be shown.
--
-- Both come from the same mistake: judging the whole corpus to describe one
-- page. A bounded pool is drawn on the cheap signals first, and only that pool
-- is asked what the reader already knows. The pool is twice the shortlist, so
-- known cards still cannot starve it -- the concern that moved this out of the
-- shortlist in the first place -- and the count now means what the UI says it
-- does: of the cards we would have shown you here, this many you already had.

create or replace function public.get_feed(
  p_limit        int    default 20,
  p_seed         bigint default 0,
  p_page         int    default 0,
  p_cards_before int    default 0,
  p_used_budget  int    default 0,
  p_last_placed  int    default null
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
  known_cap constant int := 500;
  shortlist_size int;
  pool_size int;
  result   jsonb;
begin
  -- Wide enough that semantically-covered cards cannot plausibly consume it.
  shortlist_size := greatest(300, p_limit * 20);
  -- Headroom so directly-known cards cannot consume it either.
  pool_size := shortlist_size * 2;

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
    order by public.retrievability(ks.stability, ks.last_seen_at) desc
    limit known_cap
  ),
  -- Cheap signals only: no knowledge lookup and no vector maths, so this is the
  -- one stage that may touch the whole catalogue.
  pool as (
    select p.id, p.summary_id, p.ordinal, p.headline, p.body, p.explanation,
           p.example, p.why_it_matters, p.estimated_read_seconds, p.embedding,
           s.id as sum_id, s.title as summary_title, s.published_at,
           w.id as work_id, w.title as work_title, w.slug as work_slug,
           w.kind as work_kind, w.year as work_year,
           w.quality_score, w.trust_score,
           (  0.6 * public.topic_affinity(w.id, weights)
            + 0.3 * w.quality_score
            + 0.1 * public.seeded_unit(p_seed, p_page, p.ordinal, 'shortlist')) as cheap_score
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
    order by cheap_score desc
    limit pool_size
  ),
  judged as (
    select pl.*,
           (uid is not null and exists (
             select 1 from public.knowledge_states ks
             where ks.user_id = uid and ks.pull_id = pl.id
               and public.retrievability(ks.stability, ks.last_seen_at) > 0.7
           )) as seen_directly
    from pool pl
  ),
  -- What this page would have shown and did not, because the reader has it.
  directly_known as (
    select count(*) as n, coalesce(sum(estimated_read_seconds), 0) as secs
    from judged where seen_directly
  ),
  shortlist as (
    select * from judged where not seen_directly
    order by cheap_score desc
    limit shortlist_size
  ),
  measured as (
    select sl.*, nn.nearest
    from shortlist sl
    left join lateral (
      select min(ki.embedding OPERATOR(extensions.<=>) sl.embedding) as nearest
      from known_ideas ki
      where sl.embedding is not null
    ) nn on true
  ),
  marked as (
    select m.*,
      (m.nearest is not null and m.nearest < 0.14) as covered,
      coalesce(m.nearest, 1.0) as novelty_distance
    from measured m
  ),
  scored as (
    select mk.*,
      (  0.28 * public.topic_affinity(mk.work_id, weights)
       + 0.18 * case
                  when uvec is null or mk.embedding is null then 0.5
                  else greatest(0.0, 1.0 - (mk.embedding OPERATOR(extensions.<=>) uvec))
                end
       + 0.16 * mk.quality_score
       + 0.12 * least(1.0, mk.novelty_distance)
       + 0.08 * case
                  when mk.published_at is null then 0.5
                  else greatest(0.0, 1.0 - extract(epoch from (now() - mk.published_at))
                                            / (86400.0 * 365.0))
                end
       + 0.08 * mk.trust_score
       + 0.10 * public.seeded_unit(p_seed, p_page, mk.ordinal, 'jitter')
      ) as score
    from marked mk
  ),
  diversified as (
    select s.*, row_number() over (partition by s.work_id order by s.score desc) as per_work
    from scored s
    where not s.covered
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
  covered_delta as (
    select count(*) as n, coalesce(sum(estimated_read_seconds), 0) as secs
    from scored where covered
  ),
  slots as (
    select coalesce(jsonb_agg(jsonb_build_object('slotIndex', pi.slot_index, 'kind', pi.kind)
                              order by pi.slot_index), '[]'::jsonb) as v
    from public.plan_interleave(uid, p_seed, p_page, p_limit,
                                p_cards_before, p_used_budget, p_last_placed) pi
  )
  select jsonb_build_object(
    'rows',              (select v from rows_json),
    'skippedKnownCount', (select n from directly_known) + (select n from covered_delta),
    'minutesSaved',      round((((select secs from directly_known)
                                 + (select secs from covered_delta)) / 60.0)::numeric, 1),
    'interleaveSlots',   (select v from slots),
    'page',              p_page
  ) into result;

  return result;
end;
$$;

comment on function public.get_feed(int, bigint, int, int, int, int) is
  'Personalised feed page: rows, Delta skip count, and interleaved question slots. Knowledge and vector work run only over a bounded candidate pool, so the reported saving describes this page. No LLM.';
