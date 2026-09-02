-- A shared token for the BAML sidecar, held where the dispatch token is held.
--
-- Law 7 gained two rows for the sidecar (docs/baml.md, CLAUDE.md): the provider key
-- lives in the sidecar's own environment and the worker never sees it; what the
-- worker holds is a shared token, and this migration is where that token lives --
-- Vault, behind the same allow-listed `security definer` pair the dispatch token
-- uses, so the worker reads it through `generation_secret` and nothing else can.
--
-- Two functions are replaced whole to widen the allowlist by one name. Append-only
-- (law 6): 20260901060000 is untouched, and `create or replace` keeps the ACL. The
-- allowlist is also mirrored in `_shared/config.test.ts`, deliberately by hand, so
-- that a `getSecret` call for a name no migration allows fails a test rather than a
-- deployment.
create or replace function public.generation_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if p_name not in ('google_ai_api_key', 'anthropic_api_key', 'worker_dispatch_token',
                    'baml_sidecar_token') then
    raise exception 'generation_secret: % is not a worker secret', p_name
      using errcode = 'insufficient_privilege';
  end if;

  select decrypted_secret into v
  from vault.decrypted_secrets
  where name = p_name;

  -- Null when unset. The worker decides whether a missing secret is fatal for the step
  -- it is running: no sidecar token means fall back to the stub provider, not crash --
  -- unless REQUIRE_REAL_PROVIDERS says otherwise, which is the worker's call.
  return v;
end;
$$;

create or replace function public.set_worker_secret(p_name text, p_value text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  if p_name not in ('google_ai_api_key', 'anthropic_api_key', 'worker_dispatch_token',
                    'baml_sidecar_token') then
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

-- Mint the token, once, inside the database.
--
-- The same shape as `enable_generation_dispatcher_with_token`: nothing has to be
-- invented on a laptop and pasted twice. The value is RETURNED, because the sidecar
-- runs outside this database and has to be given it -- put it in the sidecar's
-- environment as BAML_SIDECAR_TOKEN. It is returned exactly once; calling this again
-- rotates it, which is deliberate and is the whole rotation procedure: call, redeploy
-- the sidecar with the new value, and the worker picks the new one up within its
-- 60-second provider cache.
create or replace function public.mint_baml_sidecar_token()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
begin
  perform public.set_worker_secret('baml_sidecar_token', token);
  return token;
end;
$$;

comment on function public.mint_baml_sidecar_token() is
  'Mints (or rotates) the BAML sidecar token into Vault and returns it once, for the sidecar''s environment. postgres only.';

revoke all on function public.generation_secret(text) from anon, authenticated, public;
revoke all on function public.set_worker_secret(text, text) from anon, authenticated, public;
revoke all on function public.mint_baml_sidecar_token() from anon, authenticated, public;

grant execute on function public.generation_secret(text) to service_role;
grant execute on function public.set_worker_secret(text, text) to service_role;
grant execute on function public.mint_baml_sidecar_token() to postgres;
