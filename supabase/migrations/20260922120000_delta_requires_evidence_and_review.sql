-- Only successful recall, an explicit Already knew it answer, or a reviewed
-- equivalence can suppress an idea. Vector distance is ranking evidence only.
create table public.delta_relations (
  pull_a_id uuid not null references public.pulls (id) on delete cascade,
  pull_b_id uuid not null references public.pulls (id) on delete cascade,
  kind text not null check (kind in ('equivalent', 'opposes', 'elaborates', 'related', 'uncertain')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'disabled')),
  evidence text,
  provenance text not null,
  reviewer_refs text[] not null default array[]::text[],
  confidence real check (confidence is null or confidence between 0 and 1),
  model text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (pull_a_id, pull_b_id),
  constraint delta_relations_order check (pull_a_id < pull_b_id),
  constraint delta_relations_approval check (status <> 'approved' or (
    kind in ('equivalent', 'opposes', 'elaborates', 'related')
    and reviewed_at is not null
    and nullif(btrim(coalesce(evidence, '')), '') is not null
    and cardinality(reviewer_refs) >= 2
    and reviewer_refs[1] is not null
    and nullif(btrim(reviewer_refs[1]), '') is not null
    and reviewer_refs[2] is not null
    and nullif(btrim(reviewer_refs[2]), '') is not null
    and reviewer_refs[1] <> reviewer_refs[2]
  ))
);
create index delta_relations_b_idx on public.delta_relations (pull_b_id, pull_a_id);
create index delta_relations_approved_a_idx on public.delta_relations (pull_a_id, pull_b_id)
  where status = 'approved';
create index delta_relations_approved_b_idx on public.delta_relations (pull_b_id, pull_a_id)
  where status = 'approved';
alter table public.delta_relations enable row level security;
create policy delta_relations_read_readable on public.delta_relations
  for select using (
    status = 'approved'
    and
    exists (select 1 from public.pulls p join public.summaries s on s.id = p.summary_id
      where p.id = delta_relations.pull_a_id and public.summary_is_readable(s))
    and exists (select 1 from public.pulls p join public.summaries s on s.id = p.summary_id
      where p.id = delta_relations.pull_b_id and public.summary_is_readable(s))
  );
comment on table public.delta_relations is
  'Reviewed relation proposals. Only approved equivalent/opposes edges affect the Delta; disabling keeps provenance.';
alter table public.recall_events alter column applied_at set default clock_timestamp();
create index recall_events_delta_evidence_idx
  on public.recall_events (user_id, pull_id, applied_at desc, id desc)
  include (kind, grade);
create function public.delta_has_evidence(p_pull_id uuid)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select coalesce((
    select ((re.kind in ('review', 'recall', 'say_it_back')
               and re.grade in ('good', 'easy'))
         or (re.kind = 'delta_probe' and re.grade = 'easy'))
      and public.retrievability(ks.stability,
            least(ks.last_seen_at,
                  least(coalesce(re.submitted_at, re.applied_at), re.applied_at)))
          > public.known_retrievability_floor()
    from public.recall_events re
    join public.knowledge_states ks on ks.user_id = re.user_id and ks.pull_id = re.pull_id
    where re.user_id = (select auth.uid()) and re.pull_id = p_pull_id
      and re.kind in ('review', 'recall', 'say_it_back', 'delta_probe')
    -- Offline attempts keep their original order, but an untrusted client clock
    -- cannot place an answer later than the server applied it.
    order by least(coalesce(re.submitted_at, re.applied_at), re.applied_at) desc,
             re.applied_at desc, re.id desc
    limit 1
  ), false)
$$;
revoke all on function public.delta_has_evidence(uuid) from public, anon;
grant execute on function public.delta_has_evidence(uuid) to authenticated;
comment on function public.delta_covered_distance() is
  'Legacy vector cutoff. The feed and source Delta no longer use it to suppress ideas; distance remains a ranking clue.';
comment on function public.delta_has_evidence(uuid) is
  'Latest retrieval or explicit Already knew it evidence above the recall-time retrievability floor. A later failed recall revokes evidence; reading cannot revive expired proof.';

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
  -- Wide enough that reviewed equivalences do not consume the whole shortlist.
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
    -- Include null embeddings: a reviewed equivalence still works without one.
    select ks.pull_id, p2.embedding,
           public.retrievability(ks.stability, ks.last_seen_at) as strength
    from public.knowledge_states ks
    join public.pulls p2 on p2.id = ks.pull_id
    where uid is not null and ks.user_id = uid
      and public.retrievability(ks.stability, ks.last_seen_at)
          > public.known_retrievability_floor()
      and public.delta_has_evidence(ks.pull_id)
    -- pull_id breaks ties: retrievability is equal for everything read in the
    -- same batch, and without a tiebreak which rows survive the cap is
    -- plan-dependent, so a reader's Delta count could move with no data change.
    order by public.retrievability(ks.stability, ks.last_seen_at) desc, ks.pull_id
    limit public.known_comparison_cap()
  ),
  -- A reviewed opposition works in either storage direction. It also
  -- vetoes a conflicting equivalence for the same pair.
  opposed_pairs as materialized (
    select pr.from_pull_id candidate, ki.pull_id known
    from public.pull_relations pr join known_ideas ki on ki.pull_id = pr.to_pull_id
    where pr.kind = 'opposes'
    union
    select pr.to_pull_id, ki.pull_id
    from public.pull_relations pr join known_ideas ki on ki.pull_id = pr.from_pull_id
    where pr.kind = 'opposes'
    union
    select dr.pull_a_id, ki.pull_id
    from public.delta_relations dr join known_ideas ki on ki.pull_id = dr.pull_b_id
    where dr.kind = 'opposes' and dr.status = 'approved'
    union
    select dr.pull_b_id, ki.pull_id
    from public.delta_relations dr join known_ideas ki on ki.pull_id = dr.pull_a_id
    where dr.kind = 'opposes' and dr.status = 'approved'
  ),
  equivalent_pairs as materialized (
    select dr.pull_a_id candidate, ki.pull_id known
    from public.delta_relations dr join known_ideas ki on ki.pull_id = dr.pull_b_id
    where dr.kind = 'equivalent' and dr.status = 'approved'
    union
    select dr.pull_b_id, ki.pull_id
    from public.delta_relations dr join known_ideas ki on ki.pull_id = dr.pull_a_id
    where dr.kind = 'equivalent' and dr.status = 'approved'
  ),
  -- Distance is only a ranking hint now. Compare with the strongest 100
  -- proven-known vectors; the full 500 remain available for reviewed edges.
  -- This avoids 300-by-500 vector scans at the current catalogue size.
  ranking_ideas as materialized (
    select pull_id, embedding from known_ideas
    where embedding is not null
    order by strength desc, pull_id
    limit 100
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
               and public.delta_has_evidence(pl.id)
           )) as seen_directly
    from pool pl
  ),
  -- Direct matches count over the candidate pool, not the returned page.
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
      -- An idea this candidate contradicts contributes no ranking distance;
      -- the same opposition also vetoes an equivalent edge for that pair.
      select min(ki.embedding OPERATOR(extensions.<=>) sl.embedding) as nearest
      from ranking_ideas ki
      where sl.embedding is not null
        and not exists (
          select 1 from opposed_pairs op
          where op.candidate = sl.id and op.known = ki.pull_id
        )
    ) nn on true
  ),
  marked as (
    select m.*,
      exists (select 1 from equivalent_pairs eq where eq.candidate = m.id
        and not exists (select 1 from opposed_pairs op where op.candidate = eq.candidate
          and op.known = eq.known)) as covered,
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
   * lie. Vector distance is only a ranking clue, never suppression evidence. Dwell folds into closeness and trust into quality, as the plan
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
           (0, 'Different from recalled ideas',      e.new_lift,      e.new_ok),
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


comment on function public.get_feed(int, bigint, int, int, int, int) is
  'Personalised feed. Suppression requires recall evidence or an approved equivalent edge. Matched count is over the candidate pool and shortlist, not the returned rows.';

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

  -- Capped, like get_feed's. The two functions disagreed about how much a
  -- reader "knows" -- get_feed has always bounded this and this one bounded
  -- nothing -- so the same reader could get different answers from a source
  -- page and a feed page. Uncapped it is also linear in a whole reading
  -- history on a function every source page calls.
  -- MATERIALIZED for the reason given in get_feed: the implicit rule depends on
  -- a reference count nobody is watching, and this function is the one that
  -- measurably loses by it.
  with known_ideas as materialized (
    select ks.pull_id, p2.embedding
    from public.knowledge_states ks
    join public.pulls p2 on p2.id = ks.pull_id
    where ks.user_id = uid
      and public.retrievability(ks.stability, ks.last_seen_at)
          > public.known_retrievability_floor()
      and public.delta_has_evidence(ks.pull_id)
    order by public.retrievability(ks.stability, ks.last_seen_at) desc, ks.pull_id
    limit public.known_comparison_cap()
  ),
  -- The same edge-exact exclusion as get_feed; the reasoning is in the header.
  opposed_pairs as materialized (
    select pr.from_pull_id candidate, ki.pull_id known
    from public.pull_relations pr join known_ideas ki on ki.pull_id = pr.to_pull_id
    where pr.kind = 'opposes'
    union
    select pr.to_pull_id, ki.pull_id
    from public.pull_relations pr join known_ideas ki on ki.pull_id = pr.from_pull_id
    where pr.kind = 'opposes'
    union
    select dr.pull_a_id, ki.pull_id
    from public.delta_relations dr join known_ideas ki on ki.pull_id = dr.pull_b_id
    where dr.kind = 'opposes' and dr.status = 'approved'
    union
    select dr.pull_b_id, ki.pull_id
    from public.delta_relations dr join known_ideas ki on ki.pull_id = dr.pull_a_id
    where dr.kind = 'opposes' and dr.status = 'approved'
  ),
  equivalent_pairs as materialized (
    select dr.pull_a_id candidate, ki.pull_id known
    from public.delta_relations dr join known_ideas ki on ki.pull_id = dr.pull_b_id
    where dr.kind = 'equivalent' and dr.status = 'approved'
    union
    select dr.pull_b_id, ki.pull_id
    from public.delta_relations dr join known_ideas ki on ki.pull_id = dr.pull_a_id
    where dr.kind = 'equivalent' and dr.status = 'approved'
  ),
  candidates as (
    select p.id, p.embedding, p.estimated_read_seconds,
           exists (
             select 1 from public.knowledge_states ks
             where ks.user_id = uid and ks.pull_id = p.id
               and public.retrievability(ks.stability, ks.last_seen_at)
                   > public.known_retrievability_floor()
               and public.delta_has_evidence(p.id)
           ) as seen_directly
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
    where s.work_id = p_work_id and s.status = 'published'
  ),
  -- MATERIALIZED is load-bearing rather than decoration: `covered` is read by
  -- both aggregates below, and inlined it would be evaluated twice per
  -- candidate -- paying for the vector comparison and the relation probe again.
  judged as materialized (
    select c.*,
           exists (select 1 from equivalent_pairs eq where eq.candidate = c.id
             and not exists (select 1 from opposed_pairs op
               where op.candidate = eq.candidate and op.known = eq.known)) as covered
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

comment on function public.get_source_delta(uuid) is
  'Counts source ideas with recall evidence or an approved equivalent edge. Unmatched means unverified.';
