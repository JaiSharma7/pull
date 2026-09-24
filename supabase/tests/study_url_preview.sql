\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.become_reader(p_uid uuid, p_guest boolean default false)
returns void language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated',
                      'is_anonymous', p_guest)::text, true);
  if current_user <> 'authenticated' then
    raise exception 'RLS assertions must run as authenticated';
  end if;
end $fn$;

do $test$
declare
  reader_a uuid := extensions.gen_random_uuid();
  reader_b uuid := extensions.gen_random_uuid();
  guest_id uuid := extensions.gen_random_uuid();
  n integer;
  refused boolean;
begin
  insert into auth.users
    (id, instance_id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at, is_anonymous,
     raw_app_meta_data, raw_user_meta_data)
  values
    (reader_a, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'url-a@example.test', '',
     now(), now(), now(), false, '{}'::jsonb, '{}'::jsonb),
    (reader_b, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'url-b@example.test', '',
     now(), now(), now(), false, '{}'::jsonb, '{}'::jsonb),
    (guest_id, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', null, '',
     now(), now(), now(), true, '{}'::jsonb, '{}'::jsonb);

  perform pg_temp.become_reader(reader_a);
  for n in 1..20 loop
    if public.reserve_study_url_preview() <> n then
      raise exception 'preview quota did not count attempt %', n;
    end if;
  end loop;
  refused := false;
  begin
    perform public.reserve_study_url_preview();
  exception when sqlstate '54000' then refused := true;
  end;
  if not refused then raise exception '21st preview was allowed'; end if;
  select count(*) into n from public.study_url_preview_daily_usage;
  if n <> 1 then raise exception 'unexpected quota rows for reader A'; end if;

  refused := false;
  begin
    insert into public.study_url_preview_daily_usage (owner_id, day_utc, preview_count)
    values (reader_a, current_date + 1, 1);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'reader could write quota directly'; end if;

  perform pg_temp.become_reader(reader_b);
  if exists (select 1 from public.study_url_preview_daily_usage where owner_id = reader_a) then
    raise exception 'another reader can see quota usage';
  end if;
  if public.reserve_study_url_preview() <> 1 then
    raise exception 'another reader did not get an independent quota';
  end if;

  perform pg_temp.become_reader(guest_id, true);
  refused := false;
  begin
    perform public.reserve_study_url_preview();
  exception when sqlstate '28000' then refused := true;
  end;
  if not refused then raise exception 'guest could preview URLs'; end if;
end
$test$;

rollback;
