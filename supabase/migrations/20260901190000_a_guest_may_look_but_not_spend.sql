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
--   GENERATION (law 2). `enqueue_generation_job` is granted to `authenticated`, and
--   every bound in it is per requester: three fast jobs a day, a staggered delay past
--   that, and a hard ceiling of fifty (20260829171514). Every one of those counts rows
--   belonging to one identity, which is a real bound exactly while an identity costs
--   something to obtain -- a mailbox, and a code that has to arrive in it. A guest
--   session costs nothing and can be thrown away, so fifty per requester is fifty times
--   however many requesters somebody cares to mint, which is not a bound at all. One
--   canonical generation costs ~$0.056. So the door is shut rather than re-quota'd: a
--   guest who wants a work summarised signs in, and a mailbox is the thing the quota
--   was always really counting.
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
-- Supersedes 20260829171514, which is the CURRENT definition and not 20260829170701.
-- The distinction is the whole of this comment, because the first draft of this file
-- got it wrong: it rebased on 170701, and `create or replace` on the same signature
-- silently discarded everything 171514 added -- the hard daily ceiling, the staggered
-- delay, and `remainingToday`. That is not a cosmetic regression. 171514 exists because
-- Codex round 5 found that "a fixed delay is not a throughput bound": every job past the
-- third got the same +300s, so a burst of ten thousand simply became eligible five
-- minutes later and the provider spend was unchanged. Reintroducing that, in the
-- migration whose stated purpose is bounding generation spend, would have been a law 2
-- break shipped under a law 2 banner.
--
-- So 171514's body is preserved verbatim below and only the guest refusal is added:
--
--   jobs 1-3      no delay        the free daily allowance
--   jobs 4-49     staggered       each 5 minutes further out than the last
--   50+           refused         a ceiling no human reaches, which is what stops a
--                                 script
--   guests        refused         see below
--
-- Refused rather than delayed or ceilinged, which is the one place a guest differs.
-- Both of those bound a caller who is fixed. Neither bounds a caller who can throw
-- itself away and come back: a per-requester ceiling of 50 against an identity that
-- costs nothing to mint is a ceiling of 50 times however many identities somebody wants.
--
-- READ FROM THE TABLE, NOT THE CLAIM. `is_guest()` reads `is_anonymous` out of the JWT,
-- which is right for a policy -- a policy must not join, and it is evaluated on every
-- row. This function is `security definer` and runs once per call, so it can afford to
-- ask `auth.users` directly, and the direction of failure is why it should. A claim is a
-- copy of a fact, minted up to `jwt_expiry` ago; anything that ever produces a guest
-- whose token lacks the claim -- a custom access-token hook, a third-party integration,
-- a client holding a token across a conversion -- makes them a non-guest, and the
-- fail-open direction here is the one that spends money. Section 4 makes the same
-- argument for the sweep. The two are the same fact read from the two places it exists,
-- and the money door reads the authoritative one.
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
  -- Server-owned. Not parameters: this function is reachable by any signed-in
  -- caller, so anything tunable here is tunable by the person being limited.
  daily_fast_limit   constant int := 3;
  daily_hard_ceiling constant int := 50;
  stagger_seconds    constant int := 300;

  uid       uuid := (select auth.uid());
  used      int;
  over      boolean;
  job_id    uuid;
  delay_for int;
begin
  if uid is null then
    raise exception 'enqueue_generation_job requires an authenticated user';
  end if;

  if exists (select 1 from auth.users u where u.id = uid and u.is_anonymous) then
    raise exception
      'Generating a summary needs an account. Sign in with an email address and try again.'
      using errcode = '28000';
  end if;

  -- Serialise per requester, so two concurrent calls cannot both read the same
  -- pre-insert count and both decide they are under the limit.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 0));

  select count(*) into used
  from public.generation_jobs
  where requester_id = uid
    and created_at >= date_trunc('day', (now() at time zone 'utc'));

  if used >= daily_hard_ceiling then
    raise exception 'daily generation ceiling reached (% jobs); try again tomorrow',
      daily_hard_ceiling
      using errcode = 'check_violation';
  end if;

  over := used >= daily_fast_limit;

  -- Staggered, not fixed: each job past the allowance is scheduled a further
  -- interval out, so the queue drains at a bounded rate instead of all at once.
  delay_for := case
                 when over then (used - daily_fast_limit + 1) * stagger_seconds
                 else 0
               end;

  insert into public.generation_jobs (requester_id, target, status)
  values (uid, p_target, 'queued')
  returning id into job_id;

  -- Same transaction as the insert, so there is no half-created state.
  perform pgmq.send('generation',
                    jsonb_build_object('jobId', job_id, 'step', 'resolve_identity'),
                    delay_for);

  return jsonb_build_object(
    'jobId', job_id,
    'queue', case when over then 'normal' else 'fast' end,
    'delaySeconds', delay_for,
    'remainingToday', daily_hard_ceiling - used - 1
  );
end;
$$;

comment on function public.enqueue_generation_job is
  'Creates a generation job and queues its first step atomically. Quota is server-owned, '
  'serialised per requester, and staggered so throughput past the free allowance is '
  'genuinely bounded. Guests are refused outright -- an anonymous session is free to '
  'recreate, so no per-requester bound holds against one. See 20260901190000.';

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
  -- Bounded per run, so one nightly transaction can never be arbitrarily large -- and so
  -- a backlog drains over several nights instead of locking `auth.users` for one long
  -- one. At 30 days of guests this is far above any real volume.
  batch constant int := 5000;

  stale   uuid[];
  removed int;
begin
  -- A floor on the argument, because this is an irreversible bulk delete of accounts
  -- with no soft-delete and no dry run. `sweep_guest_accounts(interval '-100 years')`
  -- would take out every guest session in the product including ones minted a second
  -- ago. Only `postgres` can call it, so this is a footgun rather than a hole -- and a
  -- footgun on a delete of `auth.users` is worth one line.
  if p_older_than < interval '1 day' then
    raise exception 'sweep_guest_accounts refuses an age below one day (got %)', p_older_than
      using errcode = 'check_violation';
  end if;

  -- Four conditions where one would do, because the one is a third-party behaviour this
  -- repository neither pins nor tests. `is_anonymous` is the fact, and GoTrue is what
  -- flips it to false when a guest converts to a permanent account -- so if that ever
  -- stops happening, or happens after the address is attached rather than with it, a
  -- real reader's account matches a predicate that deletes it. An account with an
  -- address, a phone or a linked identity is not a guest whatever the flag says.
  --
  -- Age is measured from DISUSE, not from creation, because that is what this feature
  -- promises in three places: `docs/privacy.md` says "has not been used for 30 days",
  -- `docs/terms.md` says "30 days of disuse", and the comment above says somebody can
  -- close the tab, think about it and come back. Keyed on creation, a guest who reads
  -- every day is deleted mid-session on day 31 -- stashes, notes and knowledge states
  -- cascading away while their browser still holds a token for a user row that no longer
  -- exists, with no address to recover through. That is the worst outcome this file can
  -- produce, and it would have shipped looking like it worked.
  --
  -- `auth.sessions` is the signal; the user columns are not. GoTrue sets
  -- `last_sign_in_at` once, at sign-in, and does NOT bump it on a token refresh -- so for
  -- a guest, who signs in exactly once and then refreshes for ever, it is a synonym for
  -- `created_at`. `auth.sessions.refreshed_at` is the column that moves. It is declared
  -- WITHOUT a time zone while everything around it has one (20260901140000 hit the same
  -- trap), so it is anchored to UTC here rather than reinterpreted in whatever TimeZone
  -- the caller happens to be in.
  --
  -- The user columns stay as a floor, for the case `auth.sessions` cannot answer: a guest
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
  -- create neither today (sections 2 and 3 refuse them), so this is a guard against a
  -- future where that changes; applying it to one of the two and not the other is the
  -- asymmetry that later reads as though it were deliberate.
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
  'Deletes guest (anonymous) accounts older than the given age, and everything keyed to '
  'them. Reads auth.users.is_anonymous rather than the JWT claim because it runs from '
  'pg_cron with no session. See 20260901190000.';

-- `service_role` is named explicitly, and it is not belt and braces. Supabase grants
-- EXECUTE on every new function in `public` to it by default -- the mechanic
-- 20260830200114 spells out -- so a revoke listing only `public, anon, authenticated`
-- leaves the secret key able to call this and empty the guest population in one
-- statement. That role is omnipotent anyway, so this is blast radius rather than a hole.
-- What makes it worth a line is that the grant below reads "postgres only", and without
-- this it would not have been true.
revoke all on function public.sweep_guest_accounts(interval) from public, anon, authenticated, service_role;
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

revoke all on function public.enable_guest_sweep(text) from public, anon, authenticated, service_role;
grant execute on function public.enable_guest_sweep(text) to postgres;

-- 5. What anyone may write, now that an identity is free. ---------------------------
--
-- The doors above are the ones that cost money or somebody's attention. This is the one
-- that costs disk, and it is the half of anonymous sign-in that is easy to miss because
-- nothing about it is guest-specific.
--
-- `20260901130000` bounded the DMCA intake and made the argument in full: an unbounded
-- write from a caller who costs nothing to create "is not a data breach... It is a
-- storage bill, and on the free tier a storage bill is an outage." That reasoning
-- applied to `anon` on one table, because `rights_requests` was then the only write in
-- the schema reachable without an account. It is not any more. Every self-keyed insert
-- policy in `20260829124730` is now reachable by a caller that costs nothing to create,
-- and not one of the columns behind them has a length check:
--
--   notes.body, stashes.name, stashes.description, saved_items.note,
--   highlights.text, convictions.rationale, explanations.text
--
-- The sweep in section 4 is a 30-day answer to a problem that can fill a disk in an
-- afternoon, so it is not the answer here.
--
-- Bounded for everyone rather than for guests, and that is deliberate on two counts. A
-- cap does not depend on `is_guest()` being right, so it holds even if the claim is ever
-- wrong; and the same hole is open to anyone holding one compromised mailbox, which was
-- already true before this branch and is not a guest problem at all. Guests are simply
-- what made it worth fixing now.
--
-- The numbers are sized to be invisible to a person and fatal to a script. 20000
-- characters is roughly eight pages of prose in a note nobody will write; a stash name
-- that does not fit in 200 is not a name. `docs/product.md` describes none of these as
-- long-form fields.
--
-- No existing row can violate these: `notes`, `stashes`, `saved_items`, `highlights`,
-- `convictions` and `explanations` are per-reader tables with no seed data (the corpus
-- migrations write works, editions, summaries and pulls), so the constraints validate
-- against an empty set on a from-zero replay.

alter table public.notes
  add constraint notes_body_length check (length(body) between 1 and 20000);

alter table public.stashes
  add constraint stashes_name_length check (length(name) between 1 and 200),
  add constraint stashes_description_length
    check (description is null or length(description) <= 2000);

alter table public.saved_items
  add constraint saved_items_note_length check (note is null or length(note) <= 20000);

alter table public.highlights
  add constraint highlights_text_length check (length(text) between 1 and 20000);

alter table public.convictions
  add constraint convictions_rationale_length
    check (rationale is null or length(rationale) <= 20000);

alter table public.explanations
  add constraint explanations_text_length check (length(text) between 1 and 20000);
