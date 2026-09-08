-- -----------------------------------------------------------------------------
-- Package 5a: A path has an end.
--
-- Tables:
--   paths          -- curated sequences of ideas that answer one question
--   path_steps     -- the ordered steps (read, predict, compare, say_it_back, apply)
--   path_progress  -- per-reader start / pause / completion state
--   path_step_done -- per-reader step completion, including test-outs
--
-- RPCs:
--   get_paths()
--   get_path(p_slug)
--   advance_path(p_path_id, p_ordinal)
--   pause_path(p_path_id) / resume_path(p_path_id)
--   test_out(p_path_id)
--   apply_path_step(p_path_id, p_ordinal, p_reflection, p_mutation_id)
-- -----------------------------------------------------------------------------

create table public.paths (
  id          uuid                  primary key default extensions.gen_random_uuid(),
  slug        extensions.citext     not null unique,
  title       text                  not null,
  question    text                  not null,
  description text                  not null,
  topic_id    uuid                  references public.topics (id) on delete set null,
  status      public.publish_status not null default 'draft',
  created_at  timestamptz           not null default now(),
  updated_at  timestamptz           not null default now(),
  constraint paths_title_nonempty check (length(trim(title)) > 0),
  constraint paths_question_nonempty check (length(trim(question)) > 0),
  constraint paths_description_nonempty check (length(trim(description)) > 0)
);

comment on table public.paths is
  'Curated learning paths that answer one overarching question with an end.';

create index paths_topic_idx on public.paths (topic_id);

create trigger paths_updated_at
  before update on public.paths
  for each row execute function public.set_updated_at();

alter table public.paths enable row level security;

create policy paths_read_published on public.paths
  for select using (status = 'published');

revoke all on public.paths from public;
grant select on public.paths to anon, authenticated;

-- ------------------------------------------------------------------ path_steps

create table public.path_steps (
  path_id         uuid        not null references public.paths (id) on delete cascade,
  ordinal         smallint    not null,
  pull_id         uuid        not null references public.pulls (id) on delete cascade,
  kind            text        not null check (kind in ('read', 'predict', 'compare', 'say_it_back', 'apply')),
  prompt          text,
  compare_pull_id uuid        references public.pulls (id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (path_id, ordinal)
);

comment on table public.path_steps is
  'Ordered sequence of activities comprising a path.';

-- Supporting non-partial indexes for foreign keys (lint check 3)
create index path_steps_pull_idx         on public.path_steps (pull_id);
create index path_steps_compare_pull_idx on public.path_steps (compare_pull_id);

alter table public.path_steps enable row level security;

-- Steps are readable when the path is published AND the pull is readable via summary
create policy path_steps_read on public.path_steps
  for select using (
    exists (
      select 1 from public.paths p
      where p.id = path_steps.path_id and p.status = 'published'
    )
    and exists (
      select 1 from public.pulls pu
      join public.summaries s on s.id = pu.summary_id
      where pu.id = path_steps.pull_id and public.summary_is_readable(s)
    )
  );

revoke all on public.path_steps from public;
grant select on public.path_steps to anon, authenticated;

-- --------------------------------------------------------------- path_progress

create table public.path_progress (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  path_id      uuid        not null references public.paths (id) on delete cascade,
  started_at   timestamptz not null default now(),
  paused_at    timestamptz,
  completed_at timestamptz,
  primary key (user_id, path_id)
);

comment on table public.path_progress is
  'Reader-specific path progress tracking.';

create index path_progress_path_idx on public.path_progress (path_id);

alter table public.path_progress enable row level security;

create policy path_progress_read_own on public.path_progress
  for select using ((select auth.uid()) = user_id);
create policy path_progress_insert_own on public.path_progress
  for insert with check ((select auth.uid()) = user_id);
create policy path_progress_update_own on public.path_progress
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy path_progress_delete_own on public.path_progress
  for delete using ((select auth.uid()) = user_id);

revoke all on public.path_progress from public;
grant select, insert, update, delete on public.path_progress to authenticated;

-- -------------------------------------------------------------- path_step_done

create table public.path_step_done (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  path_id    uuid        not null,
  ordinal    smallint    not null,
  tested_out boolean     not null default false,
  done_at    timestamptz not null default now(),
  primary key (user_id, path_id, ordinal),
  constraint path_step_done_step_fk
    foreign key (path_id, ordinal)
    references public.path_steps (path_id, ordinal)
    on delete cascade
);

comment on table public.path_step_done is
  'Individual steps completed or tested out by a reader.';

create index path_step_done_step_idx on public.path_step_done (path_id, ordinal);

alter table public.path_step_done enable row level security;

create policy path_step_done_read_own on public.path_step_done
  for select using ((select auth.uid()) = user_id);
create policy path_step_done_insert_own on public.path_step_done
  for insert with check ((select auth.uid()) = user_id);
create policy path_step_done_delete_own on public.path_step_done
  for delete using ((select auth.uid()) = user_id);

revoke all on public.path_step_done from public;
grant select, insert, delete on public.path_step_done to authenticated;

-- ------------------------------------------------------------ notes extension

alter table public.notes
  add column if not exists client_mutation_id uuid;

create unique index if not exists notes_client_mutation_key
  on public.notes (user_id, client_mutation_id)
  where client_mutation_id is not null;

-- ------------------------------------------------------------------- get_paths

create or replace function public.get_paths()
returns jsonb
language sql
stable
set search_path = 'public', 'pg_temp'
as $$
  with caller_progress as (
    select
      pp.path_id,
      pp.started_at,
      pp.paused_at,
      pp.completed_at,
      coalesce(count(psd.ordinal), 0)::int as completed_steps
    from public.path_progress pp
    left join public.path_step_done psd
      on psd.user_id = pp.user_id and psd.path_id = pp.path_id
    where pp.user_id = (select auth.uid())
    group by pp.path_id, pp.started_at, pp.paused_at, pp.completed_at
  ),
  path_counts as (
    select
      path_id,
      count(*)::int as total_steps
    from public.path_steps
    group by path_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'slug', p.slug,
        'title', p.title,
        'question', p.question,
        'description', p.description,
        'topicSlug', t.slug,
        'stepCount', coalesce(pc.total_steps, 0),
        'startedAt', cp.started_at,
        'pausedAt', cp.paused_at,
        'completedAt', cp.completed_at,
        'completedSteps', coalesce(cp.completed_steps, 0)
      ) order by p.created_at asc
    ),
    '[]'::jsonb
  )
  from public.paths p
  left join public.topics t on t.id = p.topic_id
  left join path_counts pc on pc.path_id = p.id
  left join caller_progress cp on cp.path_id = p.id
  where p.status = 'published';
$$;

revoke all on function public.get_paths() from public;
grant execute on function public.get_paths() to anon, authenticated;

-- -------------------------------------------------------------------- get_path

create or replace function public.get_path(p_slug extensions.citext)
returns jsonb
language plpgsql
stable
set search_path = 'public', 'pg_temp'
as $$
declare
  v_path_id uuid;
  v_res jsonb;
begin
  select id into v_path_id
  from public.paths
  where slug = p_slug and status = 'published';

  if v_path_id is null then
    return null;
  end if;

  with caller_progress as (
    select
      user_id,
      started_at,
      paused_at,
      completed_at
    from public.path_progress
    where path_id = v_path_id and user_id = (select auth.uid())
  ),
  caller_done as (
    select
      ordinal,
      tested_out,
      done_at
    from public.path_step_done
    where path_id = v_path_id and user_id = (select auth.uid())
  ),
  step_data as (
    select
      ps.ordinal,
      ps.kind,
      ps.prompt,
      ps.compare_pull_id,
      (cd.ordinal is not null) as is_done,
      coalesce(cd.tested_out, false) as tested_out,
      cd.done_at,
      jsonb_build_object(
        'id', pu.id,
        'headline', pu.headline,
        'body', pu.body,
        'whyItMatters', pu.why_it_matters,
        'example', pu.example,
        'explanation', pu.explanation,
        'work', jsonb_build_object(
          'id', w.id,
          'title', w.title,
          'slug', w.slug
        )
      ) as pull,
      case
        when ps.compare_pull_id is not null and cpu.id is not null then
          jsonb_build_object(
            'id', cpu.id,
            'headline', cpu.headline,
            'body', cpu.body,
            'whyItMatters', cpu.why_it_matters,
            'example', cpu.example,
            'explanation', cpu.explanation,
            'work', jsonb_build_object(
              'id', cw.id,
              'title', cw.title,
              'slug', cw.slug
            )
          )
        else null
      end as compare_pull
    from public.path_steps ps
    join public.pulls pu on pu.id = ps.pull_id
    join public.summaries s on s.id = pu.summary_id and public.summary_is_readable(s)
    join public.works w on w.id = s.work_id
    left join public.pulls cpu on cpu.id = ps.compare_pull_id
    left join public.summaries cs on cs.id = cpu.summary_id and public.summary_is_readable(cs)
    left join public.works cw on cw.id = cs.work_id
    left join caller_done cd on cd.ordinal = ps.ordinal
    where ps.path_id = v_path_id
    order by ps.ordinal asc
  )
  select jsonb_build_object(
    'id', p.id,
    'slug', p.slug,
    'title', p.title,
    'question', p.question,
    'description', p.description,
    'topicSlug', t.slug,
    'startedAt', cp.started_at,
    'pausedAt', cp.paused_at,
    'completedAt', cp.completed_at,
    'steps', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'ordinal', sd.ordinal,
            'kind', sd.kind,
            'prompt', sd.prompt,
            'comparePullId', sd.compare_pull_id,
            'done', sd.is_done,
            'testedOut', sd.tested_out,
            'doneAt', sd.done_at,
            'pull', sd.pull,
            'comparePull', sd.compare_pull
          ) order by sd.ordinal asc
        )
        from step_data sd
      ),
      '[]'::jsonb
    )
  ) into v_res
  from public.paths p
  left join public.topics t on t.id = p.topic_id
  left join caller_progress cp on true
  where p.id = v_path_id;

  return v_res;
end;
$$;

revoke all on function public.get_path(extensions.citext) from public;
grant execute on function public.get_path(extensions.citext) to anon, authenticated;

-- ---------------------------------------------------------------- advance_path

create or replace function public.advance_path(
  p_path_id uuid,
  p_ordinal smallint
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  uid uuid := (select auth.uid());
  v_max_ordinal smallint;
  v_remaining int;
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (select 1 from public.paths where id = p_path_id and status = 'published') then
    raise exception 'Path not found' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.path_steps where path_id = p_path_id and ordinal = p_ordinal) then
    raise exception 'Step not found' using errcode = 'P0002';
  end if;

  -- Ensure path_progress exists
  insert into public.path_progress (user_id, path_id, started_at)
  values (uid, p_path_id, now())
  on conflict (user_id, path_id) do nothing;

  -- Record step done
  insert into public.path_step_done (user_id, path_id, ordinal)
  values (uid, p_path_id, p_ordinal)
  on conflict (user_id, path_id, ordinal) do nothing;

  -- Check if all steps in this path are completed
  select max(ordinal) into v_max_ordinal
  from public.path_steps
  where path_id = p_path_id;

  select count(*) into v_remaining
  from public.path_steps ps
  where ps.path_id = p_path_id
    and not exists (
      select 1 from public.path_step_done psd
      where psd.user_id = uid and psd.path_id = p_path_id and psd.ordinal = ps.ordinal
    );

  if v_remaining = 0 then
    update public.path_progress
       set completed_at = coalesce(completed_at, now())
     where user_id = uid and path_id = p_path_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'completed', (v_remaining = 0)
  );
end;
$$;

revoke all on function public.advance_path(uuid, smallint) from public, anon;
grant execute on function public.advance_path(uuid, smallint) to authenticated;

-- ---------------------------------------------------- pause_path / resume_path

create or replace function public.pause_path(p_path_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  insert into public.path_progress (user_id, path_id, started_at, paused_at)
  values (uid, p_path_id, now(), now())
  on conflict (user_id, path_id)
  do update set paused_at = now();

  return jsonb_build_object('ok', true, 'paused', true);
end;
$$;

revoke all on function public.pause_path(uuid) from public, anon;
grant execute on function public.pause_path(uuid) to authenticated;

create or replace function public.resume_path(p_path_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  update public.path_progress
     set paused_at = null
   where user_id = uid and path_id = p_path_id;

  return jsonb_build_object('ok', true, 'paused', false);
end;
$$;

revoke all on function public.resume_path(uuid) from public, anon;
grant execute on function public.resume_path(uuid) to authenticated;

-- -------------------------------------------------------------------- test_out

create or replace function public.test_out(p_path_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  uid uuid := (select auth.uid());
  v_floor double precision := public.known_retrievability_floor();
  v_ordinals smallint[];
  v_remaining int;
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (select 1 from public.paths where id = p_path_id and status = 'published') then
    raise exception 'Path not found' using errcode = 'P0002';
  end if;

  -- Ensure path_progress exists
  insert into public.path_progress (user_id, path_id, started_at)
  values (uid, p_path_id, now())
  on conflict (user_id, path_id) do nothing;

  -- Find steps whose pulls the reader already holds with high retrievability
  with eligible as (
    select ps.ordinal
    from public.path_steps ps
    join public.knowledge_states ks
      on ks.user_id = uid and ks.pull_id = ps.pull_id
    where ps.path_id = p_path_id
      and public.retrievability(ks.stability, ks.last_seen_at) >= v_floor
  ),
  inserted as (
    insert into public.path_step_done (user_id, path_id, ordinal, tested_out)
    select uid, p_path_id, e.ordinal, true
    from eligible e
    on conflict (user_id, path_id, ordinal) do update
      set tested_out = true
    returning ordinal
  )
  select coalesce(array_agg(ordinal order by ordinal), '{}'::smallint[])
  into v_ordinals
  from inserted;

  -- Check if all steps in this path are completed
  select count(*) into v_remaining
  from public.path_steps ps
  where ps.path_id = p_path_id
    and not exists (
      select 1 from public.path_step_done psd
      where psd.user_id = uid and psd.path_id = p_path_id and psd.ordinal = ps.ordinal
    );

  if v_remaining = 0 then
    update public.path_progress
       set completed_at = coalesce(completed_at, now())
     where user_id = uid and path_id = p_path_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'testedOutOrdinals', to_jsonb(v_ordinals),
    'completed', (v_remaining = 0)
  );
end;
$$;

revoke all on function public.test_out(uuid) from public, anon;
grant execute on function public.test_out(uuid) to authenticated;

-- ------------------------------------------------------------- apply_path_step

create or replace function public.apply_path_step(
  p_path_id     uuid,
  p_ordinal     smallint,
  p_reflection  text,
  p_mutation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  uid         uuid := (select auth.uid());
  v_pull_id   uuid;
  v_note_id   uuid;
  v_step_kind text;
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select pull_id, kind into v_pull_id, v_step_kind
  from public.path_steps
  where path_id = p_path_id and ordinal = p_ordinal;

  if v_pull_id is null then
    raise exception 'Step not found' using errcode = 'P0002';
  end if;

  -- Insert reflection note with replay idempotency
  insert into public.notes
    (user_id, pull_id, body, visibility, client_mutation_id)
  values
    (uid, v_pull_id, p_reflection, 'private', p_mutation_id)
  on conflict (user_id, client_mutation_id) where client_mutation_id is not null
    do nothing
  returning id into v_note_id;

  -- Only adjust next_due_at if this is the first application of this mutation
  if v_note_id is not null or p_mutation_id is null then
    -- Resurface pull within 3 days
    update public.knowledge_states
       set next_due_at = least(next_due_at, now() + interval '3 days')
     where user_id = uid and pull_id = v_pull_id;
  end if;

  -- Advance the path
  perform public.advance_path(p_path_id, p_ordinal);

  return jsonb_build_object(
    'ok', true,
    'noteId', v_note_id
  );
end;
$$;

revoke all on function public.apply_path_step(uuid, smallint, text, uuid) from public, anon;
grant execute on function public.apply_path_step(uuid, smallint, text, uuid) to authenticated;
