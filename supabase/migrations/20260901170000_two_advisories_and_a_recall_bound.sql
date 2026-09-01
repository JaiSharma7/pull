-- Three things the roadmap has been carrying as known, closed together because each is
-- one statement and none of them is worth its own file.

-- 1. A duplicate index. ------------------------------------------------------------
--
-- `artworks_summary_idx` (20260829124507) and `artworks_summary_readable_idx`
-- (20260829135030) are the same index under two names: both on `artworks (summary_id)`,
-- neither partial. The second was added while tightening the table's RLS, to support a
-- policy that turned out not to need it -- the first was already there.
--
-- Supabase's performance advisor reports it as a WARN, and `docs/roadmap.md` has named
-- it as open since round 1. Two identical indexes cost double on every write and buy
-- nothing on any read; the planner picks one and the other is dead weight.
--
-- The FK index check in `supabase/tests/lint.sql` is satisfied by either, so dropping
-- one cannot break it. Dropping the *later* one keeps the name the original migration
-- gave it.

drop index if exists public.artworks_summary_readable_idx;

-- 2. A recall bound the arithmetic already assumed. ---------------------------------
--
-- `search_catalogue` over-fetches `count(ranked) + 120` neighbours and `related_pulls`
-- asks for 200, and both reason carefully about why that much is needed -- see the
-- header of 20260901080000, which proves the HNSW index was structurally unreachable
-- before it and restructures the query so the planner can use it.
--
-- What neither mentions is `hnsw.ef_search`, which defaults to **40**. That is the size
-- of the candidate list pgvector keeps while descending the graph, and it is a ceiling
-- on how many rows an index scan can return: asking for 200 neighbours with ef_search
-- at 40 does not return 200, it returns about 40 and reports no error.
--
-- It has not bitten yet, and the reason is uncomfortable: at 370 pulls the planner
-- ignores the index and scans, which is exact. The over-fetch arithmetic is therefore
-- correct today *because the optimisation it was written for is not being used*. The
-- day the corpus is large enough for the planner to switch -- which is the day
-- 20260901080000 was written for -- recall would quietly drop and search would start
-- missing results with nothing failing.
--
-- Set on the database rather than per-function so it applies to any query that reaches
-- the index, including one written later by someone who has not read this. 200 is the
-- larger of the two over-fetches; ef_search must be at least the number of rows wanted.
--
-- The cost is per-query work proportional to ef_search, which at 200 is small and
-- bounded. The alternative -- leaving it at 40 -- is not cheaper, it is wrong.

do $$
begin
  execute format('alter database %I set hnsw.ef_search = 200', current_database());
exception when insufficient_privilege then
  -- A hosted database may refuse ALTER DATABASE to the migration role. Say so loudly
  -- rather than failing the migration: every other statement here is worth applying,
  -- and a silent skip is how a setting nobody notices stays wrong.
  raise warning
    'could not set hnsw.ef_search on this database (insufficient privilege). '
    'Set it in the dashboard, or per-session before a vector search, or the '
    'over-fetch arithmetic in search_catalogue and related_pulls will silently '
    'stop holding once the planner starts using the HNSW index.';
end $$;

-- 3. A write-only table that no longer pretends otherwise. -------------------------
--
-- `rate_limits` was created in 20260829124649 for the generation quota, and the quota
-- ended up counting `generation_jobs` rows instead (20260829171514) -- which is the
-- better design, because it counts the thing being limited rather than a tally that can
-- drift from it. Nothing has ever written to `rate_limits`.
--
-- Not dropped: `20260901130000` reaches for it and cannot use it, because it is keyed
-- on a `user_id` that an anonymous DMCA notice does not have. That is a real future use
-- with a real obstacle, so the table stays and the comment records both, rather than
-- leaving the next reader to work out why an empty table is here.

comment on table public.rate_limits is
  'Unused. The generation quota counts generation_jobs rows instead (20260829171514), '
  'which counts the thing being limited rather than a tally that can drift from it. '
  'Kept because a per-user limiter is still wanted elsewhere -- but note it cannot '
  'serve anonymous callers: user_id is not null and references auth.users, which is '
  'why 20260901130000 had to use a global ceiling for the DMCA intake.';
