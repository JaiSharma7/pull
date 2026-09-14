-- A generated summary and the job that asked for it are written together, or not at all.
--
-- `template` adopts a work the requester already owns — an imported book — rather than
-- creating a second `works` row for text the reader already has. Writing the summary and
-- pointing the job at it used to be two calls from an Edge Function with a network in
-- between, and every answer to the retry that produces has been wrong somewhere: "the
-- next free version" wrote a fresh draft per attempt, because the orphan left by the last
-- one is itself what raises the next version; a constant version collided with the FIRST
-- generation's published summary and let `cards` rewrite part of a live document.
--
-- Read-only in effect: everything below rolls back.
\set ON_ERROR_STOP on

begin;

do $$
declare
  reader   uuid;
  other    uuid;
  book     uuid;
  job_one  uuid;
  job_two  uuid;
  first    jsonb;
  again    jsonb;
  second   jsonb;
  refused  boolean := false;
begin
  insert into auth.users (id, instance_id, email, aud, role)
  values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
          'generated-summary-a@example.test', 'authenticated', 'authenticated')
  returning id into reader;
  insert into auth.users (id, instance_id, email, aud, role)
  values (extensions.gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
          'generated-summary-b@example.test', 'authenticated', 'authenticated')
  returning id into other;

  -- An imported book: a work, and the reader's own version 1 hanging their highlights
  -- from it. This is exactly the shape `commit_import` leaves behind.
  insert into public.works (title, slug, kind, rights_status)
  values ('Meditations', 'meditations-' || substr(reader::text, 1, 8), 'book', 'public_domain')
  returning id into book;
  insert into public.summaries
    (work_id, version, status, visibility, author_id, title, published_at)
  values (book, 1, 'published', 'private', reader, 'Meditations', now());

  insert into public.generation_jobs (requester_id, target, status, current_step)
  values (reader, '{"text":"x"}'::jsonb, 'running', 'template') returning id into job_one;
  insert into public.generation_jobs (requester_id, target, status, current_step)
  values (reader, '{"text":"x"}'::jsonb, 'running', 'template') returning id into job_two;

  perform set_config('role', 'service_role', true);

  -- ------------------------------------------------- 1. never the reader's version 1
  first := public.attach_generated_summary(
    job_one, book, 'Generated', 'A pitch', 'Why', '[]'::jsonb, 'private');

  if (first ->> 'created')::boolean is not true then
    raise exception 'the first call did not write a summary: %', first;
  end if;
  if (first ->> 'version')::int < 2 then
    raise exception
      'a generated summary landed at version %. Version 1 is the import''s, and `cards` '
      'would upsert model output over the reader''s own highlights at every shared '
      'ordinal.', first ->> 'version';
  end if;

  -- And the job carries it, which is the half that used to be a second statement.
  if (select gj.summary_id from public.generation_jobs gj where gj.id = job_one)
     <> (first ->> 'summaryId')::uuid then
    raise exception 'the summary was written but the job was not pointed at it';
  end if;
  if (select s.status from public.summaries s where s.id = (first ->> 'summaryId')::uuid)
     <> 'draft' then
    raise exception 'a generated summary was readable before the critic and the rights gate ran';
  end if;

  -- ------------------------------------- 2. the same job twice is the same summary
  --
  -- The retry this exists for: the insert committed, the response was lost, and the step
  -- runs again with `generation_jobs.summary_id` set by the transaction that wrote it.
  again := public.attach_generated_summary(
    job_one, book, 'Generated again', 'Another pitch', 'Why', '[]'::jsonb, 'private');

  if (again ->> 'summaryId') <> (first ->> 'summaryId') then
    raise exception
      'a second call for one job wrote a second summary. Every retry after a lost '
      'response would leave another empty draft on the reader''s own book.';
  end if;
  if (again ->> 'created')::boolean is not false then
    raise exception 'the retry reported itself as a fresh write';
  end if;
  if (select count(*) from public.summaries s
       where s.work_id = book and s.author_id = reader) <> 2 then
    raise exception 'the reader has % summaries on one book after one generation',
      (select count(*) from public.summaries s
        where s.work_id = book and s.author_id = reader);
  end if;

  -- ------------------------------ 3. a second generation is a second summary, not a rewrite
  --
  -- The failure the constant version produced: job two collided with job one's summary,
  -- `cards` upserted its Pulls over some of that summary's ordinals and left the rest,
  -- and the reader watched a live document become a mixture of two.
  second := public.attach_generated_summary(
    job_two, book, 'Generated twice', 'A pitch', 'Why', '[]'::jsonb, 'private');

  if (second ->> 'summaryId') = (first ->> 'summaryId') then
    raise exception
      'a second generation adopted the first one''s summary. Its cards would be written '
      'over a document the reader can already open.';
  end if;
  if (second ->> 'version')::int <= (first ->> 'version')::int then
    raise exception 'the second generation took version % after the first took %',
      second ->> 'version', first ->> 'version';
  end if;

  -- ------------------------------------ 4. and never a work the requester owns nothing on
  update public.generation_jobs set requester_id = other, summary_id = null where id = job_two;
  begin
    perform public.attach_generated_summary(
      job_two, book, 'Theirs', null, null, '[]'::jsonb, 'private');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception
      'a job hung a private generation off a work its requester has authored nothing on. '
      'That is somebody else''s row.';
  end if;

  raise notice 'generated_summary.sql: one summary per job, never version 1, and one per generation';
end $$;

-- --------------------------------------------- 5. and a reader may not call it at all
--
-- It writes a summary as whoever the job names, which is authority no client has. As
-- `authenticated`, because a grant is invisible to the owner.
do $$
declare
  reader  uuid;
  refused boolean := false;
begin
  perform set_config('role', 'postgres', true);
  select u.id into reader from auth.users u
   where u.email like 'generated-summary%' order by u.email limit 1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);

  begin
    perform public.attach_generated_summary(
      extensions.gen_random_uuid(), extensions.gen_random_uuid(),
      'Mine', null, null, '[]'::jsonb, 'public');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then
    raise exception
      'a reader could call attach_generated_summary. It writes a published-path row as '
      'the requester the job names, which is not authority any client has.';
  end if;

  raise notice 'generated_summary.sql: the write is the worker''s alone';
end $$;

rollback;
