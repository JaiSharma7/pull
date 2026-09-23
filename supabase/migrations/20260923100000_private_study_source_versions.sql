-- Reader-owned study material is stored as text only, after extraction preview.
-- Each correction appends a version. No imported bytes enter public catalogue rows.
create table public.study_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  latest_version_no integer not null default 0 check (latest_version_no >= 0),
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);

create index study_sources_owner_created_idx
  on public.study_sources (owner_id, created_at desc);

create table public.study_source_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  source_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  version_no integer not null check (version_no > 0),
  client_mutation_id uuid not null,
  title text not null check (char_length(title) between 1 and 200),
  format text not null check (format in
    ('paste', 'text', 'markdown', 'pdf', 'docx', 'image_ocr', 'pdf_ocr', 'highlights')),
  origin_label text check (origin_label is null or char_length(origin_label) <= 240),
  extracted_text text not null check (char_length(extracted_text) between 1 and 200000),
  extraction_notes text check
    (extraction_notes is null or char_length(extraction_notes) <= 2000),
  created_at timestamptz not null default now(),
  foreign key (source_id, owner_id)
    references public.study_sources (id, owner_id) on delete cascade,
  unique (source_id, version_no),
  unique (owner_id, client_mutation_id)
);

create index study_source_versions_source_owner_idx
  on public.study_source_versions (source_id, owner_id);
create index study_source_versions_owner_created_idx
  on public.study_source_versions (owner_id, created_at desc);

alter table public.study_sources enable row level security;
create policy study_sources_read_own on public.study_sources
  for select to authenticated using (owner_id = (select auth.uid()));
create policy study_sources_delete_own on public.study_sources
  for delete to authenticated using (owner_id = (select auth.uid()));

alter table public.study_source_versions enable row level security;
create policy study_source_versions_read_own on public.study_source_versions
  for select to authenticated using (owner_id = (select auth.uid()));

revoke all on public.study_sources from public, anon, authenticated;
revoke all on public.study_source_versions from public, anon, authenticated;
grant select on public.study_sources, public.study_source_versions to authenticated;
grant delete on public.study_sources to authenticated;

-- One transaction owns title, text, source lineage and retry identity. A reader never
-- receives direct INSERT/UPDATE/DELETE grants on either table.
create function public.save_study_source_version(
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
  select * into existing from public.study_source_versions
    where owner_id = uid and client_mutation_id = p_mutation_id;
  if found then
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