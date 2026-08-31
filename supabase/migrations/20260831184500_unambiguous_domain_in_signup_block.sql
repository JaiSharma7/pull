-- Fix: `20260831183000` blocked every signup, not just the disposable ones.
--
-- The function declared a local variable named `domain` and then compared it against
-- `public.blocked_email_domains.domain` inside an `exists`. PL/pgSQL resolves the local
-- first but Postgres sees the column too, so the reference is ambiguous and the query
-- raises — inside the very `if` that decides whether to reject. Every insert into
-- `auth.users` therefore took the exception path and no one could create an account at
-- all, the owner included.
--
-- It failed *closed*, which is the merciful direction for a security control and the
-- worst possible direction for a signup form. Nothing in the SQL looks wrong on the
-- page; it was caught only by running all eight cases — three throwaway domains and
-- five that must be allowed — against the real trigger inside a rolled-back
-- transaction. The five that must be allowed are the ones that found it.
--
-- Superseded rather than edited (law 6): `20260831183000` is applied, so the fix is a
-- new migration and both replay to the same state from zero.

create or replace function public.reject_disposable_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  addr        text := lower(trim(new.email));
  -- Named so it cannot collide with `blocked_email_domains.domain`. The previous name
  -- was the bug; a local that shadows a column referenced in the same statement is
  -- ambiguous to the planner even when it reads unambiguously to a person.
  addr_domain text;
begin
  -- No address is not this trigger's business: anonymous and phone-only users are
  -- legitimate, and GoTrue creates them with a null email.
  if addr is null or addr = '' then
    return new;
  end if;

  -- The last '@', not the first: a quoted local part may contain one, and splitting on
  -- the first would read the domain as part of the name and let anything through.
  addr_domain := substring(addr from '[^@]*$');
  if addr_domain is null or addr_domain = '' or addr_domain = addr then
    return new;
  end if;

  -- Exact match, or a subdomain on a dot boundary. The services hand out
  -- `foo.mailinator.com` as freely as the apex, so matching only the apex blocks the
  -- front door and leaves the windows open — while a bare suffix test would also catch
  -- `notmailinator.com`, a different registrable domain that could belong to anyone.
  if exists (
    select 1 from public.blocked_email_domains b
    where addr_domain = b.domain or addr_domain like ('%.' || b.domain)
  ) then
    raise exception 'email_address_not_authorized'
      using hint = 'Disposable email domains are not accepted for signup.';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_disposable_signup() from public, anon, authenticated;
