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
    raise exception 'RLS assertions must run as authenticated, not %', current_user;
  end if;
end $fn$;

create or replace function pg_temp.as_owner()
returns void language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $fn$;

do $test$
declare
  reader_a uuid := extensions.gen_random_uuid();
  reader_b uuid := extensions.gen_random_uuid();
  guest_id uuid := extensions.gen_random_uuid();
  mutation_1 uuid := extensions.gen_random_uuid();
  mutation_2 uuid := extensions.gen_random_uuid();
  saved jsonb;
  replay jsonb;
  revised jsonb;
  other jsonb;
  saved_source_id uuid;
  cascade_source_id uuid;
  version_id uuid;
  refused boolean;
  n integer;
begin
  insert into auth.users
    (id, instance_id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at, is_anonymous,
     raw_app_meta_data, raw_user_meta_data)
  values
    (reader_a, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'study-a@example.test', '',
     now(), now(), now(), false, '{}'::jsonb, '{}'::jsonb),
    (reader_b, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'study-b@example.test', '',
     now(), now(), now(), false, '{}'::jsonb, '{}'::jsonb),
    (guest_id, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', null, '',
     now(), now(), now(), true, '{}'::jsonb, '{}'::jsonb);

  perform pg_temp.become_reader(reader_a);
  saved := public.save_study_source_version(
    'My reading', 'paste', 'The first immutable text.', mutation_1);
  saved_source_id := (saved ->> 'sourceId')::uuid;
  version_id := (saved ->> 'versionId')::uuid;
  if (saved ->> 'versionNo')::integer <> 1 or (saved ->> 'replayed')::boolean then
    raise exception 'first save did not create version one';
  end if;
  select count(*) into n from public.study_source_versions
    where source_id = saved_source_id;
  if n <> 1 then raise exception 'first save did not land exactly once'; end if;

  replay := public.save_study_source_version(
    'Changed but same mutation', 'paste', 'A different body.', mutation_1);
  if (replay ->> 'versionId')::uuid <> version_id
     or not (replay ->> 'replayed')::boolean then
    raise exception 'lost-response retry did not replay the same version';
  end if;

  revised := public.save_study_source_version(
    'Corrected reading', 'text', 'The corrected immutable text.',
    mutation_2, saved_source_id, 'notes.txt', 'Reader checked extraction');
  if (revised ->> 'versionNo')::integer <> 2 then
    raise exception 'correction did not append version two';
  end if;
  if (select extracted_text from public.study_source_versions where id = version_id)
      <> 'The first immutable text.' then
    raise exception 'correction changed the old text';
  end if;

  -- No direct mutation grants, even for the owner; every write uses the RPC.
  refused := false;
  begin
    update public.study_source_versions set extracted_text = 'rewritten'
      where id = version_id;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'owner could mutate an immutable version'; end if;

  perform pg_temp.become_reader(reader_b);
  if exists (select 1 from public.study_sources where id = saved_source_id)
     or exists (select 1 from public.study_source_versions where id = version_id)
     or exists (select 1 from public.study_source_mutations where owner_id = reader_a) then
    raise exception 'second reader can see private source or version';
  end if;
  refused := false;
  begin
    perform public.save_study_source_version(
      'Stolen correction', 'paste', 'Reader B text',
      extensions.gen_random_uuid(), saved_source_id);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'second reader can revise the first reader source'; end if;
  delete from public.study_sources where id = saved_source_id;
  if found then raise exception 'second reader deleted the first reader source'; end if;

  other := public.save_study_source_version(
    'Same text, my source', 'paste', 'The first immutable text.',
    extensions.gen_random_uuid());
  if (other ->> 'sourceId')::uuid = saved_source_id then
    raise exception 'private material was reused across readers';
  end if;

  perform pg_temp.become_reader(guest_id, true);
  refused := false;
  begin
    perform public.save_study_source_version(
      'Guest', 'paste', 'Guest text', extensions.gen_random_uuid());
  exception when invalid_authorization_specification then refused := true;
  end;
  if not refused then raise exception 'guest could save private source'; end if;

  perform pg_temp.become_reader(reader_a);
  refused := false;
  begin
    perform public.save_study_source_version(
      'Too long', 'paste', repeat('x', 200001), extensions.gen_random_uuid());
  exception when invalid_parameter_value then refused := true;
  end;
  if not refused then raise exception '200001-character source was accepted'; end if;

  delete from public.study_sources where id = saved_source_id;
  if not found then raise exception 'owner could not delete own source'; end if;
  if exists (select 1 from public.study_source_versions where id = version_id) then
    raise exception 'source deletion left a version behind';
  end if;
  refused := false;
  begin
    perform public.save_study_source_version(
      'Lost response retry', 'paste', 'The first immutable text.', mutation_1);
  exception when object_not_in_prerequisite_state then refused := true;
  end;
  if not refused or exists (select 1 from public.study_sources where owner_id = reader_a) then
    raise exception 'a save retry recreated deleted private text';
  end if;
  if not exists (select 1 from public.study_source_mutations
                 where owner_id = reader_a and client_mutation_id = mutation_1
                   and public.study_source_mutations.version_id is null) then
    raise exception 'deletion did not keep a content-free retry marker';
  end if;
  cascade_source_id := (public.save_study_source_version(
    'Account cascade', 'paste', 'Remove on account deletion',
    extensions.gen_random_uuid()) ->> 'sourceId')::uuid;

  -- Content-free retry markers are bounded even when the reader deletes every source.
  perform pg_temp.as_owner();
  insert into public.study_source_mutations (owner_id, client_mutation_id)
  select reader_a, extensions.gen_random_uuid()
    from generate_series(
      1,
      1000 - (select count(*)::integer from public.study_source_mutations where owner_id = reader_a)
    );
  perform pg_temp.become_reader(reader_a);
  refused := false;
  begin
    perform public.save_study_source_version(
      'Over lifetime cap', 'paste', 'A new source', extensions.gen_random_uuid());
  exception when program_limit_exceeded then refused := true;
  end;
  if not refused then raise exception 'deleted-source retries bypassed the lifetime cap'; end if;

  perform pg_temp.as_owner();
  delete from auth.users where id = reader_a;
  if exists (select 1 from public.study_sources where id = cascade_source_id)
     or exists (select 1 from public.study_source_mutations where owner_id = reader_a) then
    raise exception 'account deletion left private source text behind';
  end if;
end $test$;

rollback;