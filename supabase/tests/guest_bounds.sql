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
  reader       uuid := extensions.gen_random_uuid();
  some_work    uuid;
  refused      boolean;
  touched      int;
  seen         int;
  queued       jsonb;
  guest_left   int;
  reader_left  int;
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
  values (guest, '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', null, '',
          now() - interval '90 days', now(),
          '{"provider":"anonymous","providers":["anonymous"]}'::jsonb, '{}'::jsonb, true);

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

  insert into public.summaries (work_id, author_id, title, status, visibility)
  values (some_work, reader, 'A reader summary', 'draft', 'private');

  insert into public.reports (reporter_id, target_type, target_id, reason)
  values (reader, 'summary', some_work, 'spam');

  -- ------------------------------------------------------ 3. the sweep
  --
  -- Back to the owner role: the sweep runs from pg_cron with no JWT at all, which is
  -- why it reads `auth.users.is_anonymous` rather than the claim. Both accounts were
  -- created 90 days ago; only one of them is a guest.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  perform public.sweep_guest_accounts(interval '30 days');

  select count(*) into guest_left  from auth.users u where u.id = guest;
  select count(*) into reader_left from auth.users u where u.id = reader;

  if guest_left <> 0 then
    raise exception
      'the sweep left a 90-day-old guest account behind. Guest rows only ever '
      'accumulate, and storage running out on the free tier is an outage.';
  end if;
  if reader_left <> 1 then
    raise exception
      'the sweep deleted a reader who signed in with an address. It must key on '
      'is_anonymous and nothing else.';
  end if;
end $$;

rollback;

\echo 'guest bounds: ok'
