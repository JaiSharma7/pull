-- -----------------------------------------------------------------------------
-- A path step enters the review schedule.
--
-- Supersedes every RPC in 20260908030000_a_path_has_an_end.sql. The tables, their
-- policies and their grants are untouched; only the functions are restated, in full,
-- because migrations are append-only (law 6) and a `create or replace` carries the
-- whole body. Diff each against its predecessor before reviewing it.
--
-- WHAT WAS WRONG, in the order it matters.
--
-- 1. THE APPLY STEP NEVER ENTERED REVIEW. `apply_path_step` ended in a bare
--    `update public.knowledge_states set next_due_at = least(...) where user_id = uid
--    and pull_id = v_pull_id`. Nothing in the path flow ever INSERTED that row, and a
--    path's apply step is a different pull from its earlier steps -- so for a reader
--    who had not already met the idea some other way, which is the normal case, the
--    update matched zero rows and the idea was never scheduled. The completion screen
--    then told them all N ideas had been "integrated into your metacognitive review
--    schedule". None had. `paths.sql` did not see it because its fixture pre-inserted
--    the row the function needed, and its guard was `if due_after > ...`, which a null
--    `due_after` satisfies by not being taken.
--
--    Now `advance_path` upserts a `knowledge_states` row for EVERY step it marks done,
--    with the shape `remember_pull` and `commit_import` already use -- acquired by
--    reading, due tomorrow at the default stability, and `do nothing` for an idea that
--    already has a schedule. `apply_path_step` keeps its `least(next_due_at, now() + 3
--    days)` pull-forward, which now always finds a row to pull. `'read'` is an existing
--    `public.acquisition` member and the column's default, so no enum changes.
--
-- 2. `test_out` REWROTE A STEP THE READER HAD DONE. Its insert was `on conflict ... do
--    update set tested_out = true`, so a step genuinely completed became "skipped" the
--    moment the reader tested out of the path. Done steps are excluded from the eligible
--    set now, and the insert is `do nothing`.
--
-- 3. `get_path` WAS CASE-SENSITIVE. `paths.slug` is `extensions.citext`, and the function
--    pinned `search_path = 'public', 'pg_temp'` -- so `=(citext, citext)` in `extensions`
--    was invisible, the comparison fell through to `=(text, text)`, and `/path/Med-1`
--    returned null. This repository has met the trap twice before; the account is in
--    `20260901160000` and the working form in `20260905110000`:
--    `operator(extensions.=)`. Every function here now pins `search_path = ''` and
--    schema-qualifies, which is the convention the rest of the schema follows and the
--    reason the class of bug cannot recur in these functions.
--
-- 4. TWO CONCURRENT ADVANCES COULD LEAVE A FINISHED PATH UNFINISHED. Each inserted its
--    step and then counted what remained; two requests finishing the last two steps at
--    once each saw one remaining, and neither set `completed_at`. The reader's
--    `path_progress` row is now locked `for update` before the step is written and the
--    count taken, so the second waits for the first and counts a finished path.
--
-- 5. A REPLAYED APPLY WROTE NO NOTE AND STILL ADVANCED. When the mutation id had been
--    used, the note insert did nothing and the function fell through to `advance_path`
--    regardless. A replay now returns the note it already wrote and stops.
--
-- And five more found in the same functions while confirming those:
--
--   * `apply_path_step` selected the step's `kind` and never read it, and did not check
--     the path was published -- so a note could be written against any step of any
--     path, and `advance_path` refused it only after the note had landed. It now refuses
--     a step that is not an apply step, a path that is not published, and a reflection
--     `notes_body_length` would refuse, before writing anything.
--   * `get_path` could make a path uncompletable: its steps inner-joined
--     `summary_is_readable`, so a step whose pull the reader cannot read was dropped
--     from `steps`, while `advance_path` and `test_out` counted `remaining` over ALL
--     `path_steps`. The screen could never reach the missing step and the path never
--     completed. All three now agree on one definition -- the steps whose pull the
--     caller can read -- so an unreadable step is neither shown nor counted.
--
--     That makes completion RELATIVE TO THE CALLER, and the set can grow after the
--     fact (review finding): a step behind a private summary that is published later
--     becomes readable, and a stored `completed_at` beside it would have the screen
--     say "Completed" over a step it never rendered. So the timestamp is derived on
--     read -- `get_path` and `get_paths` withhold it while a readable step is undone
--     -- and recomputed on write, where `advance_path` and `test_out` clear it when
--     anything remains and set it again when nothing does.
--   * `advance_path` selected `v_max_ordinal` and never read it. Removed.
--   * `test_out` used `>=` against `known_retrievability_floor()`; every other caller of
--     that floor uses `>`. Aligned.
--   * Advancing a step did not clear `paused_at`, so the "this path is paused" banner
--     stayed up over a path being actively walked, even though it promised that
--     advancing would resume. Advancing and testing out both clear it now.
--
-- `security definer` is kept where it was, and each definer pins `search_path = ''`.
-- `get_paths` and `get_path` stay `security invoker`, so the row policies decide what a
-- caller sees; the explicit `summary_is_readable` joins inside the definers are what
-- carries the caller's view into functions that RLS does not apply to.
-- -----------------------------------------------------------------------------

-- ------------------------------------------------------------------- get_paths

create or replace function public.get_paths()
returns jsonb
language sql
stable
security invoker
set search_path = ''
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
        -- Completion is relative to what this caller can read, and it is derived
        -- rather than reported: a step that becomes readable after the path was
        -- finished -- a private summary published later -- reopens it. See get_path.
        'completedAt', case
          when exists (
            select 1 from public.path_steps ps
            where ps.path_id = p.id
              and not exists (
                select 1 from public.path_step_done psd
                where psd.user_id = (select auth.uid())
                  and psd.path_id = p.id and psd.ordinal = ps.ordinal
              )
          ) then null
          else cp.completed_at
        end,
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
security invoker
set search_path = ''
as $$
declare
  v_path_id uuid;
  v_res jsonb;
begin
  -- `operator(extensions.=)`, not `=`: with an empty search_path the citext operator
  -- is invisible and a bare `=` silently becomes a case-sensitive text comparison.
  select id into v_path_id
  from public.paths
  where slug operator(extensions.=) p_slug and status = 'published';

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
        when ps.compare_pull_id is not null and cpu.id is not null and cs.id is not null then
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
    -- The steps a caller can READ, which is the same set `advance_path` and `test_out`
    -- count. A step this join drops is not on the screen and is not owed either.
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
    -- DERIVED, NOT REPORTED. `completed_at` is written when the caller has no
    -- readable step left, and that set can grow after the fact: a step behind a
    -- private summary that is later published becomes readable, and `steps` below
    -- then carries an undone step. A stored timestamp beside an undone step would
    -- have the screen show "Completed" over a step it never rendered, so the
    -- timestamp is withheld until every readable step is done again.
    'completedAt', case
      when exists (select 1 from step_data sd where not sd.is_done) then null
      else cp.completed_at
    end,
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
set search_path = ''
as $$
declare
  uid         uuid := (select auth.uid());
  v_pull_id   uuid;
  v_remaining int;
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (select 1 from public.paths where id = p_path_id and status = 'published') then
    raise exception 'Path not found' using errcode = 'P0002';
  end if;

  -- The step must exist AND its pull must be readable by this caller. A definer
  -- function sees every row, so the policy `path_steps_read` applies to the screen is
  -- restated here; without it a reader could mark done a step they were never shown.
  select ps.pull_id into v_pull_id
  from public.path_steps ps
  join public.pulls pu on pu.id = ps.pull_id
  join public.summaries s on s.id = pu.summary_id
  where ps.path_id = p_path_id and ps.ordinal = p_ordinal
    and public.summary_is_readable(s);

  if v_pull_id is null then
    raise exception 'Step not found' using errcode = 'P0002';
  end if;

  insert into public.path_progress (user_id, path_id, started_at)
  values (uid, p_path_id, now())
  on conflict (user_id, path_id) do nothing;

  -- Serialise this reader's advances on this path. Two requests completing the last
  -- two steps at once each inserted their step, each counted one remaining, and
  -- neither wrote `completed_at`. The second now waits here for the first.
  perform 1 from public.path_progress
   where user_id = uid and path_id = p_path_id
   for update;

  insert into public.path_step_done (user_id, path_id, ordinal)
  values (uid, p_path_id, p_ordinal)
  on conflict (user_id, path_id, ordinal) do nothing;

  -- The idea enters the review schedule. Same shape as `remember_pull` and
  -- `commit_import`: due tomorrow at the default stability, and an idea already
  -- scheduled keeps its own schedule -- walking past it again is not evidence about
  -- when it should next be asked.
  insert into public.knowledge_states (user_id, pull_id, acquired_via)
  values (uid, v_pull_id, 'read')
  on conflict (user_id, pull_id) do nothing;

  -- Advancing resumes. The banner says so, and before this it said so while staying up.
  update public.path_progress
     set paused_at = null
   where user_id = uid and path_id = p_path_id and paused_at is not null;

  -- What is left, over the steps this caller can read -- the same set `get_path`
  -- shows, so a step the screen cannot reach is not one the path waits for.
  select count(*) into v_remaining
  from public.path_steps ps
  join public.pulls pu on pu.id = ps.pull_id
  join public.summaries s on s.id = pu.summary_id
  where ps.path_id = p_path_id
    and public.summary_is_readable(s)
    and not exists (
      select 1 from public.path_step_done psd
      where psd.user_id = uid and psd.path_id = p_path_id and psd.ordinal = ps.ordinal
    );

  -- Recomputed, not only set. A path finished while a step was hidden behind a
  -- private summary carries a `completed_at`; if that summary is published later the
  -- reader owes the step again, and the next write here clears the timestamp until
  -- they have done it. `get_path` withholds it on the read side for the same reason.
  update public.path_progress
     set completed_at = case
       when v_remaining = 0 then coalesce(completed_at, now())
       else null
     end
   where user_id = uid and path_id = p_path_id;

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
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (select 1 from public.paths where id = p_path_id and status = 'published') then
    raise exception 'Path not found' using errcode = 'P0002';
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
set search_path = ''
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
set search_path = ''
as $$
declare
  uid         uuid := (select auth.uid());
  v_floor     double precision := public.known_retrievability_floor();
  v_ordinals  smallint[];
  v_remaining int;
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (select 1 from public.paths where id = p_path_id and status = 'published') then
    raise exception 'Path not found' using errcode = 'P0002';
  end if;

  insert into public.path_progress (user_id, path_id, started_at)
  values (uid, p_path_id, now())
  on conflict (user_id, path_id) do nothing;

  -- Same lock as `advance_path`, for the same reason.
  perform 1 from public.path_progress
   where user_id = uid and path_id = p_path_id
   for update;

  -- Steps whose idea the reader already holds above the floor -- strictly above, as
  -- every other reader of `known_retrievability_floor()` has it -- and has NOT already
  -- done. A step the reader completed stays completed; testing out is not a rewrite.
  with eligible as (
    select ps.ordinal
    from public.path_steps ps
    join public.pulls pu on pu.id = ps.pull_id
    join public.summaries s on s.id = pu.summary_id
    join public.knowledge_states ks
      on ks.user_id = uid and ks.pull_id = ps.pull_id
    where ps.path_id = p_path_id
      and public.summary_is_readable(s)
      and public.retrievability(ks.stability, ks.last_seen_at) > v_floor
      and not exists (
        select 1 from public.path_step_done psd
        where psd.user_id = uid and psd.path_id = p_path_id and psd.ordinal = ps.ordinal
      )
  ),
  inserted as (
    insert into public.path_step_done (user_id, path_id, ordinal, tested_out)
    select uid, p_path_id, e.ordinal, true
    from eligible e
    on conflict (user_id, path_id, ordinal) do nothing
    returning ordinal
  )
  select coalesce(array_agg(ordinal order by ordinal), '{}'::smallint[])
  into v_ordinals
  from inserted;

  update public.path_progress
     set paused_at = null
   where user_id = uid and path_id = p_path_id and paused_at is not null;

  select count(*) into v_remaining
  from public.path_steps ps
  join public.pulls pu on pu.id = ps.pull_id
  join public.summaries s on s.id = pu.summary_id
  where ps.path_id = p_path_id
    and public.summary_is_readable(s)
    and not exists (
      select 1 from public.path_step_done psd
      where psd.user_id = uid and psd.path_id = p_path_id and psd.ordinal = ps.ordinal
    );

  -- Same recomputation as `advance_path`, for the same reason.
  update public.path_progress
     set completed_at = case
       when v_remaining = 0 then coalesce(completed_at, now())
       else null
     end
   where user_id = uid and path_id = p_path_id;

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
set search_path = ''
as $$
declare
  uid         uuid := (select auth.uid());
  v_pull_id   uuid;
  v_step_kind text;
  v_note_id   uuid;
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  -- The same bounds `notes_body_length` enforces, checked before anything is written
  -- so the refusal names the field rather than a constraint. Blank is refused too:
  -- the constraint counts characters and a reflection of spaces has some.
  if p_reflection is null or btrim(p_reflection) = '' or length(p_reflection) > 20000 then
    raise exception 'A reflection is between 1 and 20000 characters'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.paths where id = p_path_id and status = 'published') then
    raise exception 'Path not found' using errcode = 'P0002';
  end if;

  select ps.pull_id, ps.kind into v_pull_id, v_step_kind
  from public.path_steps ps
  join public.pulls pu on pu.id = ps.pull_id
  join public.summaries s on s.id = pu.summary_id
  where ps.path_id = p_path_id and ps.ordinal = p_ordinal
    and public.summary_is_readable(s);

  if v_pull_id is null then
    raise exception 'Step not found' using errcode = 'P0002';
  end if;

  if v_step_kind <> 'apply' then
    raise exception 'Not an apply step' using errcode = '22023';
  end if;

  -- A replay returns what it already did and stops. The first version fell through to
  -- `advance_path` here, which marked the step done a second time -- harmless -- and
  -- reported `noteId: null` for a note that existed.
  if p_mutation_id is not null then
    select id into v_note_id
    from public.notes
    where user_id = uid and client_mutation_id = p_mutation_id;

    if v_note_id is not null then
      return jsonb_build_object('ok', true, 'noteId', v_note_id, 'replayed', true);
    end if;
  end if;

  insert into public.notes
    (user_id, pull_id, body, visibility, client_mutation_id)
  values
    (uid, v_pull_id, p_reflection, 'private', p_mutation_id)
  on conflict (user_id, client_mutation_id) where client_mutation_id is not null
    do nothing
  returning id into v_note_id;

  -- The check above and the insert are not one statement, so two requests carrying
  -- the same id can both pass the check; the unique index then lets one of them in.
  -- The other lands here, and answers as the replay it is.
  if v_note_id is null then
    select id into v_note_id
    from public.notes
    where user_id = uid and client_mutation_id = p_mutation_id;

    return jsonb_build_object('ok', true, 'noteId', v_note_id, 'replayed', true);
  end if;

  -- Marks the step done and puts the idea into the schedule if it was not there.
  perform public.advance_path(p_path_id, p_ordinal);

  -- Then resurfaces it within three days. The row exists now: `advance_path` upserted
  -- it, so this always finds something to pull forward.
  update public.knowledge_states
     set next_due_at = least(next_due_at, now() + interval '3 days')
   where user_id = uid and pull_id = v_pull_id;

  return jsonb_build_object(
    'ok', true,
    'noteId', v_note_id,
    'replayed', false
  );
end;
$$;

revoke all on function public.apply_path_step(uuid, smallint, text, uuid) from public, anon;
grant execute on function public.apply_path_step(uuid, smallint, text, uuid) to authenticated;
