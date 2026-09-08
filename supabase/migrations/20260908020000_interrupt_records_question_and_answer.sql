-- record_interrupt passes question_id and answer to grade_recall.
--
-- In Package 3e of The Loop (`docs/plans/2026-09-05-the-loop.md`), an interrupt asking a
-- real question (`mcq`, `cloze`, or `recall`) carries the question id and the reader's
-- answer. `grade_recall` already accepts `p_question_id` and `p_answer`; this migration
-- teaches `record_interrupt` to accept them and forward them to `grade_recall`, so recall
-- events filed from the feed are fully attributed.

drop function public.record_interrupt(
  uuid, public.interrupt_kind, int, public.interrupt_response, public.recall_grade, uuid, int, uuid, timestamptz, text
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
  p_confidence   text default null,
  p_question_id  uuid default null,
  p_answer       text default null
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
      p_question_id, p_kind::text, p_latency, p_answer
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
  'Record reader interaction with an ambient interrupt, including question attribution and confidence.';

revoke all on function public.record_interrupt(
  uuid, public.interrupt_kind, int, public.interrupt_response, public.recall_grade, uuid, int, uuid, timestamptz, text, uuid, text
) from public;

grant execute on function public.record_interrupt(
  uuid, public.interrupt_kind, int, public.interrupt_response, public.recall_grade, uuid, int, uuid, timestamptz, text, uuid, text
) to authenticated;
