-- A reader could sign in, and could not do anything else to their own account.
--
-- The whole account surface was one button calling `supabase.auth.signOut()` with no
-- scope argument, which ends the session in *this* tab and leaves every other one
-- alive. There was no way to see where you were signed in, no way to end a session on
-- a device you no longer have, and no way to delete your account -- `docs/privacy.md`
-- promised deletion and the mechanism was an email to a personal Gmail address.
--
-- None of this needs an Edge Function or a service-role key. `auth.uid()` is
-- authoritative inside Postgres, the `auth` schema is not exposed through PostgREST,
-- and `security definer` is exactly the tool for reaching across that boundary on
-- behalf of one caller. That is the same argument `enqueue_generation_job` makes, and
-- it is worth more here: the alternative design puts an admin credential in a new
-- place and then has to re-derive, in TypeScript, the identity Postgres already knows.
--
-- Every function below is revoked from `anon` and granted only to `authenticated`, and
-- every one derives the user from `auth.uid()` rather than from an argument. There is
-- no parameter anywhere in this file that names a user.

-- ------------------------------------------------------------------ 1. sessions

/**
 * Where a reader is signed in.
 *
 * `auth.sessions` is not reachable through PostgREST, which is correct -- it holds
 * every session for every user. This hands back one caller's rows and nothing else.
 *
 * `ip` and `user_agent` are the reader's own, recorded by GoTrue at sign-in, and are
 * what make the list usable: "Firefox on Linux, 3 days ago" is a thing a person can
 * make a decision about, and a bare uuid is not.
 */
create or replace function public.my_sessions()
returns table (
  id           uuid,
  created_at   timestamptz,
  -- `timestamp`, not `timestamptz`: GoTrue declares `refreshed_at` without a time zone
  -- while `created_at`, `updated_at` and `not_after` have one. Declaring it timestamptz
  -- here does not error -- the assignment cast applies -- it reinterprets the value in
  -- the session's TimeZone, which is right on a UTC connection and wrong on any other.
  refreshed_at timestamp,
  not_after    timestamptz,
  aal          text,
  user_agent   text,
  ip           text,
  is_current   boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id,
         s.created_at,
         s.refreshed_at,
         s.not_after,
         s.aal::text,
         s.user_agent,
         host(s.ip),
         s.id::text is not distinct from (auth.jwt() ->> 'session_id')
    from auth.sessions s
   where s.user_id = auth.uid()
     and auth.uid() is not null
   order by (s.id::text is not distinct from (auth.jwt() ->> 'session_id')) desc,
            coalesce(s.refreshed_at, s.created_at) desc;
$$;

revoke all on function public.my_sessions() from anon, authenticated, public;
grant execute on function public.my_sessions() to authenticated;

/**
 * End one session.
 *
 * Deleting the `auth.sessions` row is what actually revokes it: `auth.refresh_tokens`
 * cascades from it, so the holder cannot mint a new access token. The access token
 * already issued stays valid until it expires -- that is how stateless JWTs work and
 * no amount of server-side deleting changes it. The honest description is "this device
 * cannot get a new token", not "this device is locked out this instant", and the UI
 * says so rather than implying otherwise.
 *
 * The `user_id` predicate is the security control, not the id parameter. A caller may
 * pass any uuid they like; they will delete a row only if it is theirs.
 */
create or replace function public.revoke_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed int;
begin
  if auth.uid() is null then
    raise exception 'revoke_session requires an authenticated user'
      using errcode = '28000';
  end if;

  delete from auth.sessions s
   where s.id = p_session_id
     and s.user_id = auth.uid();

  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

revoke all on function public.revoke_session(uuid) from anon, authenticated, public;
grant execute on function public.revoke_session(uuid) to authenticated;

/**
 * Sign out everywhere else, keeping the session that asked.
 *
 * Distinct from `signOut({ scope: 'global' })` on purpose: global also ends the
 * current session, so the reader is logged out by the act of securing their account.
 * That is the wrong shape for the case this exists for -- "something is wrong, get
 * everyone else out" -- because it drops you at a sign-in screen with no confirmation
 * that anything happened.
 */
create or replace function public.revoke_other_sessions()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed int;
begin
  if auth.uid() is null then
    raise exception 'revoke_other_sessions requires an authenticated user'
      using errcode = '28000';
  end if;

  delete from auth.sessions s
   where s.user_id = auth.uid()
     and s.id::text is distinct from (auth.jwt() ->> 'session_id');

  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.revoke_other_sessions() from anon, authenticated, public;
grant execute on function public.revoke_other_sessions() to authenticated;

-- ------------------------------------------------------------------ 2. deletion

/**
 * How recently the caller proved they hold the address.
 *
 * Deletion is irreversible, so it asks for a fresh sign-in rather than accepting a
 * token minted weeks ago on a device that may since have been left on a train. There
 * is no separate "re-authenticate" primitive to lean on here: sign-in is a one-time
 * code, and verifying one creates a *new session*. So session age is the re-auth
 * check, and the client flow is simply "send a code, verify it, then delete" -- which
 * produces a session created seconds ago.
 *
 * `created_at`, deliberately, not `refreshed_at`. A refresh happens by itself in the
 * background; it proves the token is still held, not that a person is present.
 */
create or replace function public.session_age_seconds()
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select extract(epoch from now() - s.created_at)::int
    from auth.sessions s
   where s.id::text = (auth.jwt() ->> 'session_id')
     and s.user_id = auth.uid();
$$;

revoke all on function public.session_age_seconds() from anon, authenticated, public;
grant execute on function public.session_age_seconds() to authenticated;

/**
 * Delete the caller's account and everything keyed to it.
 *
 * Nineteen foreign keys in `public` reference `auth.users` with `on delete cascade`, so
 * most of this is one delete. Four do not, and they are the reason this function exists
 * rather than a bare `delete from auth.users`:
 *
 *   generation_jobs.requester_id   on delete set null
 *   summaries.author_id            on delete set null
 *   reports.reporter_id            on delete set null
 *   moderation_decisions.moderator_id  on delete set null
 *
 * The last two are correct as they stand: a report and a moderation decision are
 * records of something that happened, they are useless to attribute after the account
 * is gone, and anonymising them is the right outcome.
 *
 * The first two are not. `generation_jobs.target` can carry text the reader pasted in,
 * and `job_steps.output` carries what the worker fetched -- so a SET NULL leaves the
 * reader's material in the database with the name filed off. `docs/privacy.md` admitted
 * this in as many words: "if you want a submitted document gone, ask us and we will
 * delete them by hand". That is the gap; this closes it. `job_steps` cascades from
 * `generation_jobs`, so deleting the job takes its steps and their output with it.
 *
 * `cost_ledger` deliberately keeps its rows, with `job_id` and `step_id` going null.
 * It holds no personal data -- a model name, a token count and a cost -- and law 2's
 * whole argument is that generation spend is accounted for. An account deletion that
 * quietly erased the bill would make the ledger unable to answer the one question it
 * exists for.
 *
 * Summaries are scoped to non-public ones. An author cannot publish to the world
 * (20260830203352), so today every author-owned summary is private and this deletes
 * all of them. The predicate is there for the day that stops being true: a summary
 * someone published to a shared library is community content, and withdrawing it is a
 * different decision from closing an account -- one that needs its own confirmation
 * rather than being smuggled into this one.
 */
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  age int;
begin
  if uid is null then
    raise exception 'delete_my_account requires an authenticated user'
      using errcode = '28000';
  end if;

  age := public.session_age_seconds();
  if age is null or age > 600 then
    raise exception
      'Deleting an account needs a recent sign-in. Request a new code, enter it, '
      'and try again.'
      using errcode = '28000';
  end if;

  -- Submitted material first, while the rows can still be found by their owner.
  delete from public.generation_jobs g where g.requester_id = uid;
  delete from public.summaries s where s.author_id = uid and s.visibility <> 'public';

  -- Then the account. Everything else keyed to it cascades from here.
  delete from auth.users u where u.id = uid;
end;
$$;

revoke all on function public.delete_my_account() from anon, authenticated, public;
grant execute on function public.delete_my_account() to authenticated;

comment on function public.delete_my_account() is
  'Self-serve account deletion. Requires a sign-in within the last 10 minutes, and '
  'removes submitted generation material explicitly because those foreign keys are '
  'ON DELETE SET NULL rather than CASCADE. See 20260901140000.';
