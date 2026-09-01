-- A guest may look. A guest may not spend.
--
-- `enable_anonymous_sign_ins` (supabase/config.toml) lets the title page hand somebody a
-- session without an address, so the onboarding picker, the feed and the Delta can be
-- seen before anyone is asked to trust us with anything. That is a product decision and
-- a good one. What it also does, silently, is change the meaning of every grant in this
-- schema that reads `to authenticated`.
--
-- An anonymous user IS `authenticated`. The role in the JWT is the same, `auth.uid()`
-- returns a real uuid, and RLS therefore treats a guest exactly as it treats a reader
-- who typed a code from their inbox. For the personal tables that is precisely right --
-- a guest reads their own preferences and nobody else's, which is the whole reason this
-- works with no special case anywhere in `apps/web`.
--
-- For three doors it is wrong, and one of them is a law.
--
--   GENERATION (law 2). `enqueue_generation_job` is granted to `authenticated` and its
--   quota is three fast jobs per requester per day -- with over-quota jobs *delayed
--   rather than refused*, deliberately: "the quota protects provider spend; it does not
--   sell anything" (20260829170701). That reasoning holds exactly while a requester is
--   a person with a mailbox. A guest session is free and unlimited, so per-requester
--   quota against guests is not a weak limit, it is arithmetic with no upper bound: one
--   canonical generation costs ~$0.056, and the cost of N of them is bounded only by
--   how many times a script presses a button. So the door is shut rather than
--   re-quota'd. A guest who wants a work summarised signs in; that is a mailbox, which
--   is the thing the quota was always really counting.
--
--   AUTHORSHIP. `summaries_author_insert` lets a signed-in reader own a summary row.
--   Author-owned rows are readable by their author (`summary_is_readable`) and are the
--   input to the reuse branch, which is why 20260830203352 spent a migration proving
--   an author may not publish to the world. An unattributable account with write access
--   to that table is a poisoning surface with nobody behind it.
--
--   REPORTS. A report is a moderation queue entry that a human reads. From an account
--   that costs nothing to create and cannot be contacted, it is a way to fill that queue
--   and drown the real ones. The DMCA intake stays open to everyone, including `anon`,
--   because a rights holder must not need an account -- it is bounded by length and rate
--   instead (20260901130000). Reports have no such obligation.
--
-- Everything else a guest can already do is a row keyed to their own user id, which the
-- sweep at the end of this file eventually deletes. That is the trade: the personal
-- surface stays open so the product can be seen working, and the two surfaces that cost
-- money or somebody's attention stay shut.

-- 1. Who is a guest. ---------------------------------------------------------------
--
-- `is_anonymous` is a claim GoTrue puts in the JWT, so this is readable inside a policy
-- with no join and no table access -- which matters, because a policy that had to read
-- `auth.users` would need elevated rights to do it and would then be a second thing to
-- get wrong.
--
-- Absent claim means not a guest. Every token minted before anonymous sign-ins were
-- enabled has no `is_anonymous` at all, and those belong to people who signed in with
-- an address; refusing them would be a live outage for every reader holding an
-- unexpired token. `security invoker`, because it reads only the caller's own claims
-- and has nothing to elevate for -- but `search_path` is pinned anyway, since a function
-- that resolves `auth.jwt()` through a caller-controlled path resolves whatever the
-- caller wants.
create or replace function public.is_guest()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
$$;

comment on function public.is_guest() is
  'True when the caller holds an anonymous (guest) session. Reads the is_anonymous JWT '
  'claim; a token without the claim is not a guest. See 20260901190000.';

-- Both API roles, and nothing wider. The policies below are `to public`, so whichever
-- role is running the statement has to be able to evaluate this -- and `revoke from
-- public` first because a new function is granted to PUBLIC by default, which is the
-- gap `20260829124835_function_hardening` exists to close and would silently reopen.
revoke all on function public.is_guest() from public;
grant execute on function public.is_guest() to anon, authenticated;

-- 2. Generation is not free, so it is not for guests. -------------------------------
--
-- Supersedes 20260829170701, which stays the authority on everything else here: the
-- limits are constants rather than parameters because a caller who can pass them can
-- raise them, and the advisory lock is what stops two concurrent calls both reading the
-- same pre-insert count. Both are preserved verbatim. The only change is the refusal
-- above them.
--
-- Refused rather than delayed, which is the one place this departs from the comment it
-- inherits. Delay is the right answer to "this person is asking for a lot" because the
-- work is still theirs and they are still identifiable. It is the wrong answer to "this
-- caller is free to recreate itself", where a delayed job is simply a job that costs the
-- same and arrives later.
--
-- `28000` (invalid_authorization_specification), the same code the account functions in
-- 20260901140000 raise, so a client can tell "you may not" apart from "that failed".
create or replace function public.enqueue_generation_job(p_target jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  daily_fast_limit   constant int := 3;
  slow_delay_seconds constant int := 300;

  uid       uuid := (select auth.uid());
  used      int;
  over      boolean;
  job_id    uuid;
  delay_for int;
begin
  if uid is null then
    raise exception 'enqueue_generation_job requires an authenticated user';
  end if;

  if public.is_guest() then
    raise exception
      'Generating a summary needs an account. Sign in with an email address and try again.'
      using errcode = '28000';
  end if;

  -- Serialise per requester, so two concurrent calls cannot both read the same
  -- pre-insert count and both decide they are under the limit. Transaction
  -- scoped, and only ever contended by the same user's own bursts.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

  select count(*) into used
  from public.generation_jobs
  where requester_id = uid
    and created_at >= date_trunc('day', (now() at time zone 'utc'));

  over := used >= daily_fast_limit;

  -- Over quota is not a refusal: the work still happens, just later. The quota
  -- protects provider spend; it does not sell anything.
  delay_for := case when over then slow_delay_seconds else 0 end;

  insert into public.generation_jobs (requester_id, target, status)
  values (uid, p_target, 'queued')
  returning id into job_id;

  -- Same transaction as the insert, so there is no half-created state and no
  -- cleanup path to get wrong.
  perform pgmq.send('generation',
                    jsonb_build_object('jobId', job_id, 'step', 'resolve_identity'),
                    delay_for);

  return jsonb_build_object(
    'jobId', job_id,
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for
  );
end;
$$;

comment on function public.enqueue_generation_job is
  'Creates a generation job and queues its first step atomically. Quota is server-owned '
  'and serialised per requester; over-quota jobs are delayed, never refused. Guests are '
  'refused outright -- an anonymous session is free to recreate, so a per-requester '
  'quota does not bound spend. See 20260901190000.';

revoke all on function public.enqueue_generation_job(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_generation_job(jsonb) to authenticated;

-- 3. Authorship and reports need somebody to attribute them to. ---------------------
--
-- The `auth.uid() = author_id` half is unchanged from 20260830203352, as is the clause
-- that stops an author publishing to the world. `not public.is_guest()` is added rather
-- than substituted: a guest fails the new clause, and every other caller sees exactly
-- the policy they saw before.
drop policy if exists summaries_author_insert on public.summaries;
create policy summaries_author_insert on public.summaries
  for insert
  with check (
    (select auth.uid()) = author_id
    and not (status = 'published' and visibility = 'public')
    and not (select public.is_guest())
  );

comment on policy summaries_author_insert on public.summaries is
  'An author may insert their own non-public summary. Guests may not author at all: the '
  'row would outlive the session that made it with nobody attached to it. See '
  '20260830203352 for the publish clause and 20260901190000 for the guest clause.';

-- An update is left alone deliberately. A guest can never own a summary row after the
-- clause above, so `summaries_author_update` -- which requires `auth.uid() = author_id`
-- -- already matches nothing for them. A second guest clause there would be a
-- restriction on an empty set, and the kind of redundancy that later reads as though it
-- were load-bearing.

drop policy if exists reports_insert_own on public.reports;
create policy reports_insert_own on public.reports
  for insert
  with check (
    (select auth.uid()) = reporter_id
    and not (select public.is_guest())
  );

comment on policy reports_insert_own on public.reports is
  'A reader may file a report as themselves. Guests may not: the queue is read by a '
  'human, and an account that costs nothing to mint can fill it. The DMCA intake stays '
  'open to everyone (rights_requests) because a rights holder must not need an account.';

-- 4. Guests do not accumulate for ever. ---------------------------------------------
--
-- Every guest session leaves a `auth.users` row, a profile, a preference row and
-- whatever they read -- and unlike a sign-up, nothing about it implies anyone will ever
-- come back. Left alone this is a table that only grows, on a free-tier database where
-- storage running out is an outage.
--
-- 30 days rather than 24 hours: the point of a guest session is that somebody can close
-- the tab, think about it, and come back to what they were reading. The token itself is
-- what actually holds the session together, and it lives in the browser -- so this is a
-- floor on how long the row survives, not a promise about how long the session does.
--
-- `is_anonymous` on the table, not the claim: this runs from `pg_cron` with no JWT at
-- all, so `is_guest()` would be false for every row. The two are the same fact read from
-- the two places it exists.
--
-- Generation jobs are deleted first for the same reason `delete_my_account` does it:
-- `generation_jobs.requester_id` is ON DELETE SET NULL, so a cascade would leave the
-- target text behind with the name filed off. A guest cannot create one today (section 2
-- refuses them), which makes this a guard against a future where that changes rather
-- than a live path -- and it costs one predicate.
create or replace function public.sweep_guest_accounts(p_older_than interval default interval '30 days')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed int;
begin
  delete from public.generation_jobs g
   where g.requester_id in (
     select u.id from auth.users u
      where u.is_anonymous
        and u.created_at < now() - p_older_than
   );

  delete from auth.users u
   where u.is_anonymous
     and u.created_at < now() - p_older_than;

  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.sweep_guest_accounts(interval) is
  'Deletes guest (anonymous) accounts older than the given age, and everything keyed to '
  'them. Reads auth.users.is_anonymous rather than the JWT claim because it runs from '
  'pg_cron with no session. See 20260901190000.';

revoke all on function public.sweep_guest_accounts(interval) from public, anon, authenticated;
grant execute on function public.sweep_guest_accounts(interval) to postgres;

-- Scheduling is a function an operator calls, not something the migration does -- the
-- same argument `enable_log_retention` makes in 20260901030000. CI check 4 replays every
-- migration from zero, and a migration that calls `cron.schedule` makes that replay
-- depend on pg_cron running as a background worker inside a test container.
create or replace function public.enable_guest_sweep(p_cron text default '41 4 * * *')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_id bigint;
begin
  -- `cron.schedule` upserts by name, so calling this twice reschedules rather than
  -- stacking a second job doing the same deletes.
  select cron.schedule(
    'sweep-guest-accounts',
    p_cron,
    'select public.sweep_guest_accounts();'
  ) into job_id;
  return job_id;
end;
$$;

comment on function public.enable_guest_sweep(text) is
  'Schedules the daily guest sweep. Separate from the migration so a from-zero replay '
  'never depends on pg_cron running, and idempotent because cron.schedule upserts by '
  'job name.';

revoke all on function public.enable_guest_sweep(text) from public, anon, authenticated;
grant execute on function public.enable_guest_sweep(text) to postgres;
