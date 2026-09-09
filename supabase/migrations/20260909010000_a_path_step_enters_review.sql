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
--     completed. All three now agree on ONE definition -- `readable_path_steps`, the
--     steps whose pull the caller can read -- so an unreadable step is neither shown
--     nor counted. The definer functions call the helper; the invoker functions get the
--     same set from the `path_steps_read` policy, which is written from the same
--     predicate.
--
--     That makes completion RELATIVE TO THE CALLER, and the set can grow after the
--     fact (review finding): a step behind a private summary that is published later
--     becomes readable, and a stored `completed_at` beside it would have the screen
--     say "Completed" over a step it never rendered. So the timestamp is derived on
--     read -- `get_path` and `get_paths` withhold it while a readable step is undone
--     -- and recomputed on write by `settle_path_progress`, which clears it when
--     anything remains and sets it again when nothing does. And "nothing remains" is
--     only completion when there was something to do: a path none of whose steps the
--     caller can read is not one they have finished (review finding).
--   * `advance_path` selected `v_max_ordinal` and never read it. Removed.
--   * `test_out` used `>=` against `known_retrievability_floor()`. The feed, the Delta,
--     the source delta, search and the catalogue all use `>`; `nearest_pulls`
--     (20260908060000) is the one other `>=`, and is the outlier, not the precedent.
--     Aligned with the majority; `nearest_pulls` is a follow-up in its own migration.
--   * Advancing a step did not clear `paused_at`, so the "this path is paused" banner
--     stayed up over a path being actively walked, even though it promised that
--     advancing would resume. Advancing and testing out both clear it now.
--
-- THREE HELPERS, NONE CALLABLE FROM A CLIENT. `readable_path_steps`,
-- `settle_path_progress` and `complete_path_step` exist so that "the steps this caller
-- can read", "is this path finished" and "mark this step done" are each written once:
-- the previous version had the predicate in five places and the count in two, and the
-- first drift between them is defect 6 above. All three are `security definer` with
-- `search_path = ''` (lint invariant 4), all three read the reader from `auth.uid()`
-- rather than a parameter -- so the done rows and the readable set are always the same
-- person's -- and all three are revoked from `anon` and `authenticated`, explicitly,
-- because Supabase's default ACL grants execute to both on creation. They skip the
-- checks the RPCs make, which is only safe when the caller is one of the RPCs below.
--
-- And one asymmetry closed (review finding): `advance_path` refuses an apply step, so
-- the only way to complete one is `apply_path_step` with a reflection. Without that
-- the "not an apply step" guard was one-directional.
-- -----------------------------------------------------------------------------

-- ----------------------------------------------- progress is written by the RPCs

-- 20260908030000 granted `insert, update, delete` on `path_progress` and
-- `insert, delete` on `path_step_done` to `authenticated`, with own-row policies.
-- Every guard in this file lives in the RPCs, and every RPC is `security definer`, so
-- the grants were both unnecessary and a way round the guards: a reader could insert a
-- `path_step_done` row for a step they were never shown, or for the apply step with no
-- reflection, or set `completed_at` by hand, through PostgREST (review finding,
-- demonstrated against the local stack). The RPCs are now the only writers. The
-- select policies stay -- `get_paths` and `get_path` are `security invoker` and read
-- through them.

revoke insert, update, delete on public.path_progress from authenticated;
revoke insert, delete on public.path_step_done from authenticated;

drop policy if exists path_progress_insert_own on public.path_progress;
drop policy if exists path_progress_update_own on public.path_progress;
drop policy if exists path_progress_delete_own on public.path_progress;
drop policy if exists path_step_done_insert_own on public.path_step_done;
drop policy if exists path_step_done_delete_own on public.path_step_done;

-- ---------------------------------------------------------- readable_path_steps

create or replace function public.readable_path_steps(p_path_id uuid)
returns table (ordinal smallint, pull_id uuid, kind text)
language sql
stable
security definer
set search_path = ''
as $$
  -- The same predicate as the `path_steps_read` policy, both halves: the path is
  -- published AND the step's pull is readable. The RPCs check publication first and
  -- raise, but the helper carries it too so that "the steps a reader can read" means
  -- the same thing however it is reached, and a draft path has no readable steps.
  select ps.ordinal, ps.pull_id, ps.kind
  from public.path_steps ps
  join public.paths p on p.id = ps.path_id and p.status = 'published'
  join public.pulls pu on pu.id = ps.pull_id
  join public.summaries s on s.id = pu.summary_id
  where ps.path_id = p_path_id
    and public.summary_is_readable(s);
$$;

comment on function public.readable_path_steps(uuid) is
  'The steps of a published path whose pull the calling reader can read -- the one '
  'definition get_path shows, advance_path and test_out count, and apply_path_step '
  'writes against. Internal: callable only by the path RPCs.';

revoke all on function public.readable_path_steps(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------- complete_path_step

create or replace function public.complete_path_step(
  p_path_id uuid,
  p_ordinal smallint,
  p_pull_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  insert into public.path_progress (user_id, path_id, started_at)
  values (uid, p_path_id, now())
  on conflict (user_id, path_id) do nothing;

  -- Serialise this reader's writes on this path. Two requests completing the last
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
  values (uid, p_pull_id, 'read')
  on conflict (user_id, pull_id) do nothing;

  -- Completing a step resumes. The banner says so, and before this it said so while
  -- staying up.
  update public.path_progress
     set paused_at = null
   where user_id = uid and path_id = p_path_id and paused_at is not null;

  return public.settle_path_progress(p_path_id);
end;
$$;

comment on function public.complete_path_step(uuid, smallint, uuid) is
  'Mark one step done for one reader: start progress, lock it, record the step, put '
  'its idea into the review schedule, resume, and settle completion. The one body '
  'behind advance_path and apply_path_step. Internal: callable only by the path RPCs.';

revoke all on function public.complete_path_step(uuid, smallint, uuid)
  from public, anon, authenticated;

-- --------------------------------------------------------- settle_path_progress

create or replace function public.settle_path_progress(p_path_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The reader is whoever the request is for, read here as `readable_path_steps`
  -- reads it -- not passed in, so the done rows and the readable set can never be
  -- two different people's (review finding).
  uid         uuid := (select auth.uid());
  v_readable  int;
  v_remaining int;
  v_completed boolean;
begin
  select count(*), count(*) filter (where psd.ordinal is null)
    into v_readable, v_remaining
  from public.readable_path_steps(p_path_id) rs
  left join public.path_step_done psd
    on psd.user_id = uid and psd.path_id = p_path_id and psd.ordinal = rs.ordinal;

  -- Finished means every readable step is done AND there was a step to do. Over an
  -- empty readable set `remaining = 0` is vacuously true, and a reader who can see
  -- none of a path's steps has not finished it.
  v_completed := v_readable > 0 and v_remaining = 0;

  -- Recomputed, not only set: a path finished while a step was hidden carries a
  -- timestamp, and if that step becomes readable the reader owes it again. And when
  -- it is finished AGAIN -- the reopened step done -- the timestamp moves to now,
  -- rather than keeping a date earlier than the last step's own (review finding).
  update public.path_progress pp
     set completed_at = case
       when not v_completed then null
       when pp.completed_at is null then now()
       when exists (
         select 1 from public.path_step_done psd
         where psd.user_id = uid and psd.path_id = p_path_id
           and psd.done_at > pp.completed_at
       ) then now()
       else pp.completed_at
     end
   where pp.user_id = uid and pp.path_id = p_path_id;

  return v_completed;
end;
$$;

comment on function public.settle_path_progress(uuid) is
  'Recompute completed_at for the calling reader on one path from the steps they can '
  'read; returns whether it is complete. Internal: callable only by the path RPCs.';

revoke all on function public.settle_path_progress(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------- get_paths

create or replace function public.get_paths()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with caller_progress as (
    select path_id, started_at, paused_at, completed_at
    from public.path_progress
    where user_id = (select auth.uid())
  ),
  -- One pass over the steps this caller can read (`path_steps_read` under invoker
  -- RLS), counting the done ones against that same set -- so `stepCount`,
  -- `completedSteps` and `completedAt` all describe the same steps. Counting every
  -- `path_step_done` row instead let a step that was done and then hidden push the
  -- count past the total and label an unfinished path "Completed".
  path_counts as (
    select ps.path_id,
           count(*)::int as total_steps,
           count(psd.ordinal)::int as completed_steps
    from public.path_steps ps
    left join public.path_step_done psd
      on psd.user_id = (select auth.uid())
     and psd.path_id = ps.path_id
     and psd.ordinal = ps.ordinal
    group by ps.path_id
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
        -- Derived, not reported: withheld while a readable step is undone, and when
        -- there is no readable step at all -- the same two halves as
        -- `settle_path_progress`, so the list never says what the next write would
        -- take back. See get_path.
        'completedAt', case
          when coalesce(pc.total_steps, 0) = 0 then null
          when pc.completed_steps < pc.total_steps then null
          else cp.completed_at
        end,
        'completedSteps', coalesce(pc.completed_steps, 0)
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
    -- The steps a caller can READ -- the same set `readable_path_steps` gives the
    -- definers, here through the row policies. A step this join drops is not on the
    -- screen and is not owed either.
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
    -- timestamp is withheld until every readable step is done again -- and withheld
    -- outright when nothing is readable, which `settle_path_progress` treats as not
    -- finished and would clear on the next write.
    'completedAt', case
      when not exists (select 1 from step_data) then null
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
  v_step_kind text;
begin
  if uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (select 1 from public.paths where id = p_path_id and status = 'published') then
    raise exception 'Path not found' using errcode = 'P0002';
  end if;

  -- The step must exist AND be readable by this caller. A definer function sees every
  -- row, so the set the screen was shown is restated here; without it a reader could
  -- mark done a step they were never shown.
  select rs.pull_id, rs.kind into v_pull_id, v_step_kind
  from public.readable_path_steps(p_path_id) rs
  where rs.ordinal = p_ordinal;

  if v_pull_id is null then
    raise exception 'Step not found' using errcode = 'P0002';
  end if;

  -- An apply step is completed by applying it. This RPC is granted to every reader
  -- and `apply_path_step` refuses a non-apply step, so without this the guard was
  -- one-directional: a direct call here marked the apply step done with no
  -- reflection and no three-day pull-forward, and the completion screen then said
  -- the reader had applied something they had not.
  if v_step_kind = 'apply' then
    raise exception 'An apply step is completed through apply_path_step'
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'ok', true,
    'completed', public.complete_path_step(p_path_id, p_ordinal, v_pull_id)
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
  v_completed boolean;
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
  -- the feed, the Delta and search have it -- and has NOT already done. A step the
  -- reader completed stays completed; testing out is not a rewrite. And never the
  -- apply step: holding the idea is not having applied it, and `apply_path_step` is
  -- the one way that step is completed, with a reflection (review finding).
  with eligible as (
    select rs.ordinal
    from public.readable_path_steps(p_path_id) rs
    join public.knowledge_states ks
      on ks.user_id = uid and ks.pull_id = rs.pull_id
    where rs.kind <> 'apply'
      and public.retrievability(ks.stability, ks.last_seen_at) > v_floor
      and not exists (
        select 1 from public.path_step_done psd
        where psd.user_id = uid and psd.path_id = p_path_id and psd.ordinal = rs.ordinal
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

  v_completed := public.settle_path_progress(p_path_id);

  return jsonb_build_object(
    'ok', true,
    'testedOutOrdinals', to_jsonb(v_ordinals),
    'completed', v_completed
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
  -- so the refusal names the field rather than a constraint. Blank is refused too, and
  -- blank means no non-whitespace character at all: `btrim` strips spaces only, and a
  -- reflection of tabs and newlines has a length.
  if p_reflection is null or p_reflection !~ '\S' or length(p_reflection) > 20000 then
    raise exception 'A reflection is between 1 and 20000 characters'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.paths where id = p_path_id and status = 'published') then
    raise exception 'Path not found' using errcode = 'P0002';
  end if;

  -- Looked up here as well as in `advance_path`, because the note is written before
  -- the step is advanced and must not be written against a step the caller cannot
  -- read or one that is not an apply step.
  select rs.pull_id, rs.kind into v_pull_id, v_step_kind
  from public.readable_path_steps(p_path_id) rs
  where rs.ordinal = p_ordinal;

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

  -- Marks the step done and puts the idea into the schedule if it was not there --
  -- the same body `advance_path` runs, which refuses apply steps itself so that this
  -- is the only way one is completed.
  perform public.complete_path_step(p_path_id, p_ordinal, v_pull_id);

  -- Then resurfaces it within three days. The row exists now: `complete_path_step`
  -- upserted it, so this always finds something to pull forward.
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
