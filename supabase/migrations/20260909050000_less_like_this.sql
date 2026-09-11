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
-- touched it. The body differs in exactly these places: the `pool` CTE is split into
-- `candidates` (the cheap columns, with `topic_affinity` computed once and carried as
-- `affinity`) and `pool` (the same cheap score, the same cut), and drops a muted work
-- beside the `feed_impressions` anti-join it copies; the `scored` CTE is split into
-- `termed` (the eight terms, each measured once and named, `affinity` read off the
-- pool) and `scored` (the same weighted sum in the same order, its weights read from
-- the one-row `weighting` CTE); after `final`, three CTEs -- `lifted`, `eligible`,
-- `reasoned` -- compute the reason for the rows that are actually emitted, not the
-- shortlist, from the same `weighting`; and the row payload carries `reason`. The
-- weights, their order and every neutral are 20260831210000's. Two things hold them:
-- the diff against that file, and muted_works.sql, which computes the sum by hand for
-- one card whose eight terms are all known and pins the served score to it.
-- delta_negation.sql holds something narrower and still worth having: that a reader
-- who knows an opposed idea scores exactly as one who knows nothing, so a change that
-- lets a contradiction back into the comparison fails there.
--
-- `get_daily_pulls` is restated from 20260907010000, its only definition, with the
-- same anti-join in its `eligible` set and in its read-back. A muted work never earns
-- a feed impression, which made every one of its pulls "unseen" and favoured them for
-- the day's picks -- the source the reader asked to see less of, in the most prominent
-- slot. Everything else in that body is verbatim; the ACL is untouched.
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
  'before anything is scored and get_daily_pulls never picks one; the reader can '
  'unmute by deleting the row. See 20260909050000.';

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

-- Nothing a reader would change on a row, but PostgREST's upsert is INSERT ... ON
-- CONFLICT DO UPDATE, and with RLS on and no UPDATE policy the conflicting row is
-- invisible to the update -- so muting a work twice, a double tap or a queued mute
-- replayed after reconnecting, was refused with 42501. Re-muting is idempotent now.
-- The readability leg is repeated here (review finding): without it an UPDATE could
-- move a mute onto a work the reader cannot read, which the insert leg forbids, and
-- the foreign key's 23503 against a made-up id would then say which private ids are
-- real. A mute is a preference on a work the reader can see, on the way in and on the
-- way through; there is no "moved after the work went private" case worth a trigger,
-- because re-muting a work that has vanished is not something a reader can do.
create policy muted_works_update_own on public.muted_works
  for update
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.works w where w.id = muted_works.work_id)
  );

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
  -- Stated preference, computed once per candidate and carried: the cheap score
  -- below and the full score in `termed` both read it, where the old body called
  -- `topic_affinity` a second time per shortlist row.
  candidates as (
    select p.id, p.summary_id, p.ordinal, p.headline, p.body, p.explanation,
           p.example, p.why_it_matters, p.estimated_read_seconds, p.embedding,
           s.id as sum_id, s.title as summary_title, s.published_at,
           w.id as work_id, w.title as work_title, w.slug as work_slug,
           w.kind as work_kind, w.year as work_year,
           w.quality_score, w.trust_score,
           public.topic_affinity(w.id, weights) as affinity,
           public.seeded_unit(p_seed, p_page, p.ordinal, 'shortlist') as shortlist_unit
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
  ),
  pool as (
    select c.*,
           (  0.6 * c.affinity
            + 0.3 * c.quality_score
            + 0.1 * c.shortlist_unit) as cheap_score
    from candidates c
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
  -- The eight weights, once. `scored` and `lifted` both read them, so the sum and the
  -- lift cannot drift apart; muted_works.sql pins the sum to 20260831210000's value
  -- for one fully known card.
  weighting as (
    select 0.20::double precision as affinity,
           0.08::double precision as dwell,
           0.18::double precision as closeness,
           0.16::double precision as quality,
           0.12::double precision as novelty,
           0.08::double precision as recency,
           0.08::double precision as trust,
           0.10::double precision as chance
  ),
  termed as (
    select mk.*,
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
      (  w.affinity  * t.affinity
       + w.dwell     * coalesce(t.dwell_measured, 0.5)
       + w.closeness * coalesce(t.closeness_measured, 0.5)
       + w.quality   * t.quality_score
       + w.novelty   * least(1.0, t.novelty_distance)
       + w.recency   * coalesce(t.recency_measured, 0.5)
       + w.trust     * t.trust_score
       + w.chance    * t.jitter
      ) as score
    from termed t
    cross join weighting w
  ),
  diversified as (
    select s.*, row_number() over (partition by s.work_id order by s.score desc) as per_work
    from scored s
    where not s.covered
  ),
  final as (
    select * from diversified where per_work <= 2 order by score desc limit p_limit
  ),
  /*
   * WHY THIS CARD, in the reader's terms: the term that lifted its score furthest
   * above what a card with nothing measured would get. Each term's LIFT is its weight
   * times its distance above its neutral -- 0 for affinity, 0.5 for everything else --
   * and only a positive lift can be the reason. Two traps this shape closes. Comparing
   * raw values or raw contributions lets a term at its neutral win: a new reader has
   * affinity 0.20 * 0 = 0 and closeness 0.18 * 0.5 = 0.09, so a naive max tells someone
   * who has read nothing that a card is close to what they have been reading. And a
   * term BELOW its neutral must not be the reason either: a source rated 0.3 still
   * contributes 0.16 * 0.3 to the score, but "A well-regarded source" over it is a
   * lie, and a candidate 0.15 from a known idea -- just past the covered line -- is
   * not "New to you". Dwell folds into closeness and trust into quality, as the plan
   * names them; a term with nothing measured sits at its neutral and lifts nothing.
   * "A little chance" -- the jitter -- is a candidate only beside a measured signal:
   * on its own it would be every card's reason for every new reader, and a reason
   * exists so the reader can act on it. NULL when nothing lifted the card.
   *
   * IN TIERS, reader first (review finding). A source's rating is the same for
   * everyone, and on a corpus rated well throughout -- the seed is 0.82 to 0.96 --
   * its lift outruns every reader-measured lift on every card, so a flat comparison
   * says "A well-regarded source" to everyone about everything and tells the reader
   * nothing about themselves. So a lift that is ABOUT THE READER -- what they asked
   * for, what they have been reading, what they do not yet know -- is the reason
   * whenever there is one; the source's own qualities speak only when nothing about
   * the reader lifted the card; and chance comes last. Within a tier, the larger lift.
   *
   * Computed here, after the cut, for the rows the reader will see -- not in the
   * shortlist, where it would run four hundred times to serve twenty.
   */
  lifted as (
    select f.*,
      (w.affinity * f.affinity)::double precision as affinity_lift,
      (  w.closeness * (coalesce(f.closeness_measured, 0.5) - 0.5)
       + w.dwell     * (coalesce(f.dwell_measured, 0.5) - 0.5))::double precision as close_lift,
      (  w.quality * (f.quality_score - 0.5)
       + w.trust   * (f.trust_score - 0.5))::double precision as regarded_lift,
      (w.novelty * (least(1.0, f.novelty_distance) - 0.5))::double precision as new_lift,
      (w.recency * (coalesce(f.recency_measured, 0.5) - 0.5))::double precision as recent_lift,
      (w.chance * (f.jitter - 0.5))::double precision as chance_lift
    from final f
    cross join weighting w
  ),
  -- Each rule once. Novelty lifts only when it was measured: with nothing known the
  -- distance defaults to 1.0, which is the absence of a comparison, not a finding.
  eligible as (
    select l.*,
      l.affinity_lift > 0                             as affinity_ok,
      l.close_lift > 0                                as close_ok,
      l.regarded_lift > 0                             as regarded_ok,
      (l.nearest is not null and l.new_lift > 0)      as new_ok,
      l.recent_lift > 0                               as recent_ok
    from lifted l
  ),
  reasoned as (
    select e.*,
      (select r.label
         from (values
           (0, 'A topic you asked for',               e.affinity_lift, e.affinity_ok),
           (0, 'Close to what you have been reading', e.close_lift,    e.close_ok),
           (0, 'New to you',                          e.new_lift,      e.new_ok),
           (1, 'A well-regarded source',              e.regarded_lift, e.regarded_ok),
           (1, 'Recently added',                      e.recent_lift,   e.recent_ok),
           (2, 'A little chance',                     e.chance_lift,
            e.chance_lift > 0
              and (e.affinity_ok or e.close_ok or e.regarded_ok or e.new_ok or e.recent_ok))
         ) as r(tier, label, lift, eligible)
        where r.eligible
        order by r.tier, r.lift desc, r.label
        limit 1) as reason
    from eligible e
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
    from reasoned f
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

-- The day's picks, restated from 20260907010000 with the mute (see the header).
create or replace function public.get_daily_pulls(p_day date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  utc_day date := (now() at time zone 'UTC')::date;
  result jsonb;
begin
  if uid is null then
    raise exception 'Sign in or start a guest session' using errcode = '42501';
  end if;
  -- Cover every real timezone, but never let a caller fill arbitrary dates.
  if p_day is null or p_day < utc_day - 1 or p_day > utc_day + 1 then
    raise exception 'Daily Pull requires your current calendar day' using errcode = '22023';
  end if;

  -- Account-wide: concurrent requests for adjacent local days must also see
  -- each other's selections before choosing. A day-scoped lock would not do so.
  perform pg_advisory_xact_lock(hashtextextended('daily:' || uid::text, 0));

  if not exists (
    select 1 from public.daily_pull_selections d where d.user_id = uid and d.day = p_day
  ) then
    with eligible as (
      select p.id,
        case when ks.pull_id is not null then 'fading' else 'unseen' end as reason
      from public.pulls p
      join public.summaries s on s.id = p.summary_id
      join public.works w on w.id = s.work_id
      left join public.knowledge_states ks on ks.pull_id = p.id and ks.user_id = uid
      where s.status = 'published' and s.visibility = 'public'
        and w.rights_status in ('public_domain', 'licensed')
        -- Less like this reaches the day's picks too (20260909050000).
        and not exists (
          select 1 from public.muted_works mw where mw.user_id = uid and mw.work_id = w.id
        )
        and (
          (ks.pull_id is not null and public.retrievability(ks.stability, ks.last_seen_at) < 0.6)
          or (ks.pull_id is null and not exists (
            select 1 from public.feed_impressions f where f.user_id = uid and f.pull_id = p.id
          ))
        )
        -- No repeats within a fortnight, including across a timezone change.
        and not exists (
          select 1 from public.daily_pull_selections d
          where d.user_id = uid and d.pull_id = p.id
            and d.day between p_day - 14 and p_day + 1
        )
    ), ranked as (
      select *, row_number() over (
        partition by reason order by md5(uid::text || p_day::text || id::text), id
      ) as bucket_rank from eligible
    ), chosen as (
      -- Reserve two fading and three unseen slots; fill missing slots from
      -- whichever pool has more. Never pad the set with well-known ideas.
      select *, case when reason = 'fading' and bucket_rank <= 2 then 0
                     when reason = 'unseen' and bucket_rank <= 3 then 0 else 1 end as overflow
      from ranked
      order by overflow, bucket_rank, reason, id
      limit 5
    )
    insert into public.daily_pull_selections(user_id, day, ordinal, pull_id, reason)
    select uid, p_day, row_number() over (order by overflow, bucket_rank, reason, id)::int,
           id, reason from chosen;
  end if;

  -- Recheck visibility every time: a saved selection cannot preserve access
  -- to an idea after its author withdraws it or its rights status changes.
  select jsonb_build_object('day', p_day, 'pulls', coalesce(jsonb_agg(
    jsonb_build_object(
      'pullId', p.id, 'ordinal', d.ordinal, 'reason', d.reason,
      'headline', p.headline, 'body', p.body, 'whyItMatters', p.why_it_matters,
      'workId', w.id, 'workTitle', w.title, 'workKind', w.kind,
      'workYear', w.year, 'summaryTitle', s.title
    ) order by d.ordinal
  ), '[]'::jsonb)) into result
  from public.daily_pull_selections d
  join public.pulls p on p.id = d.pull_id
  join public.summaries s on s.id = p.summary_id
  join public.works w on w.id = s.work_id
  where d.user_id = uid and d.day = p_day
    and s.status = 'published' and s.visibility = 'public'
    and w.rights_status in ('public_domain', 'licensed')
    -- And a work muted after today's set was chosen leaves it, the way a withdrawn
    -- one does: the selection is kept, the row is not shown.
    and not exists (
      select 1 from public.muted_works mw where mw.user_id = uid and mw.work_id = w.id
    );
  return result;
end;
$$;
