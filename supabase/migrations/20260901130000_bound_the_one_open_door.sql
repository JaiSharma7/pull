-- The DMCA intake is the only unauthenticated write in the schema, and it was unbounded.
--
-- `rights_requests_insert_any` is `for insert with check (true)`, which is correct and
-- has to stay: a rights holder must be able to send a notice without first making an
-- account with the service they are complaining about. What was wrong is that the row
-- it accepts had no ceiling on it. `notice_body text` with no length check, from `anon`,
-- at whatever rate a script cares to send -- against a free-tier Postgres whose project
-- ref is committed in `apps/web/.env.production` and becomes searchable the day this
-- repository is published.
--
-- That is not a data breach; `rights_requests_no_read` already makes the table
-- write-only through the API. It is a storage bill, and on the free tier a storage bill
-- is an outage.
--
-- Two bounds, because either alone is insufficient: a length cap without a rate cap
-- still fills the disk one small row at a time, and a rate cap without a length cap
-- lets sixty rows an hour be sixty megabytes.
--
-- `rate_limits` is not usable here. It is keyed `(user_id, bucket, window_start)` with
-- `user_id` not null and a foreign key to `auth.users`, so it cannot describe a caller
-- who has no account -- which is every caller on this path. PostgREST does not hand the
-- client address down to Postgres either, so there is nothing per-sender to key on at
-- all. What is left is a global ceiling, and the honest reading of that is: this bounds
-- the damage, it does not attribute it.

-- 1. What a notice may contain. ----------------------------------------------------
--
-- Sized against 17 U.S.C. 512(c)(3), which asks for identification of the work, of the
-- material, contact details, and two statements of good faith. That is a paragraph or
-- two. 8000 characters is several times what a complete notice needs and still four
-- orders of magnitude below what `text` would otherwise accept.

alter table public.rights_requests
  add constraint rights_requests_name_length
    check (length(claimant_name) between 1 and 200),
  add constraint rights_requests_email_length
    check (length(claimant_email) between 3 and 320),
  add constraint rights_requests_email_shape
    check (claimant_email like '%_@_%'),
  add constraint rights_requests_body_length
    check (length(notice_body) between 1 and 8000),
  add constraint rights_requests_resolution_length
    check (resolution is null or length(resolution) <= 8000);

-- 2. How many may arrive. ----------------------------------------------------------
--
-- 60 an hour, counted across everyone. For a service this size that is far above any
-- real notice volume and far below a fill: at the length cap above, a saturated hour
-- costs well under a megabyte.
--
-- The trigger is `before insert` so a refused notice writes nothing, and it raises with
-- SQLSTATE 53400 (`configuration_limit_exceeded`) rather than a bare exception, so
-- PostgREST returns something a client can distinguish from a validation failure.
--
-- `security definer` is load-bearing, and the first draft of this file got it wrong.
-- The counting query reads `rights_requests`, and `rights_requests_no_read` is
-- `for select using (false)` -- so as `anon` the count is not "how many notices
-- arrived", it is always zero, and the ceiling never fires. A rate limit that reads
-- through the policy it is protecting against is not a weak rate limit; it is a
-- comment. Running as owner is what lets it see the rows it is counting.
--
-- Execute is revoked from the API roles for the same reason every other definer
-- function in this schema revokes it (20260829124835): a trigger is invoked by the
-- trigger, never by a caller, so nothing legitimate loses anything.

create index if not exists rights_requests_received_idx
  on public.rights_requests (received_at desc);

create or replace function public.rights_requests_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent int;
begin
  select count(*) into recent
    from public.rights_requests
   where received_at > now() - interval '1 hour';

  if recent >= 60 then
    raise exception
      'Too many rights notices received in the past hour. Please retry shortly, or '
      'email the address published in docs/terms.md.'
      using errcode = '53400';
  end if;

  return new;
end;
$$;

revoke all on function public.rights_requests_rate_limit()
  from anon, authenticated, public;

create trigger rights_requests_rate_limit
  before insert on public.rights_requests
  for each row execute function public.rights_requests_rate_limit();

comment on table public.rights_requests is
  'DMCA and rights intake. The only table `anon` may insert into, deliberately -- a '
  'rights holder must not need an account. Bounded by length checks and a global '
  'hourly ceiling rather than per-sender, because PostgREST does not pass the client '
  'address to Postgres and `rate_limits` requires a user_id. See 20260901130000.';
