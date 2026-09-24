-- A deleted private source must not be recreated by a delayed save retry.
-- This follows the already-pushed initial study source migration.
create table public.study_source_mutations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_mutation_id uuid not null,
  version_id uuid references public.study_source_versions(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (owner_id, client_mutation_id)
);

create index study_source_mutations_version_idx
  on public.study_source_mutations (version_id);

alter table public.study_source_mutations enable row level security;
create policy study_source_mutations_read_own on public.study_source_mutations
  for select to authenticated using (owner_id = (select auth.uid()));

revoke all on public.study_source_mutations from public, anon, authenticated;
grant select on public.study_source_mutations to authenticated;

-- Capture every insert, including an old RPC invocation that began before this
-- migration and reaches the INSERT after the backfill. CREATE TRIGGER waits for
-- in-flight writes to finish before it installs the capture.
create function public.record_study_source_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $trigger$
begin
  insert into public.study_source_mutations
    (owner_id, client_mutation_id, version_id, created_at)
  values (new.owner_id, new.client_mutation_id, new.id, new.created_at)
  on conflict (owner_id, client_mutation_id) do nothing;
  return new;
end
$trigger$;

revoke all on function public.record_study_source_mutation()
  from public, anon, authenticated;

create trigger record_study_source_mutation_after_insert
  after insert on public.study_source_versions
  for each row execute function public.record_study_source_mutation();

-- Preserve replay identities created before this migration without copying source text.
insert into public.study_source_mutations
  (owner_id, client_mutation_id, version_id, created_at)
select owner_id, client_mutation_id, id, created_at
  from public.study_source_versions
on conflict (owner_id, client_mutation_id) do nothing;

create or replace function public.save_study_source_version(
  p_title text,
  p_format text,
  p_text text,
  p_mutation_id uuid,
  p_source_id uuid default null,
  p_origin_label text default null,
  p_extraction_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  uid uuid := auth.uid();
  existing public.study_source_versions%rowtype;
  prior public.study_source_mutations%rowtype;
  parent public.study_sources%rowtype;
  saved public.study_source_versions%rowtype;
  next_no integer;
begin
  if uid is null then
    raise exception 'study import requires a signed-in reader' using errcode = '28000';
  end if;

  -- Serialises same-reader saves, including a lost response retried from another tab.
  perform 1 from auth.users
    where id = uid and is_anonymous is false
    for update;
  if not found then
    raise exception 'study import requires a non-guest reader' using errcode = '28000';
  end if;

  if p_mutation_id is null then
    raise exception 'study import needs a mutation id' using errcode = '22023';
  end if;
  select * into prior from public.study_source_mutations
    where owner_id = uid and client_mutation_id = p_mutation_id;
  if found then
    if prior.version_id is null then
      raise exception 'this study source was deleted; start a new import'
        using errcode = '55000';
    end if;
    select * into existing from public.study_source_versions
      where id = prior.version_id and owner_id = uid;
    if not found then
      raise exception 'the saved study source is unavailable' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'sourceId', existing.source_id,
      'versionId', existing.id,
      'versionNo', existing.version_no,
      'replayed', true
    );
  end if;

  p_title := btrim(p_title);
  p_text := btrim(p_text);
  if p_title is null or char_length(p_title) not between 1 and 200 then
    raise exception 'title must be 1 to 200 characters' using errcode = '22023';
  end if;
  if p_text is null or char_length(p_text) not between 1 and 200000 then
    raise exception 'source text must be 1 to 200000 characters' using errcode = '22023';
  end if;
  if p_format is null or p_format not in
    ('paste', 'text', 'markdown', 'pdf', 'docx', 'image_ocr', 'pdf_ocr', 'highlights') then
    raise exception 'unsupported study source format' using errcode = '22023';
  end if;
  if p_origin_label is not null and char_length(p_origin_label) > 240 then
    raise exception 'origin label is too long' using errcode = '22023';
  end if;
  if p_extraction_notes is not null and char_length(p_extraction_notes) > 2000 then
    raise exception 'extraction notes are too long' using errcode = '22023';
  end if;

  if (select count(*) from public.study_source_mutations where owner_id = uid) >= 1000 then
    raise exception 'this reader has reached the 1000-save study source limit'
      using errcode = '54000';
  end if;

  if (select count(*) from public.study_source_versions where owner_id = uid) >= 100 then
    raise exception 'this reader has reached the 100-version study source limit'
      using errcode = '54000';
  end if;

  if p_source_id is null then
    insert into public.study_sources (owner_id) values (uid) returning * into parent;
  else
    select * into parent from public.study_sources
      where id = p_source_id and owner_id = uid for update;
    if not found then
      raise exception 'study source is unavailable' using errcode = '42501';
    end if;
  end if;

  next_no := parent.latest_version_no + 1;
  insert into public.study_source_versions
    (source_id, owner_id, version_no, client_mutation_id, title, format,
     origin_label, extracted_text, extraction_notes)
  values
    (parent.id, uid, next_no, p_mutation_id, p_title, p_format,
     p_origin_label, p_text, p_extraction_notes)
  returning * into saved;
  -- The AFTER INSERT trigger records the replay identity atomically, including
  -- saves still running under the previous function body.
  update public.study_sources set latest_version_no = next_no where id = parent.id;

  return jsonb_build_object(
    'sourceId', parent.id,
    'versionId', saved.id,
    'versionNo', saved.version_no,
    'replayed', false
  );
end
$fn$;

revoke all on function public.save_study_source_version(
  text, text, text, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.save_study_source_version(
  text, text, text, uuid, uuid, text, text
) to authenticated;