-- The dispatcher should cost nothing while there is nothing to do.
--
-- `enable_generation_dispatcher_with_token` scheduled an unconditional POST to the
-- worker every 10 seconds. Measured on the hosted project: 4,268 runs, every one of
-- them against an empty queue, because no generation job has ever been created. At a
-- 10-second tick that is ~259,000 Edge Function invocations a month — over half the
-- free allowance — spent entirely on asking a worker to do nothing.
--
-- The tick is not the expensive part. `cron.schedule` runs inside the database and a
-- query that returns no rows is free; the invocation is what is metered. So the
-- interval stays at 10 seconds and the POST grows a guard, which is strictly better
-- than lengthening the interval: idle costs nothing AND a queued step is still picked
-- up within ten seconds instead of within a minute.
--
-- The guard reads `vt` rather than merely counting rows. A message whose visibility
-- timeout is still in the future is either in flight or deliberately delayed — an
-- over-quota job is enqueued with a delay rather than refused — and waking the worker
-- for it would be the same wasted invocation in a different disguise.
--
-- Law 6: this supersedes rather than edits. The function is replaced in a new
-- migration, so re-running it reschedules with the guard and every environment that
-- already applied the original converges on the next call.

create or replace function public.enable_generation_dispatcher_with_token(
  p_project_url text,
  p_seconds int default 10
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_name constant text := 'generation-dispatcher';
  token text;
begin
  -- Reuse an existing token rather than minting a new one on every call: rotating it
  -- here would silently 401 every in-flight worker until the next deploy picked the new
  -- one up. Rotation is `set_worker_secret`, deliberately a separate act.
  select decrypted_secret into token
  from vault.decrypted_secrets
  where name = 'worker_dispatch_token';

  if token is null then
    token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
    perform public.set_worker_secret('worker_dispatch_token', token);
  end if;

  perform cron.unschedule(job_name)
  where exists (select 1 from cron.job where jobname = job_name);

  -- The token is read from Vault inside the scheduled command rather than interpolated
  -- into it, so it never appears in cron.job — which anyone able to read that catalog
  -- could otherwise select.
  perform cron.schedule(
    job_name,
    p_seconds || ' seconds',
    format(
      $cmd$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'x-worker-token', (
                       select decrypted_secret from vault.decrypted_secrets
                       where name = 'worker_dispatch_token'
                     )
                   ),
        body    := '{}'::jsonb
      )
      where exists (
        select 1 from pgmq.q_generation where vt <= now()
      );
      $cmd$,
      p_project_url || '/functions/v1/worker'
    )
  );

  return format('dispatcher scheduled every %s seconds, gated on queue depth', p_seconds);
end;
$$;

comment on function public.enable_generation_dispatcher_with_token is
  'Schedules the generation dispatcher against a JWT-less worker using a Vault-held token. The POST fires only when the queue has a visible message, so an idle queue costs no Edge invocations. Call once after deploying.';

revoke all on function public.enable_generation_dispatcher_with_token(text, int)
  from anon, authenticated, public;
