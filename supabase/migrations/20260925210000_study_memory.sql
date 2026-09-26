-- Study courses: adaptation. A memory of each claim, kept from the answers that can prove
-- it, and the study Delta read from it: which lessons a reader already knows, which to
-- revisit, and which questions are due.
--
-- The rule is the feed Delta's (docs/eval/delta-reliability.md), and false suppression is
-- the first risk it controls: a lesson is taken out of a session only on strict evidence
-- that its every claim is remembered now. Exposure, a self-graded answer, a hinted one, an
-- answer to the reader's own version or to a question held back, and any answer followed by
-- a wrong one prove nothing -- and the reader's own "not had" takes knowledge away as a
-- wrong answer does. An old success expires with its stability. A report or a withdrawal
-- after the proof withdraws it, because the proof is re-read, not remembered.
--
-- Scheduling is FSRS-shaped, as `grade_recall` is: a success when the claim was due
-- multiplies stability, a lapse cuts it back and raises difficulty. Retrievability is
-- 0.9 ^ (days / stability), never stored. A question is due when the claims it tests have
-- fallen below 0.9, or lapsed.

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
-- The service role reads it as it reads the other study tables: the read path's functions
-- are granted to it, and without this they refused it.
grant select on public.study_claim_memory to authenticated, service_role;

/*
 * Move the memory of each claim an answer tests. Called by the recorder, in its transaction,
 * for each answer it records; nothing else writes the memory.
 *
 *   an answer that proves recall   a success. Stability grows as `grade_recall`'s good does,
 *                                  2 + (1 - difficulty) times, on the first success, or once
 *                                  the claim was due -- a stability had passed since its last
 *                                  success. Before then, answering again is repetition, not
 *                                  spacing, and stability stays: a proof every few hours cannot
 *                                  compound it into years. Not "after a lapse" as well: a
 *                                  lapse that scores has cut stability already, so the claim
 *                                  comes due again soon; one that does not score would have
 *                                  let each "not had" prime the next success to multiply it.
 *   a wrong answer that scores     a lapse: stability to 0.35 of itself (at least half a day),
 *                                  difficulty up 0.15. It takes knowledge away at once. It
 *                                  scores where a right answer would have proved: graded
 *                                  deterministically, to a question the model wrote, validated
 *                                  when answered and now, on validated claims.
 *   any other wrong answer, and    no evidence to schedule by -- the reader's own judgement or
 *   the reader's own "not had"     version, or a key they have said is wrong -- but word that
 *                                  the claim is not remembered now: it takes knowledge away as
 *                                  a lapse does, and leaves stability and difficulty as they
 *                                  were.
 *   anything else                  nothing. A right self-grade, and a right answer that is
 *                                  hinted, to the reader's own version or to a question held
 *                                  back, is practice.
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
  scores  boolean;
  c       uuid;
  m       public.study_claim_memory%rowtype;
begin
  select * into e from public.study_answer_events where id = p_event_id;
  if not found then
    return;
  end if;
  if e.correct then
    -- A right answer moves the memory only as proof.
    if not public.study_answer_proves_recall(e.id) then
      return;
    end if;
    proves := true;
    scores := true;
  else
    -- A wrong one scores where a right one would have proved, hint or none: the proof rule
    -- without its first two clauses.
    proves := false;
    scores := e.grading = 'deterministic'
      and public.study_item_status_at(e.item_id, e.answered_at) = 'validated'
      and exists (select 1 from public.study_items i
                  where i.id = e.item_id and i.status = 'validated' and i.authored_by = 'model')
      and not exists (select 1 from public.study_item_claims ic
                      join public.study_claims cl on cl.id = ic.claim_id
                      where ic.item_id = e.item_id and cl.status <> 'validated');
  end if;

  -- The reader's own judgement or version, or a key they have disputed: never evidence to
  -- schedule by, but "not had" is still word that they do not remember it now. A claim
  -- tested only by short answers -- which a wrong typed answer can only reach self-graded --
  -- could otherwise never be un-known.
  if not scores then
    for c in select ic.claim_id from public.study_item_claims ic where ic.item_id = e.item_id loop
      insert into public.study_claim_memory as t (owner_id, claim_id, last_outcome, last_answered_at)
      values (e.owner_id, c, 'lapse', e.answered_at)
      on conflict (owner_id, claim_id) do update
        set last_outcome = 'lapse', last_answered_at = excluded.last_answered_at;
    end loop;
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
      m.last_outcome := null;
      m.last_success_id := null;
      m.last_success_at := null;
    end if;

    if proves then
      if m.last_success_at is null
         or e.answered_at >= m.last_success_at + make_interval(secs => m.stability * 86400) then
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

/* As 20260925200000, moving the memory of each recorded answer's claims, and key-sharing
   those claims before the questions. */
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
  v_batch    uuid[];
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
  -- The batch's questions, as 20260925200000 takes them: every id the loop below will read,
  -- in any form a uuid is written in, and never a draft, which validation takes in its own
  -- order. Read once, so the claims and the questions below are locked for the same set: a
  -- draft validated between the two would have its questions locked and its claims not.
  select coalesce(array_agg(i.id), '{}') into v_batch
  from public.study_items i
  where i.owner_id = uid
    and i.status <> 'draft'
    and i.id in (select (a.value ->> 'itemId')::uuid
                 from jsonb_array_elements(p_answers) as a
                 where jsonb_typeof(a.value) = 'object'
                   and pg_catalog.pg_input_is_valid(a.value ->> 'itemId', 'uuid'));
  -- The claims they test, key-shared in id order before the questions: the memory's foreign
  -- key key-shares each as the answer moves it, and a claim report locks the claim before its
  -- questions. Taken after the questions, that was a circle.
  perform 1
  from public.study_claims c
  where c.owner_id = uid
    and c.id in (select ic.claim_id from public.study_item_claims ic
                 where ic.item_id = any(v_batch))
  order by c.id
  for key share;
  -- Then the questions, share-locked in id order before any is read, as a claim report and a
  -- correction lock them. An id the loop finds that is not among them -- a draft validated
  -- since -- is refused unshown, as it was when the batch began, rather than locked late.
  select coalesce(array_agg(l.id), '{}') into v_locked
  from (select i.id from public.study_items i
        where i.id = any(v_batch) and i.owner_id = uid
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

    -- Hinted as 20260925200000 says: by the reader, or by a wrong, a self-graded or a
    -- looked-at answer in the last half hour to this question or one on an idea it tests.
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
 * What the reader knows of the current generation's validated claims, at `p_at` (now, when
 * not given):
 *
 *   known            the claim's last answer was a success -- by `p_at`, when one is given:
 *                    asked about the past, nothing proven since counts; its proof still stands
 *                    (re-read through `study_answer_proves_recall`, so a report or withdrawal
 *                    since takes it away); and retrievability at `p_at` is above the feed
 *                    Delta's floor, `known_retrievability_floor()`, compared as the feed does
 *   retrievability   0.9 ^ (days since the last success / stability); null before one.
 *                    Days are counted to at most a thousand stabilities, which is 0 in all
 *                    but name, so no moment asked about takes the power out of range
 *   due_at           when retrievability falls to 0.9 -- one stability after the last success
 *                    -- or, after a lapse, half an hour after it: before then any answer to it
 *                    is hinted (20260925200000) and could not clear it; null before any answer
 *   lapsed           the last answer to it was wrong, and a question on it can still clear
 *                    that: one the model wrote, and validated. The reader's own versions never
 *                    prove, so with only those left "worth rereading" would never go
 *   lapsed_at        when it lapsed, while it is lapsed
 *
 * The current generation is looked up once, not once per claim the reader owns.
 */
create function public.study_claim_knowledge(p_course_id uuid, p_at timestamptz default null)
returns table (
  claim_id       uuid,
  known          boolean,
  retrievability double precision,
  due_at         timestamptz,
  lapsed         boolean,
  lapsed_at      timestamptz
)
language sql
stable
set search_path = ''
as $fn$
  with at as (select coalesce(p_at, now()) as t)
  select c.id,
         coalesce(m.last_outcome = 'success'
                  and (p_at is null or m.last_success_at <= p_at)
                  and public.retrievability(m.stability::real, m.last_success_at, r.t)
                      > public.known_retrievability_floor()
                  and public.study_answer_proves_recall(m.last_success_id), false),
         case when m.last_success_at is not null and (p_at is null or m.last_success_at <= p_at)
              then public.retrievability(m.stability::real, m.last_success_at, r.t) end,
         case when m.last_outcome = 'lapse' then m.last_answered_at + interval '30 minutes'
              when m.last_success_at is not null
              then m.last_success_at + make_interval(secs => m.stability * 86400) end,
         lapse.held,
         case when lapse.held then m.last_answered_at end
  from public.study_claims c
  cross join at
  left join public.study_claim_memory m on m.claim_id = c.id and m.owner_id = c.owner_id
  cross join lateral (
    select least(at.t, m.last_success_at + make_interval(secs => m.stability * 86400 * 1000)) as t
  ) as r
  cross join lateral (
    select coalesce(m.last_outcome = 'lapse', false)
           and exists (select 1 from public.study_item_claims ic
                       join public.study_items i on i.id = ic.item_id
                       where ic.claim_id = c.id and i.status = 'validated'
                         and i.authored_by = 'model') as held
  ) as lapse
  where c.generation_id = (select public.study_course_generation(p_course_id))
    and c.status = 'validated'
$fn$;

revoke all on function public.study_claim_knowledge(uuid, timestamptz) from public, anon;
grant execute on function public.study_claim_knowledge(uuid, timestamptz)
  to authenticated, service_role;

-- ------------------------------------------------------------------ 4. the read path

drop function public.study_course_outline(uuid);

/*
 * As 20260925130000, with the study Delta's word on each lesson:
 *
 *   known     every claim any version of it cited is known: a reader's revision can add to
 *             what the lesson must be known by, never take away from it, or re-citing a
 *             proven claim would make it known unstudied. A claim held back counts as not
 *             known; one withdrawn for good is no longer part of it.
 *   revisit   read, and a claim this version teaches lapsed since it was last read -- by the
 *             server's clock, as the lapse is timed. Reading it again answers that, so a
 *             sitting does not bring it back over and over; the claim stays due for review.
 *   faded     not known, not to revisit, and every claim was once proven: known before, and
 *             time has worn it, which the outline says rather than dropping it silently.
 */
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
  revisit         boolean,
  faded           boolean
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
    where l.generation_id = (select public.study_course_generation(p_course_id))
      and l.status = 'validated'
  ),
  seen as (
    select l.id as lesson_id,
           min(e.occurred_at) filter (where e.kind = 'lesson_shown') as shown_at,
           min(e.occurred_at) filter (where e.kind = 'lesson_read') as read_at,
           max(e.recorded_at) filter (where e.kind = 'lesson_read') as reread_at,
           bool_or(e.kind = 'lesson_skipped') as skipped
    from lessons l
    join public.study_lessons v on v.lineage_id = l.lineage_id
    join public.study_progress_events e on e.lesson_id = v.id
    group by l.id
  ),
  knowledge as (select * from public.study_claim_knowledge(p_course_id)),
  -- See above. `knowledge` has only the validated claims, so a claim held back joins as
  -- unknown rather than dropping out of the lesson and leaving the rest to call it known.
  taught as (
    select l.id as lesson_id,
           bool_and(coalesce(k.known, false)) as known,
           bool_and(k.retrievability is not null) as proven,
           max(k.lapsed_at) filter (where lc.lesson_id = l.id and k.lapsed) as lapsed_at
    from lessons l
    join public.study_lessons v on v.lineage_id = l.lineage_id
    join public.study_lesson_claims lc on lc.lesson_id = v.id
    join public.study_claims c on c.id = lc.claim_id and c.status <> 'retired'
    left join knowledge k on k.claim_id = lc.claim_id
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
         coalesce(taught.lapsed_at > seen.reread_at, false),
         coalesce(taught.proven and not taught.known
                  and (taught.lapsed_at > seen.reread_at) is not true, false)
  from lessons l
  left join seen on seen.lesson_id = l.id
  left join taught on taught.lesson_id = l.id
  order by l.unit_no, l.position
$fn$;

revoke all on function public.study_course_outline(uuid) from public, anon, authenticated;
grant execute on function public.study_course_outline(uuid) to authenticated;

drop function public.study_course_questions(uuid);

/*
 * As 20260925150000, with when a question is due and whether it is now: a column, not a
 * state, as promised. By the server's clock, which the lapse was timed by, not the device's.
 * Only a question the model wrote is ever due: the reader's own versions never prove, so
 * answering one could clear nothing.
 */
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
  due_at           timestamptz,
  due              boolean
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
    where i.generation_id = (select public.study_course_generation(p_course_id))
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
      and ic.item_id in (select items.id from items where items.authored_by = 'model')
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
         due.due_at,
         coalesce(due.due_at <= now(), false)
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
