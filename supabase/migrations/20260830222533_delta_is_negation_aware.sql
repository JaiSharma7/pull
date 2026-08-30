-- The Delta filed a contradiction as something the reader already knows.
--
-- `covered` asked one question -- is this within 0.14 of an idea you know? --
-- and measured against real Gemini embeddings that question cannot tell
-- agreement from disagreement:
--
--   0.0987  same idea, reworded            covered, correctly
--   0.0618  same topic, OPPOSED claim      covered, wrongly
--   0.1474  related but distinct           new, correctly
--
-- An opposed claim sits CLOSER than a paraphrase. So the read path hid exactly
-- the material Counterpull and the Conviction Ledger exist to surface.
--
-- This is not a threshold that needs re-tuning. No value separates 0.0618 from
-- 0.0987; embeddings barely encode negation, and no constant recovers
-- information the vectors do not carry. The 0.0618 is not a fact about
-- redundancy at all -- it is a measurement artifact.
--
-- So rather than exempting the candidate from a test built on a number we know
-- to be false, or flooring the score that number produces, this removes opposed
-- pairs from the comparison itself. `covered` and `novelty_distance` then both
-- come out right with no special case downstream: a contradiction is judged
-- against everything the reader knows EXCEPT the ideas it contradicts. It is
-- novel if nothing else is near it, redundant if it genuinely duplicates
-- something else. It earns its rank rather than being handed one.
--
-- An earlier version of this migration exempted the candidate from `covered`
-- and floored its novelty at the threshold. Measured on a live stack, that
-- design did not work: the contradiction survived the filter and then ranked
-- last -- 0.0268 against 0.1380 and 0.1600 -- because the floor is worth
-- 0.12 x (0.14 - 0.0618) = 0.0094 of a score whose weights sum to 1.0, against
-- the 0.12 a merely-novel card earns. It was not hidden by the filter; it was
-- hidden by the scorer instead. `supabase/tests/delta_negation.sql` asserts
-- against that specific failure.
--
-- Nothing writes `pull_relations` yet -- the twelve pipeline steps never emit
-- edges -- so this is live for the seeded corpus and inert for generated
-- content until a step produces edges. That is deliberate sequencing, not an
-- oversight: it unblocks the real-embedding backfill of the seed corpus, which
-- is what the defect above would otherwise have corrupted.
--
-- One edge case, recorded rather than handled: if a known pull's summary is
-- later unpublished, its `opposes` edge stops being visible under
-- `pull_relations_read_readable` -- but the same pull also drops out of
-- `known_ideas`, which joins `public.pulls` under `pulls_read_via_summary`.
-- Coverage and exclusion key off the same visibility and cancel out.

-- ---------------------------------------------------------------------------
-- The two constants the read path judges by, in one place each.
--
-- `set search_path` is pinned on both. It is free: a zero-argument immutable
-- function is constant-folded by the planner whether or not it can be inlined,
-- and both forms produce identical plans. Omitting it would break the
-- convention every other function in `public` follows and would trip the
-- `function_search_path_mutable` advisor, which is not scoped to SECURITY
-- DEFINER.
-- ---------------------------------------------------------------------------

create function public.delta_covered_distance()
returns double precision
language sql
immutable
parallel safe
set search_path = ''
as $$ select 0.14::double precision $$;

comment on function public.delta_covered_distance() is
  'Cosine distance below which a candidate counts as already known. Tuned against synthetic embeddings; deserves a real distribution once the corpus carries measured ones. Opposed pairs are excluded from the comparison before this applies, because distance cannot see negation.';

create function public.known_retrievability_floor()
returns double precision
language sql
immutable
parallel safe
set search_path = ''
as $$ select 0.7::double precision $$;

comment on function public.known_retrievability_floor() is
  'Retrievability above which the reader is treated as still knowing an idea. One definition of "knows", shared by the feed, the Delta and the source delta.';

-- ---------------------------------------------------------------------------
-- `kind = 'opposes'` cannot become an index condition under RLS: `enum_eq` is
-- not leakproof, so the planner may not push it below the security-barrier
-- quals of `pull_relations_read_readable`. It lands in Filter, AFTER the
-- policy, and every unrelated edge then pays that policy in full -- which
-- expands to eight `summary_is_readable()` calls per row visited.
--
-- A partial index predicate is a plan-time constraint rather than a runtime
-- qual, so it escapes the leakproof rule entirely: only `opposes` rows ever
-- enter the scan, and the policy never runs on the rest.
-- ---------------------------------------------------------------------------

create index pull_relations_opposes_from_idx
  on public.pull_relations (from_pull_id, to_pull_id) where kind = 'opposes';

create index pull_relations_opposes_to_idx
  on public.pull_relations (to_pull_id, from_pull_id) where kind = 'opposes';

-- ---------------------------------------------------------------------------

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
    -- Carries pull_id now, so an opposed pair can be identified and dropped
    -- before any distance is taken against it.
    select ks.pull_id, p2.embedding
    from public.knowledge_states ks
    join public.pulls p2 on p2.id = ks.pull_id
    where uid is not null and ks.user_id = uid and p2.embedding is not null
      and public.retrievability(ks.stability, ks.last_seen_at)
          > public.known_retrievability_floor()
    order by public.retrievability(ks.stability, ks.last_seen_at) desc
    limit known_cap
  ),
  -- Both directions: the primary key is (from_pull_id, to_pull_id, kind), so
  -- opposition is stored directionally. The seed writes both rows, but nothing
  -- enforces that, and a one-sided edge must still work.
  --
  -- Joined to known_ideas rather than scanned whole. That is correctness, not
  -- optimisation: dropping an idea from the comparison because the candidate
  -- opposes it only makes sense if the reader actually knows it. (It is also
  -- 64x faster -- measured -- since the unrestricted form re-probes every
  -- `opposes` edge in the graph for every candidate.)
  opposed_direct as materialized (
    select pr.from_pull_id as candidate, ki.pull_id as known
    from public.pull_relations pr
    join known_ideas ki on ki.pull_id = pr.to_pull_id
    where pr.kind = 'opposes'
    union all
    select pr.to_pull_id as candidate, ki.pull_id as known
    from public.pull_relations pr
    join known_ideas ki on ki.pull_id = pr.from_pull_id
    where pr.kind = 'opposes'
  ),
  -- Opposition propagates through paraphrase, and it has to.
  --
  -- Edges are annotated between two specific pulls, but a reader does not know
  -- pulls -- they know claims, often via several restatements. Someone who has
  -- read twenty phrasings of "spacing improves retention" and one contradiction
  -- of it carries exactly one `opposes` edge; the other nineteen are still
  -- 0.06 away and would keep the contradiction covered on proximity alone. The
  -- exclusion would then work only for readers who barely know the topic, and
  -- fail precisely for the ones with a real stake in the disagreement.
  --
  -- So an idea is excluded when it is opposed OR when it is a restatement of
  -- something opposed. This leans on the one thing the vectors ARE reliable at
  -- -- 0.0987 for "same idea, reworded" -- to repair the one thing they are
  -- not, and it reuses the same threshold rather than inventing a second.
  -- k2 includes k1 at distance 0, so this subsumes the direct set.
  opposed_pairs as materialized (
    select od.candidate, k2.pull_id as known
    from opposed_direct od
    join known_ideas k1 on k1.pull_id = od.known
    join known_ideas k2
      on (k1.embedding OPERATOR(extensions.<=>) k2.embedding)
         < public.delta_covered_distance()
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
               and public.retrievability(ks.stability, ks.last_seen_at)
                   > public.known_retrievability_floor()
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
  'Personalised feed page: rows, Delta skip count, and interleaved question slots. Knowledge and vector work run only over a bounded candidate pool, so the reported saving describes this page. Ideas the candidate contradicts are excluded from the distance comparison, so a contradiction is never filed as already-known. No LLM.';

-- ---------------------------------------------------------------------------

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
    select ks.pull_id, p2.embedding
    from public.knowledge_states ks
    join public.pulls p2 on p2.id = ks.pull_id
    where ks.user_id = uid
      and p2.embedding is not null
      and public.retrievability(ks.stability, ks.last_seen_at)
          > public.known_retrievability_floor()
  ),
  -- Same two stages as get_feed, and for the same reasons: restricted to what
  -- the reader knows, then widened to restatements of it.
  opposed_direct as materialized (
    select pr.from_pull_id as candidate, ki.pull_id as known
    from public.pull_relations pr
    join known_ideas ki on ki.pull_id = pr.to_pull_id
    where pr.kind = 'opposes'
    union all
    select pr.to_pull_id as candidate, ki.pull_id as known
    from public.pull_relations pr
    join known_ideas ki on ki.pull_id = pr.from_pull_id
    where pr.kind = 'opposes'
  ),
  opposed_pairs as materialized (
    select od.candidate, k2.pull_id as known
    from opposed_direct od
    join known_ideas k1 on k1.pull_id = od.known
    join known_ideas k2
      on (k1.embedding OPERATOR(extensions.<=>) k2.embedding)
         < public.delta_covered_distance()
  ),
  candidates as (
    select p.id, p.embedding, p.estimated_read_seconds,
           exists (
             select 1 from public.knowledge_states ks
             where ks.user_id = uid and ks.pull_id = p.id
               and public.retrievability(ks.stability, ks.last_seen_at)
                   > public.known_retrievability_floor()
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
           c.embedding is not null and exists (
             select 1 from known_ideas ki
             where (ki.embedding OPERATOR(extensions.<=>) c.embedding)
                     < public.delta_covered_distance()
               and not exists (
                 select 1 from opposed_pairs op
                 where op.candidate = c.id and op.known = ki.pull_id
               )
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

comment on function public.get_source_delta(uuid) is
  'How much of one source the reader already knows. Ideas a pull contradicts are excluded from the comparison, so a source that argues against what you believe is not reported as one you have already read.';
