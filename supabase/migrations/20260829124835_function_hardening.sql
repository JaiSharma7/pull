-- Pin the search_path on the trigger helper. Without it a caller who can create
-- objects could shadow what the function resolves.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at is
  'Trigger helper: stamps updated_at on write.';

-- Trigger and event-trigger functions live in `public`, so PostgREST exposes
-- them as RPC endpoints. They are never meant to be called that way: Postgres
-- checks EXECUTE at CREATE TRIGGER time, not at fire time, so revoking here
-- leaves every trigger working while removing the endpoint.
revoke all on function public.set_updated_at()   from anon, authenticated, public;
revoke all on function public.handle_new_user()  from anon, authenticated, public;
-- rls_auto_enable is provided by the hosted platform and does NOT exist on a
-- local stack, so revoking it unconditionally makes this migration
-- unreplayable — `supabase db reset` dies here on a fresh checkout.
--
-- NOTE: this file deliberately differs from the statement recorded in
-- supabase_migrations on the hosted project, which ran before the guard
-- existed. Do not regenerate this file from that record; anything we did not
-- create ourselves needs this treatment.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke all on function public.rls_auto_enable() from anon, authenticated, public';
  end if;
end $$;

-- summary_is_readable is used inside RLS policies and must stay callable.
-- retrievability and seeded_unit are pure and safe to expose.
