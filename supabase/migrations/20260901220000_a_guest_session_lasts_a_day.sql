-- A guest session lasts a day.
--
-- 20260901190000 gave a guest thirty days of disuse before their account is swept. This
-- shortens that to one, because thirty was the wrong number for what a guest session is
-- actually for: walking the product without an address. The trade it makes is explicit
-- and worth stating, because it runs in both directions.
--
-- What one day buys. A guest account is an identity nobody can prove they own -- no
-- address, no password, no factor -- holding a reader's stashes, notes, history and
-- knowledge states. Thirty days of that is thirty days in which a stolen or shared
-- browser profile is a stranger's reading life, and thirty days of rows nobody will ever
-- come back for. One day is roughly the window in which somebody actually returns to a
-- thing they tried, and it is short enough that the population of unowned accounts stays
-- near the number of people currently looking.
--
-- What one day costs. A guest who tries the product on a Friday and comes back on Sunday
-- finds their session gone, with nothing to recover through. That is the same cliff
-- thirty days had -- it is inherent to an identity with no address, not to the number --
-- but it now arrives after a weekend rather than after a month, so the sign-in screen
-- and docs/privacy.md have to say "a day" in the same breath as "cannot be recovered".
-- They do; that copy changes in this commit.
--
-- DISUSE, NOT AGE, and that distinction is load-bearing at one day in a way it was not
-- at thirty. 20260901190000 keys the sweep on `auth.sessions.refreshed_at` precisely so
-- that a guest still reading is never deleted underneath themselves. Keyed on creation, a
-- one-day lifetime would delete somebody in the middle of their second evening with the
-- product. Nothing about that predicate changes here -- only the interval it is compared
-- against -- and this note exists so the next person to touch the number knows which of
-- the two it is.
--
-- The floor guard in `sweep_guest_accounts` refuses anything below one day, so this
-- default sits exactly on it. That is deliberate rather than a coincidence to tidy up:
-- the floor is what stops an operator typing an interval that empties the table of
-- everyone signed in this minute, and a default that could not be lowered further is the
-- strongest the feature can be while still having a guard worth having.
--
-- Append-only (law 6): 20260901190000 is untouched, and both functions are replaced
-- whole here. `create or replace` keeps the existing ACL, so the revokes and the single
-- `grant execute ... to postgres` from that migration still stand; they are re-issued at
-- the end of each section anyway, because a reader checking who may call an irreversible
-- bulk delete should not have to open a second file to find out.

-- 1. One day of disuse, not thirty. --------------------------------------------------
--
-- The body is 20260901190000's, unchanged except for the default and the comments that
-- quote a number. It is repeated in full rather than patched because a function is
-- replaced whole or not at all, and a diff against the previous migration is the honest
-- way to read what moved.
create or replace function public.sweep_guest_accounts(p_older_than interval default interval '1 day')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Bounded per run: at most this many accounts a run, so a backlog drains over several
  -- runs instead of locking `auth.users` for one long one. It bounds the accounts and not
  -- the work -- the cascade from 5000 guests is however many history events and knowledge
  -- states they left -- which is the right thing to bound, but not the same thing.
  --
  -- Unchanged from 20260901190000, where it was sized for one run a night. Section 2
  -- moves the schedule to hourly, so the same number is now a per-hour bound: twenty-four
  -- times the drain rate against a population that lives a thirtieth as long.
  batch constant int := 5000;

  stale   uuid[];
  removed int;
begin
  -- A floor on the argument, because this is an irreversible bulk delete of accounts
  -- with no soft-delete and no dry run. `sweep_guest_accounts(interval '-100 years')`
  -- would take out every guest session in the product including ones minted a second
  -- ago. Only `postgres` can call it, so this is a footgun rather than a hole -- and a
  -- footgun on a delete of `auth.users` is worth one line.
  --
  -- The default now sits on this floor rather than thirty times above it, which means
  -- the guard has stopped being theoretical: an operator who reaches for a shorter
  -- interval is no longer reaching past a comfortable margin, they are reaching past the
  -- shortest lifetime the product is willing to offer.
  if p_older_than < interval '1 day' then
    raise exception 'sweep_guest_accounts refuses an age below one day (got %)', p_older_than
      using errcode = 'check_violation';
  end if;

  -- Four conditions where one would do, because the one is a third-party behaviour this
  -- repository neither pins nor tests. Three GoTrue behaviours are load-bearing here and
  -- are worth naming so a future reader knows what to re-check: that `is_anonymous` is
  -- set true at anonymous sign-in and flipped false on conversion, that an anonymous user
  -- gets no `auth.identities` row, and that `auth.sessions.refreshed_at` moves on a token
  -- refresh while `auth.users.last_sign_in_at` does not. If the second ever changes, this
  -- predicate spares every guest and the sweep quietly deletes nothing -- safe for
  -- readers, and the wrong direction for the storage problem the section exists to solve.
  -- `is_anonymous` is the fact, and GoTrue is what flips it to false when a guest converts
  -- to a permanent account -- so if that ever stops happening, or happens after the
  -- address is attached rather than with it, a real reader's account matches a predicate
  -- that deletes it. An account with an address, a phone or a linked identity is not a
  -- guest whatever the flag says.
  --
  -- Age is measured from DISUSE, not from creation, because that is what this feature
  -- promises in three places: `docs/privacy.md` says "has not been used for a day",
  -- `docs/terms.md` says "a day of disuse", and the sign-in screen says the same. Keyed
  -- on `created_at`, a guest reading every evening is deleted mid-session on their second
  -- one -- stashes, notes and knowledge states cascading away while their browser still
  -- holds a token for a user row that no longer exists, with no address to recover
  -- through. At thirty days that was the worst outcome this file could produce. At one it
  -- is the likely one, which is why the interval moved and the predicate did not.
  --
  -- `auth.sessions` is the signal, and the user columns are not. GoTrue sets
  -- `last_sign_in_at` once, at sign-in, and does NOT bump it on a token refresh -- so for
  -- a guest, who signs in exactly once and then refreshes for ever, it is a synonym for
  -- `created_at`. `auth.sessions.refreshed_at` is the column that moves. It is declared
  -- WITHOUT a time zone while everything around it has one (20260901140000 found the
  -- same trap), so it is anchored to UTC here rather than reinterpreted in whatever
  -- TimeZone the caller happens to have.
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
              and coalesce(s.refreshed_at at time zone 'utc', s.updated_at, s.created_at)
                    >= now() - p_older_than
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
  'and everything keyed to them. Age is measured from auth.sessions.refreshed_at, so a '
  'guest still reading is never deleted underneath themselves. Reads auth.users.'
  'is_anonymous rather than the JWT claim because it runs from pg_cron with no session. '
  'See 20260901220000.';

revoke all on function public.sweep_guest_accounts(interval) from public, anon, authenticated, service_role;
grant execute on function public.sweep_guest_accounts(interval) to postgres;

-- 2. Hourly, because a daily sweep cannot honour a one-day promise. -------------------
--
-- A nightly job and a one-day lifetime do not compose. A guest who stops reading at
-- 05:00 UTC is not looked at until 04:41 the following night, so the account survives
-- 47 hours 41 minutes -- and the sign-in screen, docs/privacy.md and docs/terms.md all
-- say a day. The schedule is what makes that sentence true or false, so it moves with
-- the interval rather than being left as an operator's problem.
--
-- Hourly at :41 keeps the worst case at one day plus fifty-nine minutes, which "a day"
-- describes honestly. The minute is inherited from 20260901190000 rather than reset to
-- :00 so the sweep keeps missing the top of the hour, where the dispatcher, the vector
-- refresh and the log prune already are.
--
-- The cost of running it 24 times a day instead of once is one indexed scan of
-- `auth.users` per hour against a population bounded by the same one-day lifetime. The
-- alternative -- a daily job deleting 24 hours of accumulation at once -- does the same
-- total work in one lock-heavy burst.
--
-- Still a function an operator calls rather than something the migration does, for the
-- reason 20260901190000 and `enable_log_retention` in 20260901030000 both give: CI check
-- 4 replays every migration from zero, and a migration that calls `cron.schedule` makes
-- that replay depend on pg_cron running as a background worker inside a test container.
create or replace function public.enable_guest_sweep(p_cron text default '41 * * * *')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_id bigint;
begin
  -- `cron.schedule` upserts by name, so calling this twice reschedules rather than
  -- stacking a second job doing the same deletes. That is also what makes it the upgrade
  -- path from 20260901190000's nightly schedule: an operator who ran the old default
  -- moves to this one by calling this again, with nothing to unschedule first.
  select cron.schedule(
    'sweep-guest-accounts',
    p_cron,
    'select public.sweep_guest_accounts();'
  ) into job_id;
  return job_id;
end;
$$;

comment on function public.enable_guest_sweep(text) is
  'Schedules the hourly guest sweep. Hourly rather than nightly because the lifetime is '
  'one day and a nightly job would let an account live nearly two. Separate from the '
  'migration so a from-zero replay never depends on pg_cron running, and idempotent '
  'because cron.schedule upserts by job name. See 20260901220000.';

revoke all on function public.enable_guest_sweep(text) from public, anon, authenticated, service_role;
grant execute on function public.enable_guest_sweep(text) to postgres;
