-- Study courses: adaptation. A memory of each claim, kept from the answers that can prove
-- it, and the study Delta read from it: which lessons a reader already knows, which to
-- revisit, and which questions are due.
--
-- The rule is the feed Delta's (docs/eval/delta-reliability.md), and false suppression is
-- the first risk it controls: a lesson is taken out of a session only on strict evidence
-- that its every claim is remembered now. Exposure, a self-graded answer, a hinted one, an
-- answer to the reader's own version or to a question held back, and any answer followed by
-- a wrong one prove nothing. An old success expires with its stability. A report or a
-- withdrawal after the proof withdraws it, because the proof is re-read, not remembered.
--
-- Scheduling is FSRS-shaped, as `grade_recall` is: a success multiplies stability, a lapse
-- cuts it back and raises difficulty. Retrievability is 0.9 ^ (days / stability), never
-- stored. A question is due when the claims it tests have fallen below 0.9, or lapsed.

-- ------------------------------------------------------------------ 1. the memory

create table public.study_claim_memory (
  owner_id           uuid not null,
  claim_id           uuid not null,
  stability          double precision not null default 1.0
                     check (stability > 0 and stability <= 730),
  difficulty         double precision not null default 0.3
                     check (difficulty >= 0 and difficulty <= 1),
  reps               int not null default 0 check (reps >= 0),
  lapses             int not null default 0 check (lapses >= 0),
  last_outcome       text not null check (last_outcome in ('success', 'lapse')),
  -- The answer that last proved the claim. The proof is re-read through it, so a report
  -- or withdrawal since takes it away. An answer is deleted only with its generation --
  -- a source, course or account deletion -- which takes the claim, so the memory goes too.
  last_success_id    uuid references public.study_answer_events (id) on delete cascade,
  last_success_at    timestamptz,
  last_answered_at   timestamptz not null,
  primary key (owner_id, claim_id),
  foreign key (claim_id, owner_id)
    references public.study_claims (id, owner_id) on delete cascade,
  check ((last_success_id is null) = (last_success_at is null))
);

create index study_claim_memory_claim_idx on public.study_claim_memory (claim_id, owner_id);
create index study_claim_memory_success_idx on public.study_claim_memory (last_success_id);

alter table public.study_claim_memory enable row level security;
create policy study_claim_memory_select_own on public.study_claim_memory
  for select to authenticated using (owner_id = (select auth.uid()));
revoke all on public.study_claim_memory from public, anon, authenticated, service_role;
grant select on public.study_claim_memory to authenticated;

/*
 * Move the memory of each claim an answer tests. Called by the recorder, in its transaction,
 * for each answer it records; nothing else writes the memory.
 *
 *   an answer that proves recall   a success: stability grows as `grade_recall`'s good does,
 *                                  2 + (1 - difficulty) times -- unless the claim last
 *                                  succeeded under twelve hours ago, since answering again the
 *                                  same day is repetition, not spacing;
 *   a wrong deterministic answer   a lapse: stability to 0.35 of itself (at least half a
 *                                  day), difficulty up 0.15. It takes knowledge away at once;
 *   anything else                  nothing. A self-grade, a hinted answer, the reader's own
 *                                  version and a question held back are practice.
 */
create function public.study_remember(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  e       public.study_answer_events%rowtype;
  proves  boolean;
  c       uuid;
  m       public.study_claim_memory%rowtype;
begin
  select * into e from public.study_answer_events where id = p_event_id;
  if not found or e.grading <> 'deterministic' then
    return;
  end if;
  if not exists (select 1 from public.study_items i
                 where i.id = e.item_id and i.authored_by = 'model') then
    return;
  end if;
  proves := public.study_answer_proves_recall(e.id);
  if not proves and e.correct then
    return;
  end if;

  for c in select ic.claim_id from public.study_item_claims ic where ic.item_id = e.item_id loop
    select * into m from public.study_claim_memory
    where owner_id = e.owner_id and claim_id = c
    for update;
    if not found then
      m.stability := 1.0;
      m.difficulty := 0.3;
      m.reps := 0;
      m.lapses := 0;
      m.last_success_id := null;
      m.last_success_at := null;
    end if;

    if proves then
      if m.last_success_at is null or e.answered_at - m.last_success_at >= interval '12 hours'
         or m.last_outcome = 'lapse' then
        m.stability := least(730.0, m.stability * (2.0 + (1.0 - m.difficulty)));
      end if;
      m.last_outcome := 'success';
      m.last_success_id := e.id;
      m.last_success_at := e.answered_at;
    else
      m.stability := greatest(0.5, m.stability * 0.35);
      m.difficulty := least(1.0, m.difficulty + 0.15);
      m.lapses := m.lapses + 1;
      m.last_outcome := 'lapse';
    end if;
    m.reps := m.reps + 1;

    insert into public.study_claim_memory as t
      (owner_id, claim_id, stability, difficulty, reps, lapses, last_outcome,
       last_success_id, last_success_at, last_answered_at)
    values
      (e.owner_id, c, m.stability, m.difficulty, m.reps, m.lapses, m.last_outcome,
       m.last_success_id, m.last_success_at, e.answered_at)
    on conflict (owner_id, claim_id) do update
      set stability = excluded.stability, difficulty = excluded.difficulty,
          reps = excluded.reps, lapses = excluded.lapses,
          last_outcome = excluded.last_outcome, last_success_id = excluded.last_success_id,
          last_success_at = excluded.last_success_at, last_answered_at = excluded.last_answered_at;
  end loop;
end
$fn$;

revoke all on function public.study_remember(uuid) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------ 2. the recorder

/* As 20260925200000, moving the memory of each recorded answer's claims. */
create or replace function public.record_study_answers(p_answers jsonb)
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
  -- The time once the lock is held, not when the call began: a call that waited across
  -- midnight counts today's answers, not yesterday's.
  v_now := clock_timestamp();
  v_since := v_now - retry_window;

  -- The batch's questions, share-locked in id order before any is read, as a claim report
  -- and a correction lock them (see below). The stamp share-locks each as it is recorded, and
  -- in the batch's own order that deadlocked with either.
  perform 1
  from public.study_items i
  where i.owner_id = uid
    and i.id in (select (a.value ->> 'itemId')::uuid
                 from jsonb_array_elements(p_answers) as a
                 where jsonb_typeof(a.value) = 'object'
                   and a.value ->> 'itemId'
                       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  order by i.id
  for share;

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

    -- Hinted when the reader says so, or when an answer to this question -- any version of
    -- it -- recorded in the last half hour showed the right one: a wrong answer's feedback
    -- does, and so does judging your own, which is done against the course's answer.
    v_hinted := coalesce((ev ->> 'hinted')::boolean, false)
      or exists (select 1 from public.study_answer_events e
                 join public.study_items v on v.id = e.item_id
                 where e.owner_id = uid and v.lineage_id = it.lineage_id
                   and (not e.correct or e.grading = 'self')
                   and e.answered_at > v_since);

    begin
      insert into public.study_answer_events
        (owner_id, item_id, client_event_id, correct, hinted, grading, response)
      values
        (uid, it.id, v_client, (v_graded ->> 'correct')::boolean, v_hinted,
         v_graded ->> 'grading', v_graded ->> 'response')
      returning * into v_event;
      recorded := recorded + 1;
      used := used + 1;
      -- What this answer does to the reader's memory of each claim it tests.
      perform public.study_remember(v_event.id);
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

-- ------------------------------------------------------------------ 3. the study Delta

/*
 * What the reader knows of the current generation's validated claims, at `p_at`:
 *
 *   known            the claim's last answer was a success, its proof still stands (re-read
 *                    through `study_answer_proves_recall`, so a report or withdrawal since
 *                    takes it away), and retrievability at `p_at` is at least 0.7 -- the
 *                    feed Delta's floor
 *   retrievability   0.9 ^ (days since the last success / stability); null before one
 *   due_at           when retrievability falls to 0.9 -- one stability after the last success
 *                    -- or the last answer's time after a lapse; null before any answer
 *   lapsed           the last answer to it was wrong
 */
create function public.study_claim_knowledge(p_course_id uuid, p_at timestamptz default now())
returns table (
  claim_id       uuid,
  known          boolean,
  retrievability double precision,
  due_at         timestamptz,
  lapsed         boolean
)
language sql
stable
set search_path = ''
as $fn$
  select c.id,
         coalesce(m.last_outcome = 'success'
                  and public.retrievability(m.stability::real, m.last_success_at, p_at) >= 0.7
                  and public.study_answer_proves_recall(m.last_success_id), false),
         case when m.last_success_at is not null
              then public.retrievability(m.stability::real, m.last_success_at, p_at) end,
         case when m.last_outcome = 'lapse' then m.last_answered_at
              when m.last_success_at is not null
              then m.last_success_at + make_interval(secs => m.stability * 86400) end,
         coalesce(m.last_outcome = 'lapse', false)
  from public.study_claims c
  left join public.study_claim_memory m on m.claim_id = c.id and m.owner_id = c.owner_id
  where c.generation_id = public.study_course_generation(p_course_id)
    and c.status = 'validated'
$fn$;

revoke all on function public.study_claim_knowledge(uuid, timestamptz) from public, anon;
grant execute on function public.study_claim_knowledge(uuid, timestamptz)
  to authenticated, service_role;

-- ------------------------------------------------------------------ 4. the read path

drop function public.study_course_outline(uuid);

/* As 20260925130000, with `known` and `revisit` from the study Delta. */
create function public.study_course_outline(p_course_id uuid)
returns table (
  generation_id   uuid,
  unit_no         smallint,
  unit_title      text,
  lesson_id       uuid,
  lesson_key      text,
  lesson_position smallint,
  title           text,
  objective       text,
  minutes         smallint,
  question_count  int,
  state           text,
  first_shown_at  timestamptz,
  read_at         timestamptz,
  known           boolean,
  revisit         boolean
)
language sql
stable
set search_path = ''
as $fn$
  with lessons as (
    select l.*,
           -- When this lesson's unit title was last changed by a correction, if ever.
           (select max(v.created_at)
            from public.study_lessons v
            join public.study_lessons p on p.id = v.supersedes_id
            where v.lineage_id = l.lineage_id and v.unit_title is distinct from p.unit_title)
             as titled_at
    from public.study_lessons l
    where l.generation_id = public.study_course_generation(p_course_id)
      and l.status = 'validated'
  ),
  seen as (
    select l.id as lesson_id,
           min(e.occurred_at) filter (where e.kind = 'lesson_shown') as shown_at,
           min(e.occurred_at) filter (where e.kind = 'lesson_read') as read_at,
           bool_or(e.kind = 'lesson_skipped') as skipped
    from lessons l
    join public.study_lessons v on v.lineage_id = l.lineage_id
    join public.study_progress_events e on e.lesson_id = v.id
    group by l.id
  ),
  knowledge as (select * from public.study_claim_knowledge(p_course_id)),
  -- Known when the lesson teaches at least one validated claim and every one is known;
  -- worth revisiting when the reader's last answer on any of them was wrong.
  taught as (
    select l.id as lesson_id,
           bool_and(k.known) as known,
           bool_or(k.lapsed) as revisit
    from lessons l
    join public.study_lesson_claims lc on lc.lesson_id = l.id
    join knowledge k on k.claim_id = lc.claim_id
    group by l.id
  )
  select l.generation_id,
         l.unit_no,
         first_value(l.unit_title)
           over (partition by l.unit_no order by l.titled_at desc nulls last, l.position),
         l.id,
         l.lesson_key,
         l.position,
         l.title,
         l.objective,
         l.minutes,
         (select count(*) from public.study_items i
          where i.lesson_id = l.id and i.status = 'validated')::int,
         case when seen.read_at is not null then 'read'
              when seen.skipped then 'skipped'
              when seen.shown_at is not null then 'shown'
              else 'not_seen' end,
         seen.shown_at,
         seen.read_at,
         coalesce(taught.known, false),
         coalesce(taught.revisit, false)
  from lessons l
  left join seen on seen.lesson_id = l.id
  left join taught on taught.lesson_id = l.id
  order by l.unit_no, l.position
$fn$;

revoke all on function public.study_course_outline(uuid) from public, anon, authenticated;
grant execute on function public.study_course_outline(uuid) to authenticated;

drop function public.study_course_questions(uuid);

/* As 20260925150000, with `due_at`: `due` is a column, not a state, as promised. */
create function public.study_course_questions(p_course_id uuid)
returns table (
  generation_id    uuid,
  item_id          uuid,
  lesson_id        uuid,
  item_key         text,
  purpose          text,
  kind             text,
  difficulty       smallint,
  authored_by      text,
  state            text,
  first_shown_at   timestamptz,
  last_answered_at timestamptz,
  demonstrated_at  timestamptz,
  due_at           timestamptz
)
language sql
stable
set search_path = ''
as $fn$
  with items as (
    -- Validated now, by construction; and whether every claim under it is validated now.
    select i.*,
           not exists (select 1 from public.study_item_claims ic
                       join public.study_claims c on c.id = ic.claim_id
                       where ic.item_id = i.id and c.status <> 'validated') as claims_validated
    from public.study_items i
    where i.generation_id = public.study_course_generation(p_course_id)
      and i.status = 'validated'
  ),
  shown as (
    select i.id as item_id, min(e.occurred_at) as shown_at
    from items i
    join public.study_items v on v.lineage_id = i.lineage_id
    join public.study_progress_events e on e.item_id = v.id and e.kind = 'item_shown'
    group by i.id
  ),
  answered as (
    select a.item_id, max(a.answered_at) as last_answered_at
    from public.study_answer_events a
    where a.item_id in (select items.id from items)
    group by a.item_id
  ),
  -- The proof rule, set-based: a correct, unhinted, deterministically graded answer to a
  -- question the model wrote, validated when answered, validated now, on validated claims.
  demonstrated as (
    select a.item_id, min(a.answered_at) as demonstrated_at
    from items i
    join public.study_answer_events a on a.item_id = i.id
    cross join lateral (
      select l.to_status
      from public.study_status_log l
      where l.item_id = a.item_id and l.at <= a.answered_at
      order by l.at desc, l.id desc
      limit 1
    ) as then_status
    where i.authored_by = 'model'
      and i.claims_validated
      and a.correct
      and not a.hinted
      and a.grading = 'deterministic'
      and then_status.to_status = 'validated'
    group by a.item_id
  ),
  -- Due once answered, when the first of the claims it tests is due: its retrievability has
  -- fallen to 0.9, or the reader's last answer on it was wrong.
  due as (
    select ic.item_id, min(k.due_at) as due_at
    from public.study_item_claims ic
    join public.study_claim_knowledge(p_course_id) k on k.claim_id = ic.claim_id
    where ic.item_id in (select answered.item_id from answered)
    group by ic.item_id
  )
  select i.generation_id,
         i.id,
         l.id,
         i.item_key,
         i.purpose,
         i.kind,
         i.difficulty,
         i.authored_by,
         case when demonstrated.demonstrated_at is not null then 'recall_demonstrated'
              when answered.last_answered_at is not null then 'answered'
              when shown.shown_at is not null then 'shown'
              else 'not_seen' end,
         shown.shown_at,
         answered.last_answered_at,
         demonstrated.demonstrated_at,
         due.due_at
  from items i
  -- Only a lesson the outline shows: a question whose lesson is held back (reported, or
  -- quarantined) reads as course-level until the lesson returns.
  left join public.study_lessons l on l.id = i.lesson_id and l.status = 'validated'
  left join shown on shown.item_id = i.id
  left join answered on answered.item_id = i.id
  left join demonstrated on demonstrated.item_id = i.id
  left join due on due.item_id = i.id
  order by l.unit_no nulls last, l.position nulls last,
           (substr(i.item_key, 2))::int
$fn$;

revoke all on function public.study_course_questions(uuid) from public, anon, authenticated;
grant execute on function public.study_course_questions(uuid) to authenticated;
