-- A reader can say something is wrong without leaving the app.
--
-- There was no channel at all. `docs/terms.md` and `docs/privacy.md` publish a mailbox,
-- and `SECURITY.md` points at GitHub — all of which ask a reader to stop reading, open
-- another application, and compose a message to a stranger. The realistic outcome of
-- that is silence, which is indistinguishable from nothing being wrong.
--
-- WHAT THIS IS NOT. It is not email. A row lands here and the operator reads it; nothing
-- is relayed anywhere, and no provider key exists in this project to relay it with. That
-- is a deliberate first step rather than an oversight: the row is exactly what a relay
-- would send later, so adding one is a new migration and an Edge Function, not a reshape
-- of this table. What a reader experiences is the part that matters and is already true
-- — they type, they press send, and it has arrived.
--
-- SIGNED IN ONLY, including guests. `rights_requests` is described in its own migration
-- as "the only unauthenticated write in the schema, and it was unbounded", and it earns
-- that status because a rights holder must not need an account to file a notice. Feedback
-- has no such claim on it: everyone who can reach this form already has a session, guests
-- included, because a guest is a real `auth.users` row. Keeping it authenticated means
-- the rate limit can be per reader rather than a global ceiling that one script can spend
-- on everybody's behalf — which is the compromise 20260901130000 had to accept and says
-- so plainly.
--
-- WHY AN ENUM RATHER THAN FREE TEXT for the subject. The form asks the reader to choose,
-- so the set is closed by construction, and a closed set in this repository is a Postgres
-- enum mirrored in `@wap/schemas` with `enum-parity.ts` asserting both directions. A text
-- column with a check constraint would have been fewer moving parts and would have let the
-- TypeScript list drift from the database's without anything failing.

create type public.feedback_subject as enum (
  'bug',
  'idea',
  'content',
  'account',
  'other'
);

comment on type public.feedback_subject is
  'What a piece of feedback is about. Mirrored in @wap/schemas as FEEDBACK_SUBJECTS; '
  'enum-parity.ts fails typecheck if the two disagree.';

create table public.feedback (
  id         uuid primary key default extensions.gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  subject    public.feedback_subject not null,
  message    text not null,
  -- Where they were when they sent it. A path, never a full URL: a path cannot carry an
  -- origin, a query string or a fragment, so it cannot smuggle a search term or an
  -- anchored pull id into a table the reader did not expect to hold one.
  path       text,
  status     text not null default 'open',
  -- Idempotency, the same shape `remember_pull` uses. A retry after a lost response
  -- must not file the same complaint twice.
  client_mutation_id uuid,
  created_at timestamptz not null default now(),

  constraint feedback_message_length check (length(message) between 1 and 4000),
  constraint feedback_path_length   check (path is null or length(path) <= 200),
  constraint feedback_status_known  check (status in ('open', 'read', 'closed'))
);

comment on table public.feedback is
  'Reader-submitted feedback, written from the app rather than by email. Signed-in only '
  '(guests included); rate limited per reader by feedback_rate_limit. Nothing relays '
  'these anywhere yet — the operator reads the rows. See 20260915120000.';

-- Every foreign key gets a non-partial index; `lint.sql` check 3 asserts it.
create index feedback_user_idx   on public.feedback (user_id);
-- The operator's read: what is still open, newest first.
create index feedback_status_idx on public.feedback (status, created_at desc);

-- One row per (reader, mutation id), so a retry collides rather than duplicating.
-- Partial, because `client_mutation_id` is nullable and two nulls are not equal —
-- without the predicate this index would permit exactly the duplicates it exists to stop
-- while appearing to forbid them.
create unique index feedback_mutation_idx
  on public.feedback (user_id, client_mutation_id)
  where client_mutation_id is not null;

-- 1. Row level security, in this file rather than a later one. -----------------------
--
-- CLAUDE.md law 5 names the split between `20260829124548_learning.sql` and
-- `20260829124730_rls.sql` as a standing deviation that cannot be retrofitted under law
-- 6, not as the pattern to copy. A new table carries its own policies.

alter table public.feedback enable row level security;

-- A reader sees what they sent and nothing else. There is no screen for this today; the
-- policy exists because the data export walks every table a reader owns, and because a
-- table with RLS on and no select policy is unreadable by its owner too.
create policy feedback_read_own on public.feedback
  for select using ((select auth.uid()) = user_id);

-- Insert only. No update, no delete, and that is a decision rather than an omission:
-- feedback is a message that has been sent, and a sender who can silently rewrite one
-- after it is read makes the record useless to the person reading it. Deletion happens
-- the way everything else keyed to a reader does — `on delete cascade` from
-- `auth.users`, so `delete_my_account` takes these with it.
create policy feedback_insert_own on public.feedback
  for insert with check ((select auth.uid()) = user_id);

-- 2. How much one reader may send. ---------------------------------------------------
--
-- Ten an hour. High enough that nobody reporting a genuinely broken screen hits it, low
-- enough that a stuck retry loop or a bored guest cannot fill a free-tier disk: at the
-- 4000-character cap above, a saturated hour costs about 40 KB per reader.
--
-- `before insert`, so a refused message writes nothing, and SQLSTATE 53400
-- (`configuration_limit_exceeded`) rather than a bare exception, so the client can tell
-- "slow down" apart from "that was invalid" — the same code and the same reasoning as
-- `rights_requests_rate_limit`.
--
-- `security definer` with a pinned `search_path`, and it is load-bearing for the reason
-- 20260901130000 records after getting it wrong: the counting query reads `feedback`, and
-- `feedback_read_own` would narrow that count to the caller's own rows. Here that happens
-- to be what we want to count — but relying on a policy to do a rate limit's arithmetic
-- means the limit silently changes whenever the policy does. The predicate is stated
-- explicitly instead, and the function runs as owner so it is counting rows rather than
-- counting what a policy chose to show it.
create or replace function public.feedback_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent int;
begin
  select count(*) into recent
    from public.feedback f
   where f.user_id = new.user_id
     and f.created_at > now() - interval '1 hour';

  if recent >= 10 then
    raise exception
      'That is a lot of feedback in one hour. Give it a little while, or write to the '
      'address in the Terms if it is urgent.'
      using errcode = '53400';
  end if;

  return new;
end;
$$;

-- Invoked by the trigger, never by a caller, so nothing legitimate loses anything.
-- 20260829124835 revokes execute from the API roles on every definer function here.
revoke all on function public.feedback_rate_limit() from anon, authenticated, public;

create trigger feedback_rate_limit
  before insert on public.feedback
  for each row execute function public.feedback_rate_limit();

-- 3. Grants. -------------------------------------------------------------------------
--
-- `authenticated` inserts and selects; the policies above decide which rows. `anon` gets
-- nothing: a visitor has no session, so `feedback_insert_own` would refuse them anyway,
-- and a grant that only ever resolves to a refusal is reach with no purpose — the same
-- argument 20260915020000 makes about `profiles`.
grant select, insert on public.feedback to authenticated;
