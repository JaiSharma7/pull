-- Less like this.
--
-- Two things the feed could not do: leave a source alone when the reader asked it to,
-- and say why a card was in front of them. Both are the foundation of 7b ("less like
-- this"): a reason the reader can read, and a mute the reader can set, on every row.
--
-- `muted_works` is the reader's own list of sources they want no more of. Written by
-- the client directly, so the policies are split by verb -- select, insert, delete,
-- each own -- rather than `for all`: invariant 5 refuses two permissive policies that
-- overlap on SELECT. The insert leg also asks that the work be readable to the caller,
-- under their own RLS on `works`, for the reason 20260909020000 gives about notes: a
-- row that names a work claims the work was there to be muted. `work_id` gets its own
-- non-partial index: the primary key covers `user_id`, and invariant 3 wants every
-- foreign key indexed on its leading column.
--
-- `get_feed` is restated from 20260831210000, its current definition; nothing later
-- touched it. The body differs in exactly these places: the `pool` CTE drops a muted
-- work beside the `feed_impressions` anti-join it copies; the `scored` CTE is split
-- into `termed` (the eight terms, each measured once and named), `scored` (the same
-- weighted sum in the same order) and `reasoned` (the reason, read off the named
-- terms); `diversified` reads from `reasoned`; and the row payload carries `reason`.
-- The weights, their order and every neutral are 20260831210000's, and
-- delta_negation.sql asserts the score for a reader who knows an opposed idea equals
-- the score for a reader who knows nothing, so a slip in any weight fails there.
--
-- Law 2 holds: SQL, an average, and a distance. No model runs in the read path.

create table public.muted_works (
  user_id  uuid        not null references auth.users (id) on delete cascade,
  work_id  uuid        not null references public.works (id) on delete cascade,
  muted_at timestamptz not null default now(),
  primary key (user_id, work_id)
);

comment on table public.muted_works is
  'Sources the reader asked to see less of. get_feed drops a muted work from the pool '
  'before anything is scored; the reader can unmute by deleting the row. See '
  '20260909050000.';

-- Law 5: in the migration that creates it.
alter table public.muted_works enable row level security;

create policy muted_works_read_own on public.muted_works
  for select using ((select auth.uid()) = user_id);

create policy muted_works_insert_own on public.muted_works
  for insert with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.works w where w.id = muted_works.work_id)
  );

create policy muted_works_delete_own on public.muted_works
  for delete using ((select auth.uid()) = user_id);

create index muted_works_work_idx on public.muted_works (work_id);

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

  -- MATERIALIZED explicitly. It is referenced three times, so Postgres would
  -- materialize it anyway today -- but that is a property of the reference
  -- count, not of the intent, and a later edit that collapses one reference
  -- would silently re-evaluate the whole knowledge join per shortlist row.
  -- Measured, `get_source_delta` loses 3.1x without it.
  with known_ideas as materialized (
    -- Carries pull_id now, so an opposed pair can be identified and dropped
    -- before any distance is taken against it.
    select ks.pull_id, p2.embedding
    from public.knowledge_states ks
    join public.pulls p2 on p2.id = ks.pull_id
    where uid is not null and ks.user_id = uid and p2.embedding is not null
      and public.retrievability(ks.stability, ks.last_seen_at)
          > public.known_retrievability_floor()
    -- pull_id breaks ties: retrievability is equal for everything read in the
    -- same batch, and without a tiebreak which rows survive the cap is
    -- plan-dependent, so a reader's Delta count could move with no data change.
    order by public.retrievability(ks.stability, ks.last_seen_at) desc, ks.pull_id
    limit public.known_comparison_cap()
  ),
  -- Edges where the reader knows one endpoint. Both directions, because the
  -- primary key is (from_pull_id, to_pull_id, kind) and opposition is stored
  -- directionally -- the seed writes both rows, nothing enforces it, and a
  -- one-sided edge must still work. UNION rather than UNION ALL: the two stored
  -- directions of one opposition would otherwise drive this join twice.
  --
  -- Restricted to known_ideas, which is correctness rather than optimisation:
  -- dropping an idea from the comparison because the candidate opposes it only
  -- makes sense if the reader actually knows it.
  --
  -- EDGE-EXACT, DELIBERATELY. An earlier version widened this set to anything
  -- within the threshold of an opposed idea, on the reasoning that a reader
  -- knows a claim through several restatements while only one carries an edge.
  -- That was unsound twice over. Distance cannot tell a restatement from a
  -- contradiction -- the whole premise of this migration -- so the widening
  -- swept in ideas that OPPOSE the opposed one, and a reader holding both sides
  -- of a debate had both removed from their comparison and was served an idea
  -- they already held as maximally novel. Gating the widening on an `opposes`
  -- edge does not rescue it: the widening exists because edges are sparse, and
  -- the gate reads a missing edge as "not opposed". Both cannot be true of the
  -- same graph, and with today's corpus -- one seeded pair, nothing generating
  -- more -- the gate would essentially never fire.
  --
  -- So the exclusion removes only what a candidate is annotated as opposing.
  -- That is incomplete: a reader who knows a claim through an unannotated
  -- restatement still has the contradiction hidden. But incomplete fails the
  -- way the old behaviour already failed, whereas the widening failed by
  -- serving known ideas as novel and could hide a contradiction outright.
  -- Closing the gap needs edges dense enough to describe claims rather than
  -- pulls, which is relation extraction's job.
  opposed_pairs as materialized (
    select pr.from_pull_id as candidate, ki.pull_id as known
    from public.pull_relations pr
    join known_ideas ki on ki.pull_id = pr.to_pull_id
    where pr.kind = 'opposes'
    union
    select pr.to_pull_id as candidate, ki.pull_id as known
    from public.pull_relations pr
    join known_ideas ki on ki.pull_id = pr.from_pull_id
    where pr.kind = 'opposes'
  ),
  /*
   * Revealed preference: the topics this reader actually slows down on.
   *
   * `topic_affinity` is *stated* preference — what they ticked in Preferences. This is
   * the other half: where their attention actually went. The two disagree often, and a
   * feed that only listens to the stated half keeps serving what someone once said
   * they wanted rather than what they read.
   *
   * Bounded twice, because this is the read path: ninety days, and the most recent
   * thousand events inside it. An unbounded scan would get slower exactly as a reader
   * became more valuable.
   *
   * Rows with no measured dwell are excluded rather than counted as zero. Every row
   * written before the tracker existed holds 0, and averaging those in would drag every
   * topic toward the floor and call it disinterest.
   */
  recent_dwell as materialized (
    select h.pull_id, h.dwell_ms
    from public.history_events h
    where uid is not null and h.user_id = uid
      and h.dwell_ms is not null and h.dwell_ms > 0
      and h.created_at > now() - interval '90 days'
    order by h.created_at desc
    limit 1000
  ),
  dwell_by_topic as materialized (
    select wt.topic_id, avg(rd.dwell_ms)::float as mean_ms
    from recent_dwell rd
    join public.pulls p2 on p2.id = rd.pull_id
    join public.summaries s2 on s2.id = p2.summary_id
    join public.work_topics wt on wt.work_id = s2.work_id
    group by wt.topic_id
  ),
  -- The reader's own average, so this measures "slower than usual for you" rather
  -- than "slower than other people". A fast reader and a slow one score alike.
  dwell_baseline as (select avg(mean_ms) as base from dwell_by_topic),
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
      -- Less like this. A muted work leaves the pool here, before anything is scored,
      -- so it costs nothing downstream and cannot come back through a tier.
      and (uid is null or not exists (
        select 1 from public.muted_works mw
        where mw.user_id = uid and mw.work_id = w.id
      ))
    order by cheap_score desc
    limit pool_size
  ),
  judged as (
    select pl.*,
           (uid is not null and exists (
             select 1 from public.knowledge_states ks
             where ks.user_id = uid and ks.pull_id = pl.id
               and public.retrievability(ks.stability, ks.last_seen_at)
                   > public.known_retrievability_floor()
           )) as seen_directly
    from pool pl
  ),
  -- What the ranker considered and dropped because the reader has it. This
  -- counts over the pool, not the page: at the p_limit the client actually
  -- sends (20) the pool is 800 rows and the page is 20, so a well-read reader
  -- can be told a number far larger than the cards in front of them. Inherited
  -- from the migration that made this per-page rather than lifetime; called out
  -- here because this file rewrites the comment that used to overstate it.
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
      -- The anti-join is the whole fix. An idea this candidate contradicts
      -- contributes no distance, so it can neither mark the candidate covered
      -- nor depress its novelty.
      select min(ki.embedding OPERATOR(extensions.<=>) sl.embedding) as nearest
      from known_ideas ki
      where sl.embedding is not null
        and not exists (
          select 1 from opposed_pairs op
          where op.candidate = sl.id and op.known = ki.pull_id
        )
    ) nn on true
  ),
  marked as (
    select m.*,
      (m.nearest is not null and m.nearest < public.delta_covered_distance()) as covered,
      coalesce(m.nearest, 1.0) as novelty_distance
    from measured m
  ),
  /*
   * The eight terms, each measured once and named, so that the score below and the
   * reason beside it are read off the same values. A term that has nothing to go on
   * is NULL here and takes its neutral 0.5 in the score, exactly as before -- the
   * weights and their order are 20260831210000's, and delta_negation.sql holds them.
   */
  termed as (
    select mk.*,
      public.topic_affinity(mk.work_id, weights) as affinity,
      /*
       * Revealed preference, capped at 0.08 and taken out of stated preference's
       * share rather than added on top — the weights sum to 1.0 and a term that
       * quietly inflates the total changes every other term's meaning.
       *
       * Stated preference keeps the larger share deliberately. What a reader asks
       * for should outrank what they linger over, or the feed stops being steerable
       * and starts optimising for time-on-card, which `docs/product.md` names as an
       * anti-goal. This is "what you read carefully", not "what held you longest".
       *
       * NULL when there is nothing to go on, and 0.5 in the score below — the same
       * neutral this file uses for a missing knowledge vector. A reader with no
       * measured dwell, and every reader before the tracker shipped, is ranked
       * exactly as they were.
       */
      (select max(least(1.0, greatest(0.0, d.mean_ms / nullif(b.base, 0) / 2.0)))
         from public.work_topics wt
         join dwell_by_topic d on d.topic_id = wt.topic_id
         cross join dwell_baseline b
        where wt.work_id = mk.work_id) as dwell_measured,
      case
        when uvec is null or mk.embedding is null then null
        else greatest(0.0, 1.0 - (mk.embedding OPERATOR(extensions.<=>) uvec))
      end as closeness_measured,
      case
        when mk.published_at is null then null
        else greatest(0.0, 1.0 - extract(epoch from (now() - mk.published_at))
                                 / (86400.0 * 365.0))
      end as recency_measured,
      public.seeded_unit(p_seed, p_page, mk.ordinal, 'jitter') as jitter
    from marked mk
  ),
  scored as (
    select t.*,
      (  0.20 * t.affinity
       + 0.08 * coalesce(t.dwell_measured, 0.5)
       + 0.18 * coalesce(t.closeness_measured, 0.5)
       + 0.16 * t.quality_score
       + 0.12 * least(1.0, t.novelty_distance)
       + 0.08 * coalesce(t.recency_measured, 0.5)
       + 0.08 * t.trust_score
       + 0.10 * t.jitter
      ) as score
    from termed t
  ),
  /*
   * WHY THIS CARD, in the reader's terms: the term that contributed most to its
   * score. Contributions -- weight times value -- are compared, not raw values, and
   * a term sitting at its neutral default is not a candidate at all. Both matter for
   * the same reader: someone new, with no preferences and no knowledge vector, has
   * affinity 0.20 * 0 = 0 and closeness 0.18 * 0.5 = 0.09, so a naive max would tell
   * a reader who has read nothing that this is close to what they have been reading.
   * Dwell folds into closeness and trust into quality, as the plan names them.
   * "A little chance" -- the jitter -- is a candidate only beside a measured signal:
   * on its own it would be every card's reason for every new reader, and a reason
   * exists so the reader can act on it. NULL when nothing about this reader or this
   * card was measured.
   *
   * On a corpus where every work is rated well -- the seed is -- "A well-regarded
   * source" will be the reason often. That is true of the corpus, not a defect of
   * the rule; a work at the schema default of 0.5 is neutral and says nothing.
   */
  reasoned as (
    select s.*,
      case
        when s.affinity > 0
          or s.closeness_measured is not null or s.dwell_measured is not null
          or s.quality_score <> 0.5 or s.trust_score <> 0.5
          or s.nearest is not null
          or coalesce(s.recency_measured, 0) > 0
        then (
          select r.label
          from (values
            ('A topic you asked for',
             (0.20 * s.affinity)::double precision,
             s.affinity > 0),
            ('Close to what you have been reading',
             (0.18 * coalesce(s.closeness_measured, 0)
              + 0.08 * coalesce(s.dwell_measured, 0))::double precision,
             s.closeness_measured is not null or s.dwell_measured is not null),
            ('A well-regarded source',
             (case when s.quality_score <> 0.5 then 0.16 * s.quality_score else 0 end
              + case when s.trust_score <> 0.5 then 0.08 * s.trust_score else 0 end
             )::double precision,
             s.quality_score <> 0.5 or s.trust_score <> 0.5),
            ('New to you',
             (0.12 * least(1.0, s.novelty_distance))::double precision,
             s.nearest is not null),
            ('Recently added',
             (0.08 * coalesce(s.recency_measured, 0))::double precision,
             coalesce(s.recency_measured, 0) > 0),
            ('A little chance',
             (0.10 * s.jitter)::double precision,
             true)
          ) as r(label, contribution, eligible)
          where r.eligible
          order by r.contribution desc, r.label
          limit 1)
      end as reason
    from scored s
  ),
  diversified as (
    select s.*, row_number() over (partition by s.work_id order by s.score desc) as per_work
    from reasoned s
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
      'score', round(f.score::numeric, 4),
      'reason', f.reason
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
