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
-- Hinted: the reader says so when they looked before answering, and the server adds its own
-- rule -- an answer within thirty minutes of a wrong answer to the same question (any of its
-- versions) is hinted, because the feedback on the wrong one showed the right one. A retry
-- is practice, not proof.

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
  v_event    public.study_answer_events%rowtype;
  it         public.study_items%rowtype;
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

  select count(*) into used
  from public.study_answer_events e
  where e.owner_id = uid
    and e.answered_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';

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
    -- A question a learner could have been shown: validated at some point.
    v_shown := exists (select 1 from public.study_status_log s
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

    -- Hinted when the reader says so, or when a wrong answer to this question -- any version
    -- of it -- was recorded in the last half hour: its feedback showed the right one.
    v_hinted := coalesce((ev ->> 'hinted')::boolean, false)
      or exists (select 1 from public.study_answer_events e
                 join public.study_items v on v.id = e.item_id
                 where e.owner_id = uid and v.lineage_id = it.lineage_id
                   and not e.correct and e.answered_at > clock_timestamp() - retry_window);

    begin
      insert into public.study_answer_events
        (owner_id, item_id, client_event_id, correct, hinted, grading, response)
      values
        (uid, it.id, v_client, (v_graded ->> 'correct')::boolean, v_hinted,
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

revoke all on function public.record_study_answers(jsonb) from public, anon, authenticated;
grant execute on function public.record_study_answers(jsonb) to authenticated;
