-- The sweep takes the freshest signal, and takes a smaller bite.
--
-- Two corrections to `sweep_guest_accounts` from the parallel review of #48. Neither
-- changes what the function is for; both change what happens when the world is not as
-- tidy as 20260901220000 assumed.
--
-- 1. `coalesce` IS NOT `greatest`, AND THE SPARING ARM WANTED `greatest`.
--
-- The arm that spares a guest with a live session read
--
--   coalesce(s.refreshed_at at time zone 'utc', s.updated_at, s.created_at)
--
-- and `coalesce` returns the first NON-NULL value, not the most recent one. So whenever
-- `refreshed_at` is set at all it wins outright, even when `updated_at` is newer. The one
-- arm whose whole job is "has this session been used lately" could therefore answer with
-- a stale column while a fresher one sat in the next slot -- and answering stale in that
-- arm deletes somebody who is still reading.
--
-- The user-column arm two lines above already used `greatest` for exactly this reason.
-- The session arm did not, and the asymmetry was not deliberate.
--
-- This is not theoretical bookkeeping. GoTrue writes `auth.sessions` for reasons other
-- than a token refresh -- an AAL change, `not_after`, the user agent or IP moving -- and
-- 20260901220000 says in its own comment that `refreshed_at` moving on refresh is
-- third-party behaviour "this repository neither pins nor tests". The review checked the
-- hosted project and found BOTH live session rows carrying `refreshed_at IS NULL`, so
-- the `updated_at` fallback is the branch actually in use today and the premise the arm
-- rests on is, so far, undemonstrated in this deployment. At thirty days a drift like
-- that needed a month to bite. At one day it needs a day.
--
-- `greatest` over all three cannot pick a stale signal when a fresher one exists, and it
-- errs toward sparing. `-infinity` stands in for a null so a missing column cannot drag
-- the maximum down; `created_at` is `not null`, so the result never is.
--
-- 2. A BATCH BOUNDED IN ACCOUNTS IS NOT BOUNDED IN TIME.
--
-- `batch` was 5000, and 20260901220000 is careful to say it bounds the accounts and not
-- the work -- "the cascade from 5000 guests is however many history events and knowledge
-- states they left". What that comment did not carry through is that the whole sweep is a
-- SINGLE STATEMENT, and the hosted cluster sets `statement_timeout = 120000` with no
-- override for `postgres` (checked). pg_cron runs `select public.sweep_guest_accounts();`
-- as one statement under that ceiling.
--
-- So the failure is not a slow run, it is a run that deletes nothing. Five thousand
-- guests carrying a few hundred history events and knowledge states each is on the order
-- of a million cascade deletes across 24 foreign keys in `public` and 8 in `auth`; past
-- 120 s the statement is cancelled and the transaction rolls back whole. The next hour
-- selects a similar set -- the inner `limit` has no `order by` -- and fails the same way,
-- for ever, recorded only in `cron.job_run_details`. Hourly turns one nightly failure
-- into twenty-four.
--
-- 500 an hour is 12,000 a day, against a population whose lifetime is one day and whose
-- creation is capped at 30 an hour per address. That is a wide margin over any real
-- backlog while keeping each statement small enough that the ceiling is not the thing
-- deciding whether the sweep works.
--
-- Append-only (law 6): 20260901220000 and 20260901190000 are both untouched. The function
-- is replaced whole, `create or replace` keeps the ACL, and the revoke/grant pair is
-- re-issued so who may call an irreversible bulk delete is readable in this file.
create or replace function public.sweep_guest_accounts(p_older_than interval default interval '1 day')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- 500, not 5000. Bounded in accounts AND small enough to finish inside the cluster's
  -- 120 s `statement_timeout`, which the whole sweep runs under as one statement. See the
  -- header: the failure mode of the larger number is not slowness, it is a rollback that
  -- deletes nothing and repeats every hour.
  batch constant int := 500;

  stale   uuid[];
  removed int;
begin
  -- A floor, because this is an irreversible bulk delete of accounts with no soft-delete
  -- and no dry run. `sweep_guest_accounts(interval '-100 years')` would take out every
  -- guest session in the product including ones minted a second ago. Only `postgres` can
  -- call it, so this is a footgun rather than a hole -- and a footgun on a delete of
  -- `auth.users` is worth the lines.
  --
  -- IT GUARDS THE CUTOFF, NOT THE ARGUMENT, and the difference is not pedantry. Comparing
  -- intervals uses Postgres's normalisation, where a month is thirty days; the predicate
  -- below uses CALENDAR arithmetic, where it is however long the month actually is. The
  -- two disagree, so a month-bearing interval passes an interval comparison and still
  -- lands on a cutoff of now(). The security review of #48 verified it on the hosted
  -- database:
  --
  --   interval '1 mon -29 days' < interval '1 day'                      -> false
  --   timestamptz '2026-03-29 12:00+00' - interval '1 mon -29 days'     -> 2026-03-29 12:00+00
  --
  -- So `sweep_guest_accounts(interval '1 mon -29 days')` run on 29 March passed the old
  -- guard and then deleted every guest in the product, mid-session, up to the batch limit
  -- -- while 20260901220000's comment claimed it "refuses anything below one day". A guard
  -- that is wrong is worse than no guard, because the comment above it is what the next
  -- operator trusts.
  --
  -- Evaluating `now() - p_older_than` asks the only question that matters: how recent is
  -- the cutoff this call will actually use. `null` is refused explicitly rather than left
  -- to fall through -- it was harmless by accident (every comparison downstream goes null,
  -- so nothing is selected), and an irreversible delete should not rely on that.
  if p_older_than is null or now() - p_older_than > now() - interval '1 day' then
    raise exception
      'sweep_guest_accounts refuses a cutoff newer than one day ago (got %)', p_older_than
      using errcode = 'check_violation';
  end if;

  -- Four conditions where one would do, because the one is a third-party behaviour this
  -- repository neither pins nor tests. Three GoTrue behaviours are load-bearing here and
  -- are worth naming so a future reader knows what to re-check: that `is_anonymous` is
  -- set true at anonymous sign-in and flipped false on conversion, that an anonymous user
  -- gets no `auth.identities` row, and that `auth.sessions` records use. If the second
  -- ever changes, this predicate spares every guest and the sweep quietly deletes nothing
  -- -- safe for readers, and the wrong direction for the storage problem it exists to
  -- solve. An account with an address, a phone or a linked identity is not a guest
  -- whatever the flag says.
  --
  -- Age is measured from DISUSE, not from creation, because that is what this feature
  -- promises in three places: `docs/privacy.md`, `docs/terms.md` and the sign-in screen
  -- all say a day. Keyed on `created_at`, a guest reading every evening is deleted
  -- mid-session on their second one -- stashes, notes and knowledge states cascading away
  -- while their browser still holds a token for a user row that no longer exists, with no
  -- address to recover through.
  --
  -- BOTH ARMS NOW TAKE THE MAXIMUM. `greatest` over every column that could carry recent
  -- use, rather than `coalesce`, which returns the first non-null and would let a set-but-
  -- stale `refreshed_at` outrank a newer `updated_at`. `refreshed_at` is declared WITHOUT
  -- a time zone while everything around it has one (20260901140000 found the same trap),
  -- so it is anchored to UTC rather than reinterpreted in whatever TimeZone the caller
  -- happens to have; the anchor is what makes it comparable to the other two at all.
  --
  -- `-infinity` for a null so a missing column cannot drag the maximum down. `created_at`
  -- is `not null`, so the result never is.
  --
  -- The user columns stay as a floor for the case `auth.sessions` cannot answer: a guest
  -- whose session has expired and been cleaned up has no row there at all, and is
  -- sweepable on age alone.
  --
  -- Collected once into an array rather than a temporary table: `search_path = ''` is
  -- pinned above, and an unqualified temp relation does not resolve reliably under it.
  select array_agg(u.id)
    into stale
    from (
      select u.id
        from auth.users u
       where u.is_anonymous
         and u.email is null
         and u.phone is null
         and not exists (select 1 from auth.identities i where i.user_id = u.id)
         and greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at),
                      coalesce(u.updated_at, u.created_at)) < now() - p_older_than
         and not exists (
           select 1
             from auth.sessions s
            where s.user_id = u.id
              and greatest(
                    coalesce(s.refreshed_at at time zone 'utc', '-infinity'::timestamptz),
                    coalesce(s.updated_at, '-infinity'::timestamptz),
                    s.created_at
                  ) >= now() - p_older_than
         )
       limit batch
    ) u;

  if stale is null then
    return 0;
  end if;

  -- The two `on delete set null` foreign keys that would otherwise leave a reader's own
  -- material in the database with the name filed off -- the same pair, for the same
  -- reason, that `delete_my_account` deletes explicitly (20260901140000). A guest can
  -- create neither today (20260901190000 sections 2 and 3 refuse them), so this is a
  -- guard against a future where that changes; applying it to one of the two and not the
  -- other is the asymmetry that later reads as though it were deliberate.
  --
  -- `reports` and `moderation_decisions` are correctly left to anonymise: they are
  -- records of something that happened and are useless to attribute afterwards.
  delete from public.generation_jobs g where g.requester_id = any(stale);
  delete from public.summaries s
   where s.author_id = any(stale)
     and s.visibility <> 'public';

  delete from auth.users u where u.id = any(stale);

  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.sweep_guest_accounts(interval) is
  'Deletes guest (anonymous) accounts unused for the given age -- one day by default -- '
  'and everything keyed to them. Use is the GREATEST of every column that records it, on '
  'both the user and the session, so a stale column cannot outrank a fresher one and '
  'delete somebody mid-session. Bounded at 500 accounts a run to stay inside the '
  'cluster statement timeout. See 20260901230000.';

revoke all on function public.sweep_guest_accounts(interval) from public, anon, authenticated, service_role;
grant execute on function public.sweep_guest_accounts(interval) to postgres;
