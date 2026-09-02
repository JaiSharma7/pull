-- The sidecar token is a worker secret: minted inside the database, readable by the
-- worker, and by nobody a publishable key can become.
--
-- Read-only in effect: everything below rolls back, the Vault rows included.
\set ON_ERROR_STOP on

begin;

do $$
declare
  minted   text;
  read_back text;
  refused  boolean := false;
begin
  -- Vault is a platform extension. It is present on every Supabase stack this project
  -- runs on, local included, but a replay that somehow lacks it should say so rather
  -- than fail on a table that is not this migration's to create.
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise notice 'sidecar secret: vault absent, skipped';
    return;
  end if;

  -- ------------------------------------------------ 1. minted, stored, readable
  minted := public.mint_baml_sidecar_token();
  if minted is null or length(minted) <> 64 then
    raise exception 'expected a 32-byte hex token, got %', coalesce(minted, 'null');
  end if;

  perform set_config('role', 'service_role', true);
  read_back := public.generation_secret('baml_sidecar_token');
  if read_back is distinct from minted then
    raise exception 'the worker read back a different token than was minted';
  end if;

  -- ------------------------------------------------ 2. minting again rotates
  perform set_config('role', 'postgres', true);
  if public.mint_baml_sidecar_token() = minted then
    raise exception 'minting twice returned the same token';
  end if;

  -- ------------------------------------------------ 3. not for readers
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'authenticated', 'sub', extensions.gen_random_uuid())::text,
                     true);
  begin
    perform public.generation_secret('baml_sidecar_token');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader was able to read the sidecar token.';
  end if;

  refused := false;
  begin
    perform public.mint_baml_sidecar_token();
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a reader was able to mint the sidecar token.';
  end if;

  -- ------------------------------------------------ 4. the allowlist still refuses
  perform set_config('role', 'service_role', true);
  refused := false;
  begin
    perform public.generation_secret('not_a_worker_secret');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'widening the allowlist let an unlisted name through.';
  end if;

  perform set_config('role', 'postgres', true);
  raise notice 'sidecar secret: ok';
end $$;

rollback;
