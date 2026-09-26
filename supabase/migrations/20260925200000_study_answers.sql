-- Study courses: practice. The recorder that grades an answer on the server and writes it
-- down, which `study_answer_events` has waited for since 20260925050000.
--
-- `study_answer_events` is what "you know this" is decided from (`study_answer_proves_recall`),
-- so no API role has ever been able to write it. This adds the one path: a definer that
-- takes the reader's response -- the option they chose, what they typed, the order they put
-- the steps in, the pairs they matched -- grades it itself, and records the result. The
-- browser grades too, so feedback does not wait on the network and practice works offline,
-- but what it concludes is never sent: the server grades again from the response, and its
-- answer is the one kept. `study_grade_response` is the rule, and the web's copy is held to
-- it by `scripts/test-study-grade-parity.mjs`.
--
-- Grading:
--
--   multiple_choice,  the chosen option, which must be the answer or one of the offered
--   comparison,       wrong options (folded as `study_fold` folds). Deterministic.
--   application
--   ordering          the reader's order, as positions in the question's own sequence.
--                     Right when it is the sequence. Deterministic.
--   matching          for each left side, the position of the right side chosen for it.
--                     Right when every pair is kept. Deterministic.
--   cloze             what was typed. Right when it folds to the answer or an accepted
--                     variant, wrong otherwise. Deterministic.
--   short_recall      what was typed. When it folds to the answer or an accepted variant it
--                     is right, deterministically. Otherwise the reader compares it with the
--                     model answer and says whether they had it: `self` grading, which the
--                     proof rule never counts.
--
-- Hinted: the reader says so when they looked before answering or are trying again -- kept
-- as `looked` -- and the server adds its own rule: an answer within thirty minutes of a
-- wrong, a self-graded or a looked-at answer to the same question (any of its versions), or
-- to another question on a claim it tests, is hinted, because the feedback on the one, the
-- course's answer the other is judged against, and the passage the reader opened, showed
-- the right one. A retry is practice, not proof.
--
-- The recorder share-locks a batch's questions in id order, and `revise_study_lesson`
-- (20260925100000) and `retire_study_content` (20260925060000), which are pushed, are
-- superseded here to lock a lesson's questions in the same order, so none of them deadlocks
-- with another or with a claim report (law 6).

-- ------------------------------------------------------------------ 1. the rule

/*
 * Grade one response to one question. Answers `{correct, grading, response}` -- `response`
 * being what is stored: the text as given, or positions as comma-separated numbers -- or
 * null when the response is malformed for the kind: not an offered option, not a
 * permutation of the steps, a self-grade missing where one is needed.
 */
create function public.study_grade_response(
  p_kind        text,
  p_answer      text,
  p_accepted    text[],
  p_distractors jsonb,
  p_sequence    text[],
  p_pairs       jsonb,
  p_response    jsonb,
  p_self        text
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  typed    text;
  key      text;
  n        int;
  pos      int[];
  i        int;
  right_ok boolean;
begin
  if p_kind in ('multiple_choice', 'comparison', 'application') then
    if jsonb_typeof(p_response) is distinct from 'string' then
      return null;
    end if;
    typed := p_response #>> '{}';
    if char_length(typed) > 1000 then
      return null;
    end if;
    key := public.study_fold(typed);
    if key = public.study_fold(p_answer) then
      return jsonb_build_object('correct', true, 'grading', 'deterministic', 'response', typed);
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_distractors, '[]'::jsonb)) d
               where public.study_fold(d ->> 'text') = key) then
      return jsonb_build_object('correct', false, 'grading', 'deterministic', 'response', typed);
    end if;
    return null;
  end if;

  if p_kind in ('ordering', 'matching') then
    n := case when p_kind = 'ordering' then coalesce(cardinality(p_sequence), 0)
              else coalesce(jsonb_array_length(p_pairs), 0) end;
    if n = 0 or jsonb_typeof(p_response) is distinct from 'array'
       or jsonb_array_length(p_response) <> n
       or exists (select 1 from jsonb_array_elements(p_response) e
                  where jsonb_typeof(e) <> 'number') then
      return null;
    end if;
    begin
      pos := array(select (e #>> '{}')::int from jsonb_array_elements(p_response) e);
    exception when data_exception then
      return null;
    end;
    -- A permutation of 0 .. n-1: every position once.
    if exists (select 1 from unnest(pos) p where p < 0 or p >= n)
       or (select count(distinct p) from unnest(pos) p) <> n then
      return null;
    end if;
    right_ok := true;
    for i in 1 .. n loop
      if pos[i] <> i - 1 then
        right_ok := false;
      end if;
    end loop;
    return jsonb_build_object('correct', right_ok, 'grading', 'deterministic',
                              'response', array_to_string(pos, ','));
  end if;

  if p_kind in ('cloze', 'short_recall') then
    if jsonb_typeof(p_response) is distinct from 'string' then
      return null;
    end if;
    typed := p_response #>> '{}';
    if char_length(typed) > 1000 then
      return null;
    end if;
    key := public.study_fold(typed);
    if key <> '' and (key = public.study_fold(p_answer)
                      or exists (select 1 from unnest(coalesce(p_accepted, '{}'::text[])) a
                                 where public.study_fold(a) = key)) then
      return jsonb_build_object('correct', true, 'grading', 'deterministic', 'response', typed);
    end if;
    if p_kind = 'cloze' then
      return jsonb_build_object('correct', false, 'grading', 'deterministic', 'response', typed);
    end if;
    if p_self is null or p_self not in ('correct', 'incorrect') then
      return null;
    end if;
    return jsonb_build_object('correct', p_self = 'correct', 'grading', 'self',
                              'response', nullif(typed, ''));
  end if;

  return null;
end
$fn$;

revoke all on function public.study_grade_response(text, text, text[], jsonb, text[], jsonb, jsonb, text)
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------ 2. the recorder

alter table public.study_answer_events
  add column looked boolean not null default false;

comment on column public.study_answer_events.looked is
  'Whether the reader said they looked before answering: opened the passage, or tried again '
  'after feedback. Part of `hinted`, which the recorder''s own rule adds to; kept apart so '
  'that looking hints the other questions on the same claim without a derived hint chaining '
  'one half hour to the next.';

/*
 * Record a batch of answers, graded here. Each is
 *
 *   { clientEventId, itemId, response, selfGrade?, hinted? }
 *
 * and each is judged on its own, as progress events are: `malformed`, `not_found` (not the
 * reader's, or gone), `not_shown` (never validated) and `limit` (1,000 a UTC day) are
 * refusals, and a client event id already recorded is a duplicate, answered with what was
 * recorded for it. The time is the database's (`study_answer_events_stamp`).
 *
 * Returns `{ recorded, duplicates, refused: [{index, clientEventId?, reason}],
 *            results: [{index, clientEventId, itemId, correct, grading, hinted, provesRecall}] }`.
 */
create function public.record_study_answers(p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  daily_limit constant int := 1000;
  batch_limit constant int := 50;
  retry_window constant interval := interval '30 minutes';

  uid        uuid := (select auth.uid());
  ev         jsonb;
  ord        bigint;
  v_client   uuid;
  v_item     uuid;
  v_hinted   boolean;
  v_self     text;
  v_graded   jsonb;
  v_shown    boolean;
  v_locked   uuid[];
  v_event    public.study_answer_events%rowtype;
  it         public.study_items%rowtype;
  v_now      timestamptz;
  v_since    timestamptz;
  used       int;
  recorded   int := 0;
  duplicates int := 0;
  refused    jsonb := '[]'::jsonb;
  results    jsonb := '[]'::jsonb;
begin
  if uid is null then
    raise exception 'recording an answer requires a signed-in reader' using errcode = '28000';
  end if;
  if jsonb_typeof(p_answers) is distinct from 'array'
     or jsonb_array_length(p_answers) not between 1 and batch_limit then
    raise exception 'send 1 to % answers at a time', batch_limit using errcode = '22023';
  end if;

  -- The reader's study lock, as a progress batch takes it: one batch at a time, so the
  -- daily count cannot be raced past, and serialised with deleting the reader's sources,
  -- courses and account, which take it before any row (20260925160000).
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended('study_progress:' || uid::text, 0));
  -- The batch's questions, share-locked in id order before any is read, as a claim report
  -- and a correction lock them (see below). The stamp share-locks each as it is recorded, and
  -- in the batch's own order that deadlocked with either. Every id the loop below will read,
  -- in any form a uuid is written in -- a stricter test left some to be locked in the batch's
  -- order after all -- and never a draft: validation takes drafts in its own order. The ids
  -- locked are kept, and one the loop finds that is not among them -- a draft validated
  -- since -- is refused unshown, as it was when the batch began, rather than locked late.
  select coalesce(array_agg(l.id), '{}') into v_locked
  from (select i.id
        from public.study_items i
        where i.owner_id = uid
          and i.status <> 'draft'
          and i.id in (select (a.value ->> 'itemId')::uuid
                       from jsonb_array_elements(p_answers) as a
                       where jsonb_typeof(a.value) = 'object'
                         and pg_catalog.pg_input_is_valid(a.value ->> 'itemId', 'uuid'))
        order by i.id
        for share) as l;

  -- The time once the locks are held, not when the call began: a call that waited across
  -- midnight counts today's answers, not yesterday's.
  v_now := clock_timestamp();
  v_since := v_now - retry_window;

  select count(*) into used
  from public.study_answer_events e
  where e.owner_id = uid
    and e.answered_at >= date_trunc('day', v_now, 'UTC');

  for ev, ord in select value, ordinality from jsonb_array_elements(p_answers) with ordinality loop
    v_client := null;
    v_item := null;
    if jsonb_typeof(ev) is distinct from 'object' then
      refused := refused || jsonb_build_object('index', ord - 1, 'reason', 'malformed');
      continue;
    end if;
    begin
      v_client := (ev ->> 'clientEventId')::uuid;
    exception when data_exception then
      v_client := null;
    end;
    begin
      v_item := (ev ->> 'itemId')::uuid;
    exception when data_exception then
      v_item := null;
    end;
    v_self := ev ->> 'selfGrade';
    if v_client is null or v_item is null
       or coalesce(jsonb_typeof(ev -> 'hinted'), 'boolean') <> 'boolean'
       or coalesce(jsonb_typeof(ev -> 'selfGrade'), 'string') <> 'string' then
      refused := refused || jsonb_strip_nulls(jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'malformed'));
      continue;
    end if;

    select * into v_event from public.study_answer_events e
    where e.owner_id = uid and e.client_event_id = v_client;
    if found then
      duplicates := duplicates + 1;
      results := results || jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'itemId', v_event.item_id,
        'correct', v_event.correct, 'grading', v_event.grading, 'hinted', v_event.hinted,
        'provesRecall', public.study_answer_proves_recall(v_event.id));
      continue;
    end if;

    select * into it from public.study_items i where i.id = v_item and i.owner_id = uid;
    if not found then
      refused := refused || jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'not_found');
      continue;
    end if;
    -- A question a learner could have been shown: validated at some point, and not a draft
    -- when the batch took its locks.
    v_shown := it.id = any(v_locked)
      and exists (select 1 from public.study_status_log s
                  where s.item_id = it.id and s.owner_id = uid and s.to_status = 'validated');
    if not v_shown then
      refused := refused || jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'not_shown');
      continue;
    end if;

    v_graded := public.study_grade_response(it.kind, it.answer, it.accepted_answers,
                                            it.distractors, it.sequence, it.pairs,
                                            ev -> 'response', v_self);
    if v_graded is null then
      refused := refused || jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'malformed');
      continue;
    end if;
    if used >= daily_limit then
      refused := refused || jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'reason', 'limit');
      continue;
    end if;

    -- Hinted when the reader says so, or when an answer recorded in the last half hour --
    -- by the server's clock, as answers arrive -- showed the right one: a wrong answer's
    -- feedback does, judging your own does, as it is done against the course's answer, and
    -- so does an answer given with the passage open. To this question, in any of its
    -- versions -- or to any other question on an idea this one tests: the feedback and the
    -- passage state the idea, and a second question on it asked straight after is answered
    -- from that, not from memory. Only what the reader said they looked at counts as looking
    -- (`looked`), not a hint this rule derived, which would chain one half hour to the next.
    v_hinted := coalesce((ev ->> 'hinted')::boolean, false)
      or exists (select 1 from public.study_answer_events e
                 join public.study_items v on v.id = e.item_id
                 where e.owner_id = uid
                   and (not e.correct or e.grading = 'self' or e.looked)
                   and e.answered_at > v_since
                   and (v.lineage_id = it.lineage_id
                        or exists (select 1 from public.study_item_claims p
                                   join public.study_item_claims h on h.claim_id = p.claim_id
                                   where p.item_id = e.item_id and h.item_id = it.id)));

    begin
      insert into public.study_answer_events
        (owner_id, item_id, client_event_id, correct, hinted, looked, grading, response)
      values
        (uid, it.id, v_client, (v_graded ->> 'correct')::boolean, v_hinted,
         coalesce((ev ->> 'hinted')::boolean, false),
         v_graded ->> 'grading', v_graded ->> 'response')
      returning * into v_event;
      recorded := recorded + 1;
      used := used + 1;
      results := results || jsonb_build_object(
        'index', ord - 1, 'clientEventId', v_client, 'itemId', it.id,
        'correct', v_event.correct, 'grading', v_event.grading, 'hinted', v_event.hinted,
        'provesRecall', public.study_answer_proves_recall(v_event.id));
    exception
      -- Deleted between the check and the insert.
      when foreign_key_violation then
        refused := refused || jsonb_build_object(
          'index', ord - 1, 'clientEventId', v_client, 'reason', 'not_found');
    end;
  end loop;

  return jsonb_build_object('recorded', recorded, 'duplicates', duplicates,
                            'refused', refused, 'results', results);
end
$fn$;

revoke all on function public.record_study_answers(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_study_answers(jsonb) to authenticated;

-- The day's count, read on every call: without it, every answer the reader ever gave.
create index study_answer_events_owner_day on public.study_answer_events (owner_id, answered_at);

-- ------------------------------------------------------------------ a lesson's questions, in order

/* A correction and a withdrawal move every question of a lesson in one statement, which locks
   them in whatever order the table holds them. The recorder share-locks a batch's questions
   in id order, as a claim report locks them (`study_refresh_claim_dependents`), so these lock
   the same rows in id order first, and the three cannot wait on each other in a circle. */
create or replace function public.revise_study_lesson(p_lesson_id uuid, p_revision jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_gen       uuid;
  v_prev      public.study_lessons%rowtype;
  v_claims    uuid[];
  v_unit      text;
  v_title     text;
  v_objective text;
  v_explain   text;
  v_example   text;
  v_recap     text;
  v_problems  text[];
  v_new       uuid;
  v_unknown   text;
begin
  if auth.uid() is null then
    raise exception 'correcting a course requires a signed-in reader' using errcode = '28000';
  end if;
  perform public.study_check_revision_size(p_revision, jsonb_build_object(
    'unitTitle', jsonb_build_object('chars', 200),
    'title', jsonb_build_object('chars', 200),
    'objective', jsonb_build_object('chars', 500),
    'explanation', jsonb_build_object('chars', 6000),
    'example', jsonb_build_object('chars', 2000),
    'recap', jsonb_build_object('chars', 1000),
    'claimIds', jsonb_build_object('chars', 36, 'items', 6)));
  select k into v_unknown from jsonb_object_keys(p_revision) k
  where k not in ('unitTitle', 'title', 'objective', 'explanation', 'example', 'recap',
                  'claimIds')
  limit 1;
  if v_unknown is not null then
    raise exception 'a lesson revision has no field %', v_unknown using errcode = '22023';
  end if;

  v_gen := public.study_lock_for_correction('lesson', p_lesson_id);
  perform public.study_lock_target('lesson', p_lesson_id);
  select * into v_prev from public.study_lessons where id = p_lesson_id;
  if v_prev.status not in ('validated', 'suspended', 'quarantined') then
    raise exception 'only a live lesson can be revised' using errcode = '55000';
  end if;
  perform public.study_check_revision_quota(v_prev.version);

  v_claims := coalesce(public.study_revision_claims(p_revision, v_gen),
                       array(select lc.claim_id from public.study_lesson_claims lc
                             where lc.lesson_id = v_prev.id));
  v_unit := public.study_revision_text(p_revision, 'unitTitle', v_prev.unit_title);
  v_title := public.study_revision_text(p_revision, 'title', v_prev.title);
  v_objective := public.study_revision_text(p_revision, 'objective', v_prev.objective);
  v_explain := public.study_revision_text(p_revision, 'explanation', v_prev.explanation);
  v_example := public.study_revision_text(p_revision, 'example', v_prev.example);
  v_recap := public.study_revision_text(p_revision, 'recap', v_prev.recap);

  v_problems := public.study_lesson_problems(
    array[v_title, v_objective, v_explain, v_example, v_recap, v_unit], v_claims,
    public.study_source_link_set(v_gen), true);
  if public.study_blank(v_unit) and not 'text_missing' = any(v_problems) then
    v_problems := v_problems || 'text_missing'::text;
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'this revision does not pass validation: %',
      array_to_string(v_problems, ', ')
      using errcode = '22023', detail = array_to_string(v_problems, ',');
  end if;

  perform set_config('study.status_reason', 'revised', true);
  update public.study_lessons set status = 'retired', retired_at = now() where id = v_prev.id;

  insert into public.study_lessons
    (owner_id, generation_id, lesson_key, position, unit_no, unit_title, title, objective,
     explanation, example, recap, minutes, status, lineage_id, version, supersedes_id,
     authored_by)
  values
    (v_prev.owner_id, v_prev.generation_id, v_prev.lesson_key, v_prev.position, v_prev.unit_no,
     v_unit, v_title, v_objective, v_explain, v_example, v_recap, v_prev.minutes,
     'validated', v_prev.lineage_id, v_prev.version + 1, v_prev.id, 'reader')
  returning id into v_new;

  insert into public.study_lesson_claims (lesson_id, claim_id, owner_id)
  select v_new, cited, v_prev.owner_id from unnest(v_claims) as cited;

  perform 1 from public.study_items
   where lesson_id = v_prev.id and status <> 'retired'
   order by id
   for no key update;
  update public.study_items set lesson_id = v_new
   where lesson_id = v_prev.id and status <> 'retired';

  update public.study_reports
     set status = 'revised', resolved_at = now(), replacement_lesson_id = v_new
   where lesson_id = v_prev.id and status = 'open';
  return v_new;
end
$fn$;

create or replace function public.retire_study_content(p_kind text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  st text;
begin
  perform public.study_lock_for_correction(p_kind, p_id);
  st := public.study_lock_target(p_kind, p_id);
  if st not in ('validated', 'suspended', 'quarantined') then
    raise exception 'only a live claim, lesson or question can be retired'
      using errcode = '55000';
  end if;

  perform set_config('study.status_reason', 'retired', true);
  if p_kind = 'claim' then
    update public.study_claims set status = 'retired', retired_at = now() where id = p_id;
    update public.study_reports set status = 'retired', resolved_at = now()
     where claim_id = p_id and status = 'open';
    perform set_config('study.status_reason', 'claim_retired', true);
    perform public.study_refresh_claim_dependents(p_id);
  elsif p_kind = 'lesson' then
    update public.study_lessons set status = 'retired', retired_at = now() where id = p_id;
    update public.study_reports set status = 'retired', resolved_at = now()
     where lesson_id = p_id and status = 'open';
    perform 1 from public.study_items
     where lesson_id = p_id and status <> 'retired'
     order by id
     for no key update;
    update public.study_items set lesson_id = null
     where lesson_id = p_id and status <> 'retired';
  else
    update public.study_items set status = 'retired', retired_at = now() where id = p_id;
    update public.study_reports set status = 'retired', resolved_at = now()
     where item_id = p_id and status = 'open';
  end if;
end
$fn$;
