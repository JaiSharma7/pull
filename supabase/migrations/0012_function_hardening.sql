-- Hardening pass, driven by what the Supabase security advisor actually flagged
-- after 0001-0011 were applied.

-- 1. Pin the trigger helper's search_path. Without it, a caller able to create
--    objects could shadow what the function resolves at runtime.
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

-- 2. Trigger and event-trigger functions live in `public`, so PostgREST exposes
--    them as RPC endpoints (/rest/v1/rpc/...). They are never meant to be called
--    that way.
--
--    This is safe: Postgres checks EXECUTE on a trigger function at CREATE
--    TRIGGER time, not when the trigger fires. Verified empirically — after the
--    revoke, an UPDATE that writes a bogus updated_at still gets it overwritten.
--
--    rls_auto_enable is a platform-provided event trigger that auto-enables RLS
--    on new public tables. We do not own it, but we can close its endpoint.
revoke all on function public.set_updated_at()   from anon, authenticated, public;
revoke all on function public.handle_new_user()  from anon, authenticated, public;
revoke all on function public.rls_auto_enable()  from anon, authenticated, public;

-- summary_is_readable is called from inside RLS policies and must stay callable.
-- retrievability and seeded_unit are pure functions and safe to expose.
