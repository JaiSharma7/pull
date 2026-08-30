-- Two holes that only became reachable when the pipeline started writing.
--
-- Both are pre-existing policies that were harmless while `works` held six seeded
-- public-domain books and no generation job had ever completed. This PR makes the
-- pipeline write real rows, which is what turns them into a quota bypass and a
-- privacy leak respectively. Append-only, per law 6.

-- ---------------------------------------------------------------------------
-- 1. Nothing should INSERT into generation_jobs over the API.
--
-- `enqueue_generation_job` is `security definer` owned by the table owner, and the
-- table does not `force row level security`, so RLS is bypassed on the legitimate
-- path. The policy therefore has no caller — it is only reachable by a client
-- POSTing straight to /rest/v1/generation_jobs, which skips:
--
--   the daily_hard_ceiling of 50          (20260829171514)
--   the advisory lock serialising the count
--   pgmq.send — so the row never becomes work
--
-- What it does not skip is storage. `target` is unbounded jsonb, so any signed-in
-- reader could write rows as fast as the API answers, and forge `cost_cents` while
-- doing it — poisoning the first spend rollup anyone builds on this table. The
-- quota protects provider spend; this protects the database from the quota being
-- irrelevant.
drop policy if exists generation_jobs_insert_own on public.generation_jobs;

-- ---------------------------------------------------------------------------
-- 2. `works.content_hash` must not be world-readable.
--
-- `works` is `for select using (true)` — deliberately, because a work is a
-- bibliographic record and the feed needs it. That was fine when every row was a
-- seeded classic. `template` now calls `upsertWork` for every job including
-- `visibility = 'private'` (the default), so the table has started accumulating
-- rows describing documents their owners never published.
--
-- `content_hash` is the sharpest part of that. It is a fingerprint of the source
-- text, so anyone holding a candidate document can hash it and confirm, exactly,
-- that someone ingested it. A title suggests; a hash proves.
--
-- Column-level revoke rather than a policy change: PostgREST returns a 401 for a
-- select naming a revoked column, and the web client never asks for it — it embeds
-- `works(id, title, kind)` (apps/web/src/lib/api.ts). The worker reads it through
-- the service role, which these grants do not touch.
revoke select (content_hash) on public.works from anon, authenticated;

comment on column public.works.content_hash is
  'Fingerprint of the source text. Server-side only: revoked from anon and authenticated '
  'because it confirms membership — anyone holding a candidate document can hash it and '
  'prove the document was ingested. See 20260830200114.';

-- ---------------------------------------------------------------------------
-- 3. Grant the worker RPCs explicitly instead of relying on a platform default.
--
-- These work today because Supabase's default privileges grant execute on new
-- functions to service_role, and the `revoke ... from anon, authenticated, public`
-- in each migration leaves that intact. That is a real guarantee, but it is one
-- this repo never states, and two functions in this same PR (`job_step_outputs`,
-- `generation_secret`) already grant explicitly — so the rule is inconsistent
-- rather than absent, which is the harder kind to notice breaking.
--
-- `record_failed_job_step` is the one where an implicit grant hurts most: it is
-- called only from a catch block, and the worker treats a failed insert as
-- non-fatal unless the code is 23505. A 42501 would therefore write no row, leave
-- `attempt` un-advanced, and let the message redeliver — re-invoking a paid
-- provider call with nothing in `cost_ledger` to show for any of them. That is
-- precisely the law 2 failure the function exists to prevent, inverted.
grant execute on function public.record_failed_job_step(
  uuid, text, int, text, int, text, text, int, int, numeric, boolean
) to service_role;

grant execute on function public.record_job_step(
  uuid, text, int, text, text, int, int, numeric, int, text, boolean, jsonb
) to service_role;

grant execute on function public.advance_generation_job(uuid, text, text) to service_role;
grant execute on function public.claim_generation_messages(int, int) to service_role;
grant execute on function public.archive_generation_message(bigint) to service_role;
