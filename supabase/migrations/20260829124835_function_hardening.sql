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
revoke all on function public.rls_auto_enable()  from anon, authenticated, public;

-- summary_is_readable is used inside RLS policies and must stay callable.
-- retrievability and seeded_unit are pure and safe to expose.
