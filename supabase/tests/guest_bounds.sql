-- What a guest session may and may not do, exercised as a guest.
--
-- Anonymous sign-in changes the meaning of `to authenticated` across the whole schema:
-- a guest holds the same role as a reader who typed a code from their inbox, and
-- `auth.uid()` returns a real uuid for them. Everything keyed to a user therefore works
-- for a guest with no special case, which is the point -- and two doors that were safe
-- while every account cost a mailbox stop being safe when accounts are free.
--
-- The assertions are in both directions on purpose, because a bound that also blocks
-- legitimate use is a worse bug than the one it fixes, and because half of these could
-- pass for the wrong reason:
--
--   * a guest can finish onboarding and read their own preferences -- if this breaks,
--     the guest button leads to a dead end and the feature is pointless
--   * a guest cannot enqueue generation, author a summary, or file a report
--   * a reader with an address can still do all three -- so the refusals above are
--     about being a guest and not about something else that broke
--   * the bounds that apply to everyone are still in force: the free allowance is
--     immediate, the delay past it grows, and the daily ceiling refuses. `create or
--     replace` on a fixed signature makes those easy to revert by accident, and every
--     other assertion here would still pass if they were gone
--   * the sweep deletes a stale guest and leaves the reader alone
--
-- Run as the roles that actually reach these paths (`authenticated`, with and without
-- the `is_anonymous` claim), because RLS is invisible to an owner-role query and this
-- file would otherwise be proving nothing.
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_is_reader() returns void
language plpgsql as $fn$
begin
  if current_user <> 'authenticated' then
    raise exception
      'these assertions must run as authenticated, not as %. RLS is invisible to an '
      'owner-role query.', current_user;
  end if;
end $fn$;

do $$
declare
  guest        uuid := extensions.gen_random_uuid();
  regular      uuid := extensions.gen_random_uuid();
  reader       uuid := extensions.gen_random_uuid();
  some_work    uuid;
  refused      boolean;
  touched      int;
  seen         int;
  queued       jsonb;
  delayed      jsonb;
  first_delay  int;
  i            int;
  guest_left   int;
  reader_left  int;
  regular_left int;
begin
  -- Both accounts are created through the real trigger rather than by inserting into
  -- `profiles` directly: `handle_new_user` is what gives a guest the preference row the
  -- onboarding gate reads, and a test that wrote that row itself would not notice if
  -- signup stopped creating it for an address-less user.
  --
  -- A guest is `is_anonymous` with a null email, which is exactly what GoTrue writes.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data, is_anonymous)
  -- Every timestamp aged, and no `auth.sessions` row: this guest opened the app once,
  -- three months ago, and never came back. That is what the sweep is for.
  values (guest, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', null, '',
          now() - interval '90 days', now() - interval '90 days',
          '{"provider":"anonymous","providers":["anonymous"]}'::jsonb, '{}'::jsonb, true);

  -- A second guest, exactly as old, who is still here: signed in 90 days ago and
  -- refreshed their token two hours ago. Somebody who found the product, kept the tab,
  -- and comes back to it.
  --
  -- This fixture is what makes the sweep assertion mean anything. Without it the sweep
  -- passes whether it keys on creation or on disuse — and keying on creation deletes
  -- this reader's stashes and knowledge states out from under a live session, with no
  -- address to recover through. `last_sign_in_at` deliberately stays null: GoTrue sets
  -- it once and does not bump it on refresh, so a sweep that trusted it would delete
  -- this row too.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (regular, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', null, '',
          now() - interval '90 days', now() - interval '90 days',
          '{"provider":"anonymous","providers":["anonymous"]}'::jsonb, '{}'::jsonb, true);

  -- `refreshed_at` is `timestamp` without a time zone while its neighbours have one, so
  -- it is written as UTC to match what GoTrue stores and what the sweep reads.
  insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at)
  values (extensions.gen_random_uuid(), regular,
          now() - interval '90 days', now(),
          (now() at time zone 'utc') - interval '2 hours');

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (reader, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated',
          'guest-bounds' || left(reader::text, 8) || '@example.test', '',
          now(), now() - interval '90 days', now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false);

  -- Any work from the seeded corpus. A summary needs one, and which one is irrelevant.
  select w.id into some_work from public.works w limit 1;
  if some_work is null then
    raise exception
      'no works in the corpus, so the authorship assertions below would pass without '
      'testing anything. The seed lives in the migrations -- replay them first.';
  end if;

  -- ------------------------------------------------------------ 1. as a guest
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', guest, 'role', 'authenticated', 'is_anonymous', true)::text,
    true);
  perform pg_temp.assert_is_reader();

  if not public.is_guest() then
    raise exception
      'is_guest() is false for a session carrying is_anonymous. Every bound below rests '
      'on this claim being read, so nothing else in this file would mean anything.';
  end if;

  -- The whole point of the button: onboarding has to complete. `handle_new_user` made
  -- the row; the picker reads it and then stamps `onboarded_at`.
  select count(*) into seen from public.preference_profiles p where p.user_id = guest;
  if seen <> 1 then
    raise exception
      'a guest can see % of their own preference rows; signup must create exactly one '
      'or OnboardingGate has nothing to read.', seen;
  end if;

  update public.preference_profiles p
     set onboarded_at = now()
   where p.user_id = guest;
  get diagnostics touched = row_count;
  if touched <> 1 then
    raise exception
      'a guest could not finish onboarding (% rows updated). The guest session would '
      'land on the picker and stay there.', touched;
  end if;

  -- Generation is the expensive door (law 2). Refused, not delayed: a guest session is
  -- free to recreate, so a per-requester quota bounds nothing.
  refused := false;
  begin
    perform public.enqueue_generation_job('{"kind":"work","title":"Anything"}'::jsonb);
  exception when invalid_authorization_specification then
    refused := true;
  end;
  if not refused then
    raise exception
      'a guest enqueued a generation job. One canonical generation costs real money and '
      'an anonymous session costs nothing -- see 20260901190000.';
  end if;

  refused := false;
  begin
    insert into public.summaries (work_id, author_id, title, status, visibility)
    values (some_work, guest, 'A guest summary', 'draft', 'private');
    raise exception 'a guest authored a summary; summaries_author_insert must refuse them.';
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a guest authored a summary.';
  end if;

  refused := false;
  begin
    insert into public.reports (reporter_id, target_type, target_id, reason)
    values (guest, 'summary', some_work, 'spam');
    raise exception 'a guest filed a report; the moderation queue is read by a human.';
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception 'a guest filed a report.';
  end if;

  -- --------------------------------------- 2. as a reader with an address
  --
  -- Same role, same policies, no `is_anonymous`. If any of these fail, the clauses
  -- above are not about being a guest -- they are about something that broke.
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);
  perform pg_temp.assert_is_reader();

  if public.is_guest() then
    raise exception
      'is_guest() is true for a session with no is_anonymous claim. Every token minted '
      'before anonymous sign-ins existed lacks the claim, so this would lock out every '
      'signed-in reader holding one.';
  end if;

  queued := public.enqueue_generation_job('{"kind":"work","title":"Anything"}'::jsonb);
  if queued ->> 'jobId' is null then
    raise exception 'a signed-in reader could not enqueue generation (got %).', queued;
  end if;

  -- ------------------------------------- 3. the bounds that apply to everyone
  --
  -- Asserted here because their absence is invisible. `enqueue_generation_job` is
  -- replaced by `create or replace` on a fixed signature, so a migration that rebases on
  -- the wrong predecessor silently drops whatever the newest one added and every other
  -- assertion in this file still passes. That is not hypothetical: the first draft of
  -- 20260901190000 rebased on 20260829170701 instead of 20260829171514 and reverted the
  -- hard ceiling and the stagger -- leaving any account with a mailbox able to enqueue
  -- unbounded paid generation, under a migration whose subject is bounding spend.
  --
  -- So the shape of the bound is asserted, not just that the door opens. Job 2 is inside
  -- the free allowance and must be immediate; job 5 is past it and must be delayed by
  -- more than job 4 was, which is what makes the delay a throughput limit rather than a
  -- constant; and the ceiling must refuse.
  queued := public.enqueue_generation_job('{"kind":"work","title":"Second"}'::jsonb);
  if (queued ->> 'delaySeconds')::int <> 0 then
    raise exception
      'the second job of the day was delayed by %s; the first three are the free '
      'allowance.', queued ->> 'delaySeconds';
  end if;
  if (queued ->> 'remainingToday') is null then
    raise exception
      'enqueue no longer reports remainingToday, which means the daily ceiling it '
      'counts against is gone. See 20260829171514.';
  end if;

  -- Up to the ceiling. Jobs 3..50 -- two are already in from the calls above.
  for i in 3..50 loop
    delayed := public.enqueue_generation_job('{"kind":"work","title":"Filler"}'::jsonb);
    if i = 4 then
      first_delay := (delayed ->> 'delaySeconds')::int;
    elsif i = 5 then
      if (delayed ->> 'delaySeconds')::int <= first_delay then
        raise exception
          'job 5 was delayed %s and job 4 was delayed %s. A fixed delay is not a '
          'throughput bound -- it moves spend in time rather than capping it.',
          delayed ->> 'delaySeconds', first_delay;
      end if;
    end if;
  end loop;

  refused := false;
  begin
    perform public.enqueue_generation_job('{"kind":"work","title":"One too many"}'::jsonb);
  exception when check_violation then
    refused := true;
  end;
  if not refused then
    raise exception
      'the 51st job of the day was accepted; the hard ceiling is gone.';
  end if;

  insert into public.summaries (work_id, author_id, title, status, visibility)
  values (some_work, reader, 'A reader summary', 'draft', 'private');

  insert into public.reports (reporter_id, target_type, target_id, reason)
  values (reader, 'summary', some_work, 'spam');

  -- ------------------------------------------------------ 4. the sweep
  --
  -- Back to the owner role: the sweep runs from pg_cron with no JWT at all, which is
  -- why it reads `auth.users.is_anonymous` rather than the claim. Both accounts were
  -- created 90 days ago; only one of them is a guest.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  perform public.sweep_guest_accounts(interval '30 days');

  select count(*) into guest_left   from auth.users u where u.id = guest;
  select count(*) into reader_left  from auth.users u where u.id = reader;
  select count(*) into regular_left from auth.users u where u.id = regular;

  if guest_left <> 0 then
    raise exception
      'the sweep left a 90-day-old guest account behind. Guest rows only ever '
      'accumulate, and storage running out on the free tier is an outage.';
  end if;
  if reader_left <> 1 then
    raise exception
      'the sweep deleted a reader who signed in with an address. A guest is an account '
      'with no address, no phone and no linked identity -- not merely a flag.';
  end if;
  if regular_left <> 1 then
    raise exception
      'the sweep deleted a guest who refreshed their session two hours ago. It is keyed '
      'on disuse, not on age: docs/privacy.md promises "has not been used for 30 days", '
      'and deleting somebody mid-session takes their stashes and knowledge states with '
      'it, with no address to recover through.';
  end if;
end $$;

rollback;

\echo 'guest bounds: ok'
