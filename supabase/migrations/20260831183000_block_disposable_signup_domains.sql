-- Block throwaway addresses at signup, in the one place a client cannot route around.
--
-- Supabase's built-in SMTP is rate-limited **per hour and counts every request**, not
-- every delivery. That makes the send budget a shared resource between real readers and
-- anyone pointing a script at the sign-in form: a few dozen `signInWithOtp` calls to
-- throwaway addresses exhaust the hour, and the next genuine reader — the owner
-- included — is told to wait with no way to shorten it. That happened on 2026-08-31.
--
-- `apps/web/src/lib/email-domain.ts` refuses these in the browser too, which is what
-- actually protects the budget: a refusal there never spends a request. But the browser
-- is an optimisation, not a control — a script hitting the Auth endpoint directly never
-- runs a line of it. This is the half that is true regardless of the client.

create table public.blocked_email_domains (
  domain      text primary key,
  reason      text        not null default 'disposable',
  created_at  timestamptz not null default now(),
  -- Bare, lowercase, at least one dot. The trigger below compares against a lowercased
  -- domain, so an entry with a capital or a stray '@' would sit here matching nothing —
  -- a blocklist that silently does not block is worse than no blocklist.
  constraint blocked_email_domains_shape check (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$')
);

comment on table public.blocked_email_domains is
  'Email domains refused at signup. Authoritative; apps/web/src/lib/email-domain.ts is a client-side fast path seeded from the same list.';

-- Law 5: RLS in the migration that creates the table.
alter table public.blocked_email_domains enable row level security;

-- Readable by anyone. The list is not a secret — every entry is a published throwaway
-- service, and a reader refused at signup is entitled to see why. Keeping it readable
-- also lets the client check against the authoritative copy rather than only its bundle.
create policy blocked_email_domains_read_all
  on public.blocked_email_domains for select using (true);

-- No insert, update or delete policy, deliberately. With RLS on and no write policy,
-- every write through PostgREST is refused for every role that respects RLS, including
-- `authenticated`. Editing the list is an operator action through a migration or a
-- service-role connection, which is the only way it should ever change.

insert into public.blocked_email_domains (domain) values
  ('0-mail.com'), ('10minutemail.com'), ('20minutemail.com'), ('anonbox.net'),
  ('burnermail.io'), ('dispostable.com'), ('emailondeck.com'), ('fakeinbox.com'),
  ('getairmail.com'), ('getnada.com'), ('guerrillamail.com'), ('guerrillamail.info'),
  ('guerrillamail.net'), ('guerrillamail.org'), ('harakirimail.com'), ('inboxbear.com'),
  ('incognitomail.com'), ('jetable.org'), ('mail-temporaire.fr'), ('mail7.io'),
  ('mailcatch.com'), ('maildrop.cc'), ('mailinator.com'), ('mailnesia.com'),
  ('mailsac.com'), ('mintemail.com'), ('moakt.com'), ('mohmal.com'), ('mytemp.email'),
  ('nowmymail.com'), ('sharklasers.com'), ('spam4.me'), ('spamgourmet.com'),
  ('temp-mail.io'), ('temp-mail.org'), ('tempail.com'), ('tempinbox.com'),
  ('tempmail.net'), ('tempmailo.com'), ('tempr.email'), ('throwawaymail.com'),
  ('trashmail.com'), ('trashmail.de'), ('trbvm.com'), ('yopmail.com'), ('yopmail.fr'),
  ('yopmail.net')
on conflict (domain) do nothing;

/*
 * The block itself.
 *
 * `before insert on auth.users` is the right hook because GoTrue creates the user row
 * *before* it sends anything: raising here means the address never costs an email, and
 * the account never exists to be retried against. An `after` trigger would fire too
 * late, and a check on `signInWithOtp` alone would miss every other entry point.
 *
 * Only inserts. An existing reader whose provider later lands on the list keeps their
 * account and their sign-in — retroactively locking someone out of a product they
 * already use, over a list edit, is not a thing this trigger is allowed to do.
 *
 * `security definer` because `auth.users` is written by GoTrue's own role, which has no
 * business being granted rights on a public table. `search_path` is pinned empty and
 * every name below is schema-qualified: a `security definer` function that resolves
 * unqualified names is the classic privilege-escalation shape, since anyone who can
 * create a table in a searched schema can shadow the one it meant.
 */
create or replace function public.reject_disposable_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  addr   text := lower(trim(new.email));
  domain text;
begin
  -- No address at all is not this trigger's business; anonymous and phone-only users
  -- are legitimate and GoTrue creates them with a null email.
  if addr is null or addr = '' then
    return new;
  end if;

  -- The last '@', not the first: a quoted local part may contain one, and splitting on
  -- the first would read the domain as part of the name and let anything through.
  domain := substring(addr from '[^@]*$');
  if domain is null or domain = addr then
    return new;
  end if;

  -- Exact match, or a subdomain of a blocked domain on a dot boundary. The services
  -- hand out `foo.mailinator.com` as freely as the apex, so matching only the apex
  -- blocks the front door and leaves the windows open — while a bare suffix test would
  -- also catch `notmailinator.com`, which is a different registrable domain entirely.
  if exists (
    select 1 from public.blocked_email_domains b
    where domain = b.domain or domain like ('%.' || b.domain)
  ) then
    raise exception 'email_address_not_authorized'
      using hint = 'Disposable email domains are not accepted for signup.';
  end if;

  return new;
end;
$$;

comment on function public.reject_disposable_signup() is
  'BEFORE INSERT on auth.users: refuses signups from domains in public.blocked_email_domains, before GoTrue spends an email on them.';

-- Revoked from the API roles: nothing should be able to call this directly, and a
-- `security definer` function reachable over PostgREST is a surface with no reason to
-- exist. The trigger invokes it as the table owner regardless of these grants.
revoke all on function public.reject_disposable_signup() from public, anon, authenticated;

drop trigger if exists reject_disposable_signup on auth.users;
create trigger reject_disposable_signup
  before insert on auth.users
  for each row execute function public.reject_disposable_signup();
