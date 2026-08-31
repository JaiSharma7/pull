-- The database will hit the free tier's 500 MB in about eleven weeks, and none
-- of it will be content.
--
-- Measured on the hosted project at 39 MB total:
--
--   cron.job_run_details   11 MB   15,124 rows over 1.7 days
--   job_steps               6.7 MB   384 kB heap, the rest TOASTed `output`
--   pulls                   3.2 MB   156 rows -- embeddings and the HNSW index
--   net._http_response      2.9 MB   already bounded by pg_net's own TTL
--
-- The dispatcher ticks every ten seconds, so `cron.job_run_details` takes about
-- 8,640 rows and 6.6 MB per day, forever, whether or not anything is generated.
-- That is roughly 76 days to the cap on its own -- before a single new source is
-- added, and while it is the one table in the database that no reader will ever
-- see. 20260831172414 already stopped the dispatcher POSTing when the queue is
-- empty; it did not stop pg_cron recording that it decided not to.
--
-- For comparison, the content itself is cheap and bounded by the corpus:
-- ~21 kB per pull all-in (6 kB embedding, 8 kB of HNSW, 0.6 kB tsvector, the
-- rest row and index overhead). The roadmap's 400-work target is ~4,800 pulls,
-- so ~100 MB -- a fifth of the tier, and it stops growing when the corpus does.
--
-- So the fix is retention on the exhaust, not restraint on the library.
--
-- WHAT IS DELIBERATELY NOT DONE HERE. The dispatcher interval is left alone:
-- widening it would cut the log rate and the generation throughput together,
-- and throughput is the thing the corpus plan is already bounded by.
-- `cron.log_run = off` would stop the writes entirely, but it is a
-- database-level setting rather than a migration, and it trades away the only
-- record of why a tick failed. Deleting rows also does not shrink the file --
-- autovacuum makes the pages reusable and the table plateaus rather than
-- shrinking, which is the property we actually want.

create or replace function public.prune_operational_logs(
  p_cron_days     int default 2,
  p_response_hours int default 1,
  p_output_days   int default 7
)
returns jsonb
language plpgsql
-- SECURITY DEFINER because `cron.job_run_details` and `net._http_response`
-- belong to the extensions rather than to any application role, and the
-- scheduled caller must not need ownership of them in its own right.
-- `search_path` is pinned, which CI check 4's fourth invariant requires and
-- which matters more here than usual: this function deletes.
security definer
set search_path = ''
as $$
declare
  cron_rows     bigint := 0;
  response_rows bigint := 0;
  output_rows   bigint := 0;
begin
  -- Two days keeps enough history to explain a failure that happened overnight,
  -- which is the only thing anyone has ever wanted this table for.
  delete from cron.job_run_details
  where end_time < now() - make_interval(days => greatest(p_cron_days, 1));
  get diagnostics cron_rows = row_count;

  -- pg_net keeps its own TTL and would eventually clear these; an hour is
  -- shorter than its default and saves several megabytes of steady state. A
  -- response older than an hour has already been read or already timed out.
  delete from net._http_response
  where created < now() - make_interval(hours => greatest(p_response_hours, 1));
  get diagnostics response_rows = row_count;

  -- The step ledger is the audit trail and stays: cost, model, provider, timing,
  -- attempt. Only the bulky `output` payload is dropped, and only for jobs that
  -- have finished, because `job_step_outputs` is what a resuming worker reads to
  -- recover the state it does not hold between invocations. Dropping it from a
  -- live job would strand it.
  update public.job_steps js
     set output = null
    from public.generation_jobs gj
   where gj.id = js.job_id
     and js.output is not null
     and gj.status in ('succeeded', 'failed', 'cancelled')
     and gj.updated_at < now() - make_interval(days => greatest(p_output_days, 1));
  get diagnostics output_rows = row_count;

  return jsonb_build_object(
    'cronRuns', cron_rows,
    'httpResponses', response_rows,
    'jobStepOutputs', output_rows,
    'databaseBytes', pg_catalog.pg_database_size(pg_catalog.current_database())
  );
end;
$$;

comment on function public.prune_operational_logs(int, int, int) is
  'Retention for the logs nobody reads: pg_cron run history, pg_net responses, and the payloads of finished generation steps. The step ledger itself is never deleted -- cost_ledger reconciliation depends on it.';

-- Not a reader-facing endpoint. Postgres grants EXECUTE to PUBLIC on a new
-- function, and this one is SECURITY DEFINER and deletes rows, so the grant is
-- removed from everyone and given back only to the role the scheduler runs as.
revoke all on function public.prune_operational_logs(int, int, int)
  from public, anon, authenticated;
grant execute on function public.prune_operational_logs(int, int, int) to postgres;

-- Scheduling is a function an operator calls, not something the migration does.
--
-- This follows `enable_generation_dispatcher` rather than inventing a second
-- pattern, and the reason is CI check 4: it replays every migration from zero on
-- a fresh stack, and a migration that calls `cron.schedule` at apply time makes
-- the whole replay depend on pg_cron being not merely installed but running --
-- a background worker, in a container, during a test. The `migration` skill is
-- explicit that a migration must not assume a platform-provided object behaves
-- the way the hosted project's does. Keeping the schedule out of the replay path
-- means the invariant checks never depend on it.
create or replace function public.enable_log_retention(p_cron text default '17 3 * * *')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_id bigint;
begin
  -- `cron.schedule` upserts by name, so calling this twice reschedules rather
  -- than stacking a second job that does the same deletes.
  select cron.schedule(
    'prune-operational-logs',
    p_cron,
    'select public.prune_operational_logs();'
  ) into job_id;
  return job_id;
end;
$$;

comment on function public.enable_log_retention(text) is
  'Schedules the daily prune. Separate from the migration so a from-zero replay never depends on pg_cron running, and idempotent because cron.schedule upserts by job name.';

revoke all on function public.enable_log_retention(text) from public, anon, authenticated;
grant execute on function public.enable_log_retention(text) to postgres;
