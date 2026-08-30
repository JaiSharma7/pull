-- Worker secrets, and a dispatcher that can turn itself on.
--
-- `enable_generation_dispatcher` takes the service_role key as an argument because
-- pg_cron has to authenticate to an Edge Function that verifies a JWT. That key can only
-- come from a person reading it out of the dashboard, so generation stays dead until
-- someone performs that step by hand.
--
-- This adds the other half of the choice. The worker deploys with JWT verification off
-- and authenticates a dispatch token that it and the cron job both read from Vault. The
-- token is generated in the database and never leaves it, so nothing has to be pasted
-- anywhere to turn generation on. The original function is untouched and still works
-- (law 6: append, never edit).

-- Read one worker secret from Vault.
--
-- Deliberately NOT a general vault reader. `generation_worker_key` sits in the same vault
-- and is the service_role key; a function that returns any secret by name is one mistaken
-- grant away from handing out full database access. With the allowlist, the worst case of
-- that mistake is a leaked model key.
create or replace function public.generation_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if p_name not in ('google_ai_api_key', 'worker_dispatch_token') then
    raise exception 'generation_secret: % is not a worker secret', p_name
      using errcode = 'insufficient_privilege';
  end if;

  select decrypted_secret into v
  from vault.decrypted_secrets
  where name = p_name;

  -- Null when unset. The worker decides whether a missing secret is fatal for the step
  -- it is running: no model key means fall back to the stub provider, not crash.
  return v;
end;
$$;

comment on function public.generation_secret is
  'Reads one allow-listed generation secret from Vault. Service role only.';

-- Create or rotate one of those secrets.
--
-- Same allowlist, for the same reason: this must not become a way to overwrite the
-- service_role key that the other dispatcher path depends on.
create or replace function public.set_worker_secret(p_name text, p_value text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  if p_name not in ('google_ai_api_key', 'worker_dispatch_token') then
    raise exception 'set_worker_secret: % is not a worker secret', p_name
      using errcode = 'insufficient_privilege';
  end if;

  if p_value is null or length(p_value) = 0 then
    raise exception 'set_worker_secret: % cannot be empty', p_name
      using errcode = 'check_violation';
  end if;

  select id into existing from vault.secrets where name = p_name;

  if existing is null then
    perform vault.create_secret(p_value, p_name, 'What a Pull generation worker secret');
  else
    perform vault.update_secret(existing, p_value);
  end if;

  return p_name;
end;
$$;

comment on function public.set_worker_secret is
  'Creates or rotates an allow-listed generation secret in Vault. Service role only.';

-- Schedule the dispatcher using a Vault-held token instead of the service_role key.
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
      );
      $cmd$,
      p_project_url || '/functions/v1/worker'
    )
  );

  return format('dispatcher scheduled every %s seconds', p_seconds);
end;
$$;

comment on function public.enable_generation_dispatcher_with_token is
  'Schedules the generation dispatcher against a JWT-less worker using a Vault-held token. Call once after deploying.';

-- These read secrets and reconfigure infrastructure. They must never be reachable from
-- the API roles: PostgREST exposes every function in `public` that a role can execute.
revoke all on function public.generation_secret(text) from anon, authenticated, public;
revoke all on function public.set_worker_secret(text, text) from anon, authenticated, public;
revoke all on function public.enable_generation_dispatcher_with_token(text, int)
  from anon, authenticated, public;

grant execute on function public.generation_secret(text) to service_role;
