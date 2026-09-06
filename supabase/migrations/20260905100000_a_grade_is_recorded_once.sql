-- A grade is recorded once.
--
-- `grade_recall` multiplies stability and increments `reps` on every call, and nothing
-- about the call says whether it is the first attempt or a retry of one whose response
-- was lost. So the client has had to treat an ambiguous failure -- a timeout after the
-- request left the tab, a 5xx from a proxy, a session refresh that raced the write --
-- as a grade it must NOT resend, because replaying a `good` roughly squares the
-- interval. `lib/offline.ts` queues a grade only when it can prove the request never
-- went out, and drops it otherwise. That is a reader's honest answer thrown away to
-- avoid a scheduler bug, which is the wrong side to fail on for a product whose
-- memory model is the product.
--
-- `set_conviction` solved the same problem a week ago with a `client_mutation_id`: the
-- client mints one id per decision, the server keeps it, and a retry that carries an
-- id already on record returns what was applied and touches nothing. This migration
-- gives grades the same shape, and does it by making the event itself the thing that
-- is unique rather than by remembering ids on `knowledge_states`, because the event is
-- worth keeping anyway:
--
--   * `knowledge_states` holds one number per idea and overwrites it. It cannot say
--     whether "solid" was earned by three easy recalls or one, whether the reader was
--     sure or guessing, or what they actually typed. A dashboard built on it can only
--     show the model's current opinion, never the evidence for it.
--   * A scheduler change can then be evaluated on the same history rather than argued
--     about, and derived state can be recomputed from the log if the formula moves.
--     `scheduler_version` is on each row for exactly that reason.
--   * Nothing here is estimated. A row is one attempt, as it happened.
--
-- The event is inserted BEFORE the state changes, under the same per-(reader, idea)
-- advisory lock `set_conviction` uses, and it carries the stability the arithmetic is
-- about to write as well as the one it read -- computed first, so the row is complete
-- in one insert. That is not a nicety: the log is append-only through the API and this
-- function runs as the caller, so an UPDATE to fill in `stability_after` afterwards
-- would touch nothing and raise nothing. The test found exactly that. A retry conflicts
-- on `(user_id, client_mutation_id)`, `on conflict do nothing` returns no id, and the
-- function returns the current state untouched. A call without an id behaves exactly as before
-- -- older queued writes and the census still work -- it just cannot be de-duplicated,
-- which is what it could not be before either.
--
-- `record_interrupt` gets the same treatment, one level up: the interrupt row carries
-- the id, a replay stops there, and the grade it forwards inherits the id so the two
-- tables agree about what one answer was.
--
-- Both functions are dropped and recreated rather than `create or replace`d. Adding
-- defaulted parameters to an existing signature creates an OVERLOAD, and the positional
-- call inside `record_interrupt` -- `grade_recall(p_pull_id, p_grade)` -- would then
-- match both and fail with "function is not unique". `20260829135423` did the same for
-- `get_feed` and for the same reason.
--
-- Guests may write here. They can grade today (`knowledge_states_own` carries no guest
-- clause, and Review works for a guest), and an event log that refused them would break
-- that on the first answer. The guest bound belongs on writes that outlive the session
-- or cost money; a row that dies with the account in a day is neither.

-- ------------------------------------------------------------------ the event log

-- `recall_events` references (question, pull) as a pair, and a foreign key can only
-- point at a unique constraint. `id` alone is already the primary key; this adds the
-- pair beside it rather than replacing anything.
alter table public.quiz_questions
  add constraint quiz_questions_id_pull_key unique (id, pull_id);

create table public.recall_events (
  id                 uuid        primary key default extensions.gen_random_uuid(),
  user_id            uuid        not null references auth.users (id) on delete cascade,
  pull_id            uuid        not null references public.pulls (id) on delete cascade,
  -- The canonical question that was asked, when one was. Nullable because a free
  -- recall against the card, the census and the delta probe ask nothing stored. The
  -- reference is composite (see the constraint below) so it cannot name a question
  -- belonging to a different pull.
  quiz_question_id   uuid,
  -- Where the grade came from. `review` is the Review screen; the interrupt kinds are
  -- the feed; `calibration` is the onboarding census, which grades from a declared
  -- level rather than a recall and is worth being able to tell apart later.
  kind               text        not null default 'review',
  grade              public.recall_grade not null,
  -- The reader's own confidence before seeing the answer, when the screen asked. A
  -- confident wrong answer is the one worth repairing first, and only the reader can
  -- supply this half of it.
  confidence         text,
  -- What they typed, for question kinds that take an answer. Bounded like every other
  -- reader-composed column, and to the same limit as `explanations`, so a queued write
  -- cannot be refused forever.
  answer             text,
  latency_ms         int,
  scheduler_version  smallint    not null default 1,
  client_mutation_id uuid,
  submitted_at       timestamptz,
  applied_at         timestamptz not null default now(),
  stability_before   real,
  stability_after    real,
  constraint recall_events_kind_known
    check (kind in ('review', 'recall', 'say_it_back', 'conviction', 'counterpull',
                    'delta_probe', 'calibration')),
  constraint recall_events_confidence_known
    check (confidence is null or confidence in ('sure', 'unsure')),
  -- 20,000 to match `explanations_text_length` and the textarea in `Interrupt.tsx`,
  -- which already accepts that much. A shorter bound here would not truncate a long
  -- Say It Back answer, it would raise inside `record_interrupt` and roll back the
  -- interrupt row and the grade along with it, losing an answer the reader gave and
  -- the product had already accepted elsewhere.
  constraint recall_events_answer_length
    check (answer is null or length(answer) <= 20000),
  constraint recall_events_latency_bounds
    check (latency_ms is null or latency_ms between 0 and 3600000),
  -- Two independent foreign keys would each be satisfied by a real question and a real
  -- pull that have nothing to do with each other, and the log is append-only, so an
  -- answer filed against the wrong question would stay wrong for good -- which is
  -- precisely the per-question evaluation this table exists to make possible. The pair
  -- is checked together instead. MATCH SIMPLE means a null question skips the check
  -- entirely, which is what a free recall needs, and the SET NULL names its column
  -- because `pull_id` is NOT NULL and must not be nulled with it.
  constraint recall_events_question_belongs_to_pull
    foreign key (quiz_question_id, pull_id)
    references public.quiz_questions (id, pull_id)
    on delete set null (quiz_question_id)
);

comment on table public.recall_events is
  'One row per recall attempt, as it happened. Append-only; the evidence behind knowledge_states.';
comment on column public.recall_events.client_mutation_id is
  'Minted by the client per attempt. A retry carrying an id already on record is a no-op.';
comment on column public.recall_events.scheduler_version is
  'Which grade_recall arithmetic applied this event, so a later formula can be evaluated on the same history.';

-- Every foreign key indexed in the file that creates it (lint check 3), and the
-- reader's own timeline is the query every consumer makes.
create index recall_events_user_time_idx     on public.recall_events (user_id, applied_at desc);
create index recall_events_pull_idx          on public.recall_events (pull_id);
create index recall_events_question_idx      on public.recall_events (quiz_question_id);

-- The replay key. Partial, because rows without an id are legitimate and must not
-- collide with each other.
create unique index recall_events_client_mutation_key
  on public.recall_events (user_id, client_mutation_id)
  where client_mutation_id is not null;

-- Law 5: in the migration that creates it.
alter table public.recall_events enable row level security;

-- Self-only, and append-only through the API: there is deliberately no update or
-- delete policy. A log a reader could edit is not evidence of anything.
create policy recall_events_read_own on public.recall_events
  for select using ((select auth.uid()) = user_id);
create policy recall_events_insert_own on public.recall_events
  for insert with check ((select auth.uid()) = user_id);

-- The interrupt row carries the same id, so a replayed answer stops before it grades.
alter table public.interrupt_events add column client_mutation_id uuid;
create unique index interrupt_events_client_mutation_key
  on public.interrupt_events (user_id, client_mutation_id)
  where client_mutation_id is not null;

-- ------------------------------------------------------------------ grade_recall

drop function public.grade_recall(uuid, public.recall_grade);

create function public.grade_recall(
  p_pull_id      uuid,
  p_grade        public.recall_grade,
  p_mutation_id  uuid        default null,
  p_submitted_at timestamptz default null,
  p_confidence   text        default null,
  p_question_id  uuid        default null,
  p_kind         text        default 'review',
  p_latency_ms   int         default null,
  p_answer       text        default null
)
returns public.knowledge_states
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid    uuid := (select auth.uid());
  ks     public.knowledge_states;
  ev_id  uuid;
  new_s  double precision;
  new_d  double precision;
begin
  if uid is null then
    raise exception 'grade_recall requires an authenticated user';
  end if;

  -- Same key as set_conviction: one reader, one idea, one writer at a time. Two
  -- concurrent grades for the same idea would otherwise each read the same stability
  -- and both apply, which is the double-count this migration exists to prevent.
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(uid::text || ':' || p_pull_id::text, 0)
  );

  select * into ks
  from public.knowledge_states
  where user_id = uid and pull_id = p_pull_id;

  if not found then
    insert into public.knowledge_states (user_id, pull_id, acquired_via)
    values (uid, p_pull_id, 'quizzed')
    returning * into ks;
  end if;

  -- The arithmetic is unchanged from 20260829130252. FSRS-shaped: success multiplies
  -- stability (more so when the item is easy), a lapse cuts it back hard and raises
  -- difficulty so the item returns sooner in future too. Computed before the event is
  -- written so the event can carry the outcome; nothing is applied until it is.
  new_d := ks.difficulty;

  case p_grade
    when 'forgot' then
      new_s := greatest(0.5, ks.stability * 0.35);
      new_d := least(1.0, new_d + 0.15);
    when 'hard' then
      new_s := ks.stability * 1.2;
      new_d := least(1.0, new_d + 0.05);
    when 'good' then
      new_s := ks.stability * (2.0 + 1.0 * (1.0 - new_d));
    when 'easy' then
      new_s := ks.stability * (3.0 + 1.5 * (1.0 - new_d));
      new_d := greatest(0.0, new_d - 0.05);
  end case;

  -- Two years is long enough that further growth is untestable guesswork.
  new_s := least(new_s, 730.0);

  -- The event first, complete. If this attempt is already on record the insert does
  -- nothing, no id comes back, and the state is returned exactly as it stands:
  -- whatever the reader has done since, a retry of an older submission must not be
  -- applied twice.
  insert into public.recall_events
    (user_id, pull_id, quiz_question_id, kind, grade, confidence, answer, latency_ms,
     client_mutation_id, submitted_at, stability_before, stability_after)
  values
    (uid, p_pull_id, p_question_id, p_kind, p_grade, p_confidence, p_answer, p_latency_ms,
     p_mutation_id, p_submitted_at, ks.stability, new_s)
  on conflict (user_id, client_mutation_id) where client_mutation_id is not null
    do nothing
  returning id into ev_id;

  if ev_id is null then
    return ks;
  end if;

  update public.knowledge_states
     set stability    = new_s,
         difficulty   = new_d,
         reps         = reps + 1,
         lapses       = lapses + (case when p_grade = 'forgot' then 1 else 0 end),
         last_seen_at = now(),
         next_due_at  = now() + (new_s || ' days')::interval
   where user_id = uid and pull_id = p_pull_id
   returning * into ks;

  return ks;
end;
$$;

comment on function public.grade_recall is
  'Record a recall attempt and reschedule the item. Replay-safe by client_mutation_id. Half-Life mechanic.';

-- A grade is a signed-in act. `anon` has no uid and would only ever hit the first
-- raise; taking the endpoint away from it is one less thing for a scanner to poke at.
revoke all on function public.grade_recall(
  uuid, public.recall_grade, uuid, timestamptz, text, uuid, text, int, text
) from public, anon;
grant execute on function public.grade_recall(
  uuid, public.recall_grade, uuid, timestamptz, text, uuid, text, int, text
) to authenticated;

-- ------------------------------------------------------------------ record_interrupt

drop function public.record_interrupt(
  uuid, public.interrupt_kind, int, public.interrupt_response, public.recall_grade, uuid, int
);

create function public.record_interrupt(
  p_pull_id      uuid,
  p_kind         public.interrupt_kind,
  p_slot         int,
  p_response     public.interrupt_response,
  p_grade        public.recall_grade default null,
  p_session      uuid default null,
  p_latency      int default null,
  p_mutation_id  uuid default null,
  p_submitted_at timestamptz default null,
  p_confidence   text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  ev_id uuid;
begin
  if uid is null then
    return;
  end if;

  insert into public.interrupt_events
    (user_id, session_id, pull_id, kind, slot_position, response, grade, latency_ms,
     responded_at, client_mutation_id)
  values
    (uid, p_session, p_pull_id, p_kind, p_slot, p_response, p_grade, p_latency,
     now(), p_mutation_id)
  on conflict (user_id, client_mutation_id) where client_mutation_id is not null
    do nothing
  returning id into ev_id;

  -- Already recorded: the grade below was applied with it, and the session count
  -- was bumped with it. Nothing left to do.
  if ev_id is null then
    return;
  end if;

  if p_response = 'answered' and p_grade is not null then
    perform public.grade_recall(
      p_pull_id, p_grade, p_mutation_id, p_submitted_at, p_confidence,
      null, p_kind::text, p_latency, null
    );
  end if;

  if p_session is not null then
    update public.session_seeds
       set interrupts_shown = interrupts_shown + 1
     where id = p_session and user_id = uid;
  end if;
end;
$$;

comment on function public.record_interrupt is
  'Record how the reader answered an interleaved question, and grade it once. Replay-safe by client_mutation_id.';

revoke all on function public.record_interrupt(
  uuid, public.interrupt_kind, int, public.interrupt_response, public.recall_grade,
  uuid, int, uuid, timestamptz, text
) from public, anon;
grant execute on function public.record_interrupt(
  uuid, public.interrupt_kind, int, public.interrupt_response, public.recall_grade,
  uuid, int, uuid, timestamptz, text
) to authenticated;
