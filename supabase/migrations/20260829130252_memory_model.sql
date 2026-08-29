-- Redefine retrievability so `stability` means something a person can reason
-- about: it is the interval, in days, at which recall probability is 0.9.
--
-- The previous exp(-t/S) form made S an e-folding time, so a default stability
-- of 1.0 meant "review in 2.5 hours" — which is not what the column default of
-- `now() + 1 day` implies. Stating it as a target retention makes the schedule
-- and the decay curve describe the same thing.
--
--   retrievability(t) = 0.9 ^ (t / stability)      → R = 0.9 exactly at t = S
drop function if exists public.retrievability(real, timestamptz, timestamptz);

create function public.retrievability(
  p_stability real,
  p_last_seen timestamptz,
  p_at        timestamptz default now()
)
returns double precision
language sql
immutable
parallel safe
set search_path = ''
as $$
  select greatest(0.0::double precision, least(1.0::double precision,
    power(0.9::double precision,
          greatest(extract(epoch from (p_at - p_last_seen)) / 86400.0, 0.0)
            / greatest(p_stability::double precision, 0.0001))
  ));
$$;

comment on function public.retrievability is
  'Recall probability now: 0.9 ^ (elapsed_days / stability). Computed, never stored.';

-- Grade a recall attempt and reschedule. FSRS-shaped: success multiplies
-- stability (more so when the item is easy), a lapse cuts it back hard and
-- raises difficulty so the item returns sooner in future too.
create or replace function public.grade_recall(
  p_pull_id uuid,
  p_grade   public.recall_grade
)
returns public.knowledge_states
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid    uuid := (select auth.uid());
  ks     public.knowledge_states;
  new_s  double precision;
  new_d  double precision;
begin
  if uid is null then
    raise exception 'grade_recall requires an authenticated user';
  end if;

  select * into ks
  from public.knowledge_states
  where user_id = uid and pull_id = p_pull_id;

  if not found then
    insert into public.knowledge_states (user_id, pull_id, acquired_via)
    values (uid, p_pull_id, 'quizzed')
    returning * into ks;
  end if;

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
  'Record a recall attempt and reschedule the item. Half-Life mechanic.';
