-- The 18% of the ranking score that nothing has ever computed.
--
-- `get_feed` spends 0.18 of a score whose weights sum to 1.00 on how close a
-- candidate sits to the reader's knowledge centroid. `user_knowledge_vectors`
-- has never held a row, so that term has always evaluated to the literal 0.5
-- for every card and every reader: the largest personalisation signal in the
-- feed, contributing a constant. `docs/roadmap.md` records this under "known
-- gaps carried out of round 1" as `refresh_knowledge_vector` having no caller,
-- and frames the choice as calling it on a `pg_cron` tick or dropping the term
-- and redistributing its weight.
--
-- Measured against the hosted project before designing any of this, the
-- situation is worse than "no caller" -- the function does not work:
--
--     select public.refresh_knowledge_vector('<a real user id>');
--     ERROR:  function avg(extensions.vector) does not exist   (SQLSTATE 42883)
--
-- `refresh_knowledge_vector` pins `set search_path = ''`, which is the correct
-- hardening, and then calls `avg(p.embedding)` unqualified. pgvector's
-- aggregate lives in `extensions`; an empty search_path resolves only
-- `pg_catalog`, which has no `avg(vector)`. This is exactly the defect
-- 20260829131539_vector_operator_qualification.sql fixed for the `<=>`
-- OPERATOR -- the aggregate in this one function was missed. It survived
-- because nothing called it, and nothing called it because the term it feeds
-- was never noticed to be constant. Both halves were broken at once, which is
-- why neither showed.
--
-- WIRING RATHER THAN DROPPING, and the case for it is not that the term works
-- well today. Measured on the seed corpus (156 pulls, synthetic concept-axis
-- embeddings) the term does most of its work as a penalty: for ~95% of cards
-- it lands in a narrow band around 0.85 -- an interquartile range of 0.039,
-- worth 0.007 of score against a jitter term worth 0.10 -- while the 3-7% of
-- cards that sit further than 1.0 cosine from the centroid clamp to 0 and lose
-- the full 0.09. So it is currently a coarse "not for you" signal with a
-- rounding error attached, not the graded interest term the weight implies.
--
-- It is still the right thing to turn on rather than delete. `docs/roadmap.md`
-- records that embeddings are synthetic and that real ones arrive with the
-- providers; a term that is under-powered against concept axes is not evidence
-- about a term against measured vectors, and the read path was written so that
-- no code changes when they land. Dropping 0.18 would redistribute it onto
-- topic weights, quality, novelty and jitter -- stated preference and
-- properties of the card -- leaving the feed with exactly one signal that
-- learns from what a reader actually reads: the 0.08 dwell term added in
-- 20260831210000. That is the wrong direction for a product whose claim is
-- that it knows what you know. Wiring it up is also what makes the term
-- measurable, and the follow-up worth doing -- reshaping
-- `greatest(0.0, 1.0 - distance)`, which throws away the entire negative half
-- of cosine similarity into a single clamped value -- needs that measurement
-- first. That is a `get_feed` change and a separate concern.
--
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
--   * It does not recompute on read. `docs/roadmap.md` is explicit that
--     "recomputing a reader's centroid on every read would be a write
--     amplification we have no evidence is needed", and the numbers below say
--     a centroid over dozens of ideas does not move measurably when one more
--     is added.
--   * It does not put a trigger on `knowledge_states`. A trigger fires inside
--     `record_read`, on the read path, and would average a reader's whole
--     history to serve one impression -- the shape law 2 exists to forbid,
--     model call or not.
--   * It does not schedule anything at apply time. CI check 4 replays every
--     migration from zero, and a migration that calls `cron.schedule` makes
--     that replay depend on pg_cron being not merely installed but running, as
--     a background worker, in a container, during a test. Scheduling is an
--     `enable_*` function an operator calls once, exactly as
--     `enable_generation_dispatcher` and `enable_log_retention` already do.
--   * It changes nothing in `get_feed`. That function has read `uvec` since it
--     was written; this migration only makes the read find something. Verified
--     A/B against the hosted corpus under RLS, same seed, two readers with
--     identical `knowledge_states` and only one holding a centroid: both got
--     20 rows and identical `skippedKnownCount` (31 vs 31 for a reader who
--     knows 20 ideas, 131 vs 131 for one who knows 100). The centroid cannot
--     over-filter because it is not a filter -- the Delta compares candidates
--     against `knowledge_states` embeddings, never against `uvec` -- so the
--     failure mode `.claude/skills/delta/SKILL.md` warns about lands here as
--     "the term stops discriminating", not as "the feed empties".
--
-- Law 2 holds throughout: an average of stored vectors is arithmetic. No model
-- runs here, and nothing runs per impression.

-- ---------------------------------------------------------------------------
-- One index, and why the existing ones cannot answer either question.
--
-- Both new questions are about a reader's most recent activity.
-- `refresh_stale_knowledge_vectors` asks "what is the newest `last_seen_at`
-- this reader has" once per reader to decide who is stale;
-- `refresh_knowledge_vector` asks for that reader's rows in `last_seen_at`
-- order to decide which ideas the centroid averages. The primary key is
-- (user_id, pull_id), so answering either from it means reading every row the
-- reader owns; `knowledge_due_idx` is on `next_due_at`, which moves on a
-- different schedule and cannot answer it at all.
--
-- `pull_id` is the third column so the index also satisfies the tie-break the
-- centroid orders by, and the ordered read needs no sort on top of it.
-- Verified: the staleness probe plans as
-- `Index Only Scan using knowledge_recent_idx ... Limit (actual rows=1)`,
-- one probe per reader.
--
-- Not CONCURRENTLY: a migration runs inside a transaction, and this table
-- holds 33 rows on the hosted project. It is the shape of the scan at scale
-- this is for, not the current size.
-- ---------------------------------------------------------------------------
create index if not exists knowledge_recent_idx
  on public.knowledge_states (user_id, last_seen_at desc, pull_id);

-- ---------------------------------------------------------------------------
-- How many ideas the centroid averages.
--
-- A named constant rather than a literal, following `delta_covered_distance`,
-- `known_retrievability_floor` and `known_comparison_cap`, so a re-tune is a
-- one-line migration rather than an edit across superseded files.
--
-- 200, and the number is measured rather than picked. Averaging N randomly
-- drawn pulls from the seed corpus and comparing that centroid against the
-- centroid of the whole corpus, eight trials per N:
--
--     ideas in centroid    3      10      20      40      80     156
--     cosine distance to
--     the corpus mean    0.0738  0.0272  0.0127  0.0055  0.0017  0.0000
--
-- A lifetime average converges on "the average pull" fast, and that is not an
-- artefact of a small corpus -- it is the 1/sqrt(N) convergence of any mean,
-- so a larger library moves the curve very little. What survives the collapse
-- is CONCENTRATION: twenty pulls drawn at random sit 0.0127 from the corpus
-- mean, while the twenty nearest neighbours of one pull sit 0.0492 away, four
-- times further out and still carrying a direction. So the signal is not "how
-- much you have read", it is "how narrow your recent reading is" -- which is
-- an argument for a SMALL, RECENT window rather than a large one.
--
-- The cost points the same way. Averaging 1,092 real 1536-dimension vectors on
-- the hosted instance takes 35 ms and reads ~6.5 MB; at 200 that is ~6.5 ms
-- and ~1.2 MB per reader, so a saturated tick of 200 readers is ~1.3 s of
-- background work every fifteen minutes. A cap of 1,000 would be five times
-- the cost for a centroid the table above says is no more informative.
--
-- Capped by `last_seen_at desc`, NOT by retrievability. The centroid is the
-- *interest* signal -- `refresh_knowledge_vector` has been commented "used for
-- ranking (predicted interest), never for the Delta filter" since it was
-- written -- and filtering it by whether the reader can still recall an idea
-- would make the feed forget your taste at the rate you forget a card.
-- `record_read` opens a knowledge state with one day of stability, so a
-- `known_retrievability_floor()` here would empty most readers' centroids
-- within a week of their last session.
--
-- Deliberately not `known_comparison_cap()`, though both are caps on a set of
-- the reader's ideas. That one bounds a quadratic read-path join and exists so
-- that `get_feed` and `get_source_delta` agree about how much somebody knows;
-- this one bounds a linear background average and is a statement about taste.
-- Sharing the constant would mean a re-tune of the Delta's comparison silently
-- changed what the feed thinks you like.
--
-- Default grants, like its three siblings: it is inlined into a SECURITY
-- INVOKER function that `authenticated` calls, so revoking EXECUTE from PUBLIC
-- would break the caller rather than protect anything. There is no secret in
-- the number 200.
-- ---------------------------------------------------------------------------
create or replace function public.knowledge_vector_cap()
returns int
language sql
immutable
parallel safe
set search_path = ''
as $$ select 200 $$;

comment on function public.knowledge_vector_cap() is
  'How many of a reader''s ideas the knowledge centroid averages, most recently seen first. Bounds one refresh. Capped by recency rather than retrievability because the centroid is a taste signal, and small because a mean over more ideas converges on the corpus mean rather than describing anyone.';

-- ---------------------------------------------------------------------------
-- The centroid itself. Superseded rather than edited (law 6) -- the original
-- stays in 20260829130514_learning_rpc.sql.
--
-- Four changes from that version:
--
--   1. `extensions.avg(...)`. The 42883 above. Nothing else in this file is
--      reachable until that call is schema-qualified.
--
--   2. A watermark instead of a wall clock. `updated_at` is now the newest
--      `knowledge_states.last_seen_at` the centroid was computed from, not
--      `now()`, and that is what makes staleness detection race-free rather
--      than merely usually-right. `record_read` stamps `last_seen_at` with its
--      own transaction time, so a read that starts before a refresh and
--      commits after it carries a timestamp EARLIER than the refresh's
--      `now()` while being invisible to the refresh's snapshot. Against a wall
--      clock that reader is permanently stale and never selected again;
--      against a watermark both values come from the same clock and the next
--      tick catches it. The cost of this is that "age of the centroid" now
--      means "age of the newest idea in it" -- which is the more useful
--      reading, and is what `.claude/commands/delta.md` actually wants.
--
--   3. A cap, so one reader's history cannot make one refresh unbounded.
--
--   4. A row with a NULL embedding, rather than a deletion, when there is
--      something to average over but nothing embedded. This is operational
--      rather than cosmetic. A reader whose known pulls carry no embeddings
--      -- which generated content will produce, since `docs/roadmap.md` gates
--      the embedding backfill on relation extraction -- would otherwise leave
--      no row, look permanently un-computed, and be re-selected on every tick
--      forever, spending the batch that other readers need. `get_feed` reads a
--      null embedding exactly as it reads a missing row (`uvec is null` scores
--      the neutral 0.5), so nothing a reader sees changes.
--
-- Still SECURITY INVOKER, and still safe to leave callable by a signed-in
-- reader. Verified under RLS as `authenticated`: passing another reader's id
-- reads no `knowledge_states`, writes no `user_knowledge_vectors` row, raises
-- nothing, and leaves the victim's centroid byte-identical.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_knowledge_vector(p_user_id uuid default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid    uuid := coalesce(p_user_id, (select auth.uid()));
  vec    extensions.vector(1536);
  n      int;
  newest timestamptz;
begin
  if uid is null then
    return;
  end if;

  -- The watermark is taken over EVERY row the reader owns, including rows the
  -- cap will exclude and rows whose pull has no embedding. It has to be:
  -- `refresh_stale_knowledge_vectors` compares this value against
  -- `knowledge_states.last_seen_at`, so a watermark taken only over the rows
  -- that were actually averaged would sit permanently behind a reader whose
  -- newest idea was capped out or unembedded, and that reader would be
  -- selected on every tick and rewritten to the same value every time.
  select max(ks.last_seen_at) into newest
  from public.knowledge_states ks
  where ks.user_id = uid;

  if newest is null then
    -- The reader knows nothing at all: a new account, or one that has since
    -- forgotten everything. Delete rather than leave an empty row behind --
    -- nothing selects a reader with no knowledge states, so there is no churn
    -- to prevent, and a centroid over nothing should leave no trace.
    delete from public.user_knowledge_vectors where user_id = uid;
    return;
  end if;

  select extensions.avg(t.embedding)::extensions.vector(1536), count(*)::int
    into vec, n
  from (
    select p.embedding
    from public.knowledge_states ks
    join public.pulls p on p.id = ks.pull_id
    where ks.user_id = uid and p.embedding is not null
    -- `pull_id` breaks the tie for the same reason `get_feed`'s known set
    -- does: everything read in one session shares a `last_seen_at`, and
    -- without a second key which ideas survive the cap is plan-dependent, so a
    -- reader's centroid could move with no data change.
    order by ks.last_seen_at desc, ks.pull_id
    limit public.knowledge_vector_cap()
  ) t;

  -- A zero-length centroid is not merely useless, it is corrupting: cosine
  -- distance against it is NaN, `greatest(0.0, 1.0 - NaN)` is NaN, and NaN
  -- sorts ABOVE every real number under `order by score desc` -- so one such
  -- reader would get a feed ordered by nothing at all, silently. Unreachable
  -- with today's embeddings (the smallest centroid norm observed is 0.56) and
  -- one line to keep unreachable on purpose.
  if vec is not null and extensions.vector_norm(vec) = 0 then
    vec := null;
    n := 0;
  end if;

  insert into public.user_knowledge_vectors (user_id, embedding, idea_count, updated_at)
  values (uid, vec, coalesce(n, 0), newest)
  on conflict (user_id) do update
    set embedding  = excluded.embedding,
        idea_count = excluded.idea_count,
        updated_at = excluded.updated_at;
end;
$$;

comment on function public.refresh_knowledge_vector(uuid) is
  'Recomputes one reader''s knowledge centroid -- the vector the feed''s 0.18 interest term scores against, never the Delta filter. `updated_at` holds the newest knowledge state the centroid averaged rather than wall-clock time, which is what makes staleness detection race-free.';

-- Not reachable anonymously. `auth.uid()` is null for `anon`, so the call was
-- already a no-op, but PostgREST advertises every function a role may execute
-- and a write RPC in `anon`'s list is noise at best.
revoke all on function public.refresh_knowledge_vector(uuid) from public, anon, authenticated;
grant execute on function public.refresh_knowledge_vector(uuid) to authenticated;
grant execute on function public.refresh_knowledge_vector(uuid) to postgres;

-- ---------------------------------------------------------------------------
-- The scheduled half: recompute only readers whose centroid has fallen behind
-- their reading, and never more than a fixed number of them per tick.
--
-- The staleness test is `ukv.updated_at is distinct from max(last_seen_at)`,
-- and `is distinct from` rather than `<` is load-bearing twice over. It
-- catches the watermark moving BACKWARDS -- a pull deleted out from under a
-- reader cascades its knowledge state away and the max drops -- and it catches
-- the max becoming null, which is a reader who has forgotten everything and
-- whose centroid must be removed rather than left standing. Both verified.
--
-- KNOWN INCOMPLETENESS, stated rather than papered over: a deletion that does
-- not move the maximum -- one middle row out of many -- leaves a centroid that
-- still averages an idea the reader no longer holds. It is a ranking term, the
-- error is one idea in at most two hundred, and it corrects itself the next
-- time that reader reads anything. The alternatives are a trigger on
-- `knowledge_states` (a write on the read path) or counting every reader's
-- rows on every tick (the scan this design exists to avoid), and neither is
-- worth buying that.
--
-- The ordering is what stops the batch starving anyone: readers with no vector
-- first, then the longest-stale, then by id so the sequence is deterministic.
-- Because a refreshed reader stops matching the predicate, each tick removes
-- up to `p_limit` readers from the backlog permanently rather than re-picking
-- the same ones. `saturated` in the return value is the operational signal
-- that the backlog is not clearing; if it is true on every tick, raise
-- `p_limit` or shorten the interval.
--
-- SECURITY INVOKER, and it must stay that way. The only caller is the
-- scheduled job, which pg_cron runs as `postgres` -- the owner of these tables,
-- and RLS does not apply to a table's owner unless FORCE ROW LEVEL SECURITY is
-- set, which it is not on any of them. So the function needs no privilege of
-- its own. Making it DEFINER would buy nothing and would create a function
-- that reads every reader's knowledge with elevated rights, one mistaken grant
-- away from being a way to learn who has read what.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_stale_knowledge_vectors(p_limit int default 200)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n_limit   int := greatest(coalesce(p_limit, 0), 0);
  target    uuid;
  refreshed int := 0;
  started   timestamptz := clock_timestamp();
begin
  for target in
    select pr.id
    from public.profiles pr
    left join public.user_knowledge_vectors ukv on ukv.user_id = pr.id
    -- One backwards probe of `knowledge_recent_idx` per reader. CROSS JOIN
    -- rather than LEFT JOIN because an aggregate over no rows still returns
    -- one row holding null -- which is itself a case the predicate reads.
    cross join lateral (
      select max(ks.last_seen_at) as newest
      from public.knowledge_states ks
      where ks.user_id = pr.id
    ) k
    where (ukv.user_id is null and k.newest is not null)
       or (ukv.user_id is not null and ukv.updated_at is distinct from k.newest)
    order by ukv.updated_at asc nulls first, pr.id
    limit n_limit
  loop
    -- One definition of how a centroid is computed, called in a bounded loop,
    -- rather than a second copy of the same arithmetic inlined here. Two
    -- functions drifting apart about how much a reader knows is a bug this
    -- repo has already paid for once, between `get_feed` and
    -- `get_source_delta`; a batch path and a single-reader path that averaged
    -- different sets would be the same bug in a new place.
    perform public.refresh_knowledge_vector(target);
    refreshed := refreshed + 1;
  end loop;

  return jsonb_build_object(
    'refreshed', refreshed,
    'limit',     n_limit,
    'saturated', n_limit > 0 and refreshed >= n_limit,
    'elapsedMs', round((extract(epoch from (clock_timestamp() - started)) * 1000)::numeric, 1)
  );
end;
$$;

comment on function public.refresh_stale_knowledge_vectors(int) is
  'Recomputes the knowledge centroids of up to p_limit readers whose vector is missing, older than their newest knowledge state, or left over after they forgot everything. Bounded per call and idempotent: a second run immediately after the first selects nobody and writes nothing. `saturated` in the result means the backlog did not clear.';

revoke all on function public.refresh_stale_knowledge_vectors(int)
  from public, anon, authenticated;
grant execute on function public.refresh_stale_knowledge_vectors(int) to postgres;

-- ---------------------------------------------------------------------------
-- Turning it on is an operator's act, not a migration's.
--
--     select public.enable_knowledge_vector_refresh();              -- */15, 200
--     select public.enable_knowledge_vector_refresh('*/5 * * * *', 500);
--     select public.disable_knowledge_vector_refresh();
--
-- Fifteen minutes, and the interval is a cost decision as much as a product
-- one. 20260901030000 measured `cron.job_run_details` growing 6.6 MB a day off
-- a job that ticks every ten seconds -- 76 days to the free tier's 500 MB from
-- the scheduler's own exhaust, before a single source is added. At `*/15` this
-- job writes 96 rows a day against that dispatcher's 8,640, about 1% of the
-- problem that migration exists to solve, and the retention prune added there
-- covers it either way. It can afford to be that slow because a centroid is a
-- taste signal: a reader who read three cards ten minutes ago has a centroid
-- stale by three ideas out of up to two hundred, and the table above says a
-- mean does not move measurably for that.
--
-- After enabling, the first tick refreshes at most `p_batch` readers. To fill
-- an existing population in one go instead:
--
--     select public.refresh_stale_knowledge_vectors(100000);
--
-- Deliberately not run from this migration: on a from-zero replay there is
-- nobody to refresh, and on a live database a backfill is a decision with a
-- duration attached, which belongs to whoever is watching it.
-- ---------------------------------------------------------------------------
create or replace function public.enable_knowledge_vector_refresh(
  p_cron  text default '*/15 * * * *',
  p_batch int default 200
)
returns bigint
language plpgsql
-- SECURITY DEFINER for the one thing that genuinely needs it: `cron.schedule`
-- belongs to the extension rather than to any application role. It also fixes
-- WHO the scheduled job runs as -- pg_cron records `current_user`, which
-- inside a definer function owned by postgres is postgres, the owner of the
-- tables the job reads. Verified: `cron.job.username = 'postgres'`.
security definer
set search_path = ''
as $$
declare
  job_id bigint;
begin
  -- `cron.schedule` upserts by job name, so calling this twice reschedules
  -- rather than stacking a second job doing the same work. Verified: a second
  -- call with a different schedule and batch leaves exactly one row.
  select cron.schedule(
    'refresh-knowledge-vectors',
    p_cron,
    format('select public.refresh_stale_knowledge_vectors(%s);',
           greatest(coalesce(p_batch, 200), 1))
  ) into job_id;
  return job_id;
end;
$$;

comment on function public.enable_knowledge_vector_refresh(text, int) is
  'Schedules the knowledge centroid refresh. Separate from the migration so a from-zero replay never depends on pg_cron running, and idempotent because cron.schedule upserts by job name.';

create or replace function public.disable_knowledge_vector_refresh()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cron.unschedule('refresh-knowledge-vectors')
  where exists (select 1 from cron.job where jobname = 'refresh-knowledge-vectors');
  return 'knowledge vector refresh stopped';
end;
$$;

comment on function public.disable_knowledge_vector_refresh() is
  'Unschedules the knowledge centroid refresh. Existing centroids are left in place -- they simply stop being updated, and every one of them stays a valid answer to a question nobody is asking again.';

revoke all on function public.enable_knowledge_vector_refresh(text, int)
  from public, anon, authenticated;
revoke all on function public.disable_knowledge_vector_refresh()
  from public, anon, authenticated;
grant execute on function public.enable_knowledge_vector_refresh(text, int) to postgres;
grant execute on function public.disable_knowledge_vector_refresh() to postgres;
