-- The dispatcher that drives the generation step-machine.
--
-- Deliberately NOT scheduled by this migration. The worker Edge Function must
-- be deployed and real providers configured first; a cron job firing every ten
-- seconds against a function that does not exist would fill the logs with
-- failures and teach everyone to ignore them.
--
-- An operator turns it on once, after deploying:
--     select public.enable_generation_dispatcher('https://<ref>.supabase.co', '<service_role_key>');

create or replace function public.enable_generation_dispatcher(
  p_project_url text,
  p_service_key text,
  p_seconds int default 10
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_name constant text := 'generation-dispatcher';
begin
  -- Store the key in Vault rather than inlining it into a cron command, where
  -- it would be readable by anyone who can select from cron.job.
  perform vault.create_secret(p_service_key, 'generation_worker_key', 'Service role key for the generation worker')
  where not exists (select 1 from vault.secrets where name = 'generation_worker_key');

  perform cron.unschedule(job_name)
  where exists (select 1 from cron.job where jobname = job_name);

  perform cron.schedule(
    job_name,
    p_seconds || ' seconds',
    format(
      $cmd$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || (
                       select decrypted_secret from vault.decrypted_secrets
                       where name = 'generation_worker_key'
                     )
                   ),
        body    := '{}'::jsonb
      );
      $cmd$,
      p_project_url || '/functions/v1/worker'
    )
  );

  return format('dispatcher scheduled every %s seconds', p_seconds);
end;
$$;

comment on function public.enable_generation_dispatcher is
  'Schedules the pg_cron job that ticks the generation worker. Call once after deploying the function.';

create or replace function public.disable_generation_dispatcher()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cron.unschedule('generation-dispatcher')
  where exists (select 1 from cron.job where jobname = 'generation-dispatcher');
  return 'dispatcher stopped';
end;
$$;

-- These reconfigure infrastructure and must never be reachable from the API.
revoke all on function public.enable_generation_dispatcher(text, text, int)
  from anon, authenticated, public;
revoke all on function public.disable_generation_dispatcher()
  from anon, authenticated, public;
