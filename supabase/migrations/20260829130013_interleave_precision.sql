-- The interleave planner is implemented twice: here (authoritative) and in
-- packages/ranking (for client-side prefetch). A parity test asserts they agree.
--
-- They cannot agree while the SQL side computes in `real` (float4) and the TS
-- side in float64: float4 0.08 is really 0.07999999821186066, so a draw landing
-- between the two representations would be an interrupt in one implementation
-- and not the other. Rare, silent, and maddening to debug.
--
-- Move the whole probability path to double precision, which is what JavaScript
-- numbers already are.

alter table public.interleave_config
  alter column base_probability    type double precision,
  alter column pressure_multiplier type double precision,
  alter column max_probability     type double precision;

drop function if exists public.due_pressure(uuid);
create function public.due_pressure(p_user_id uuid)
returns double precision
language sql
stable
security invoker
set search_path = ''
as $$
  select least(1.0::double precision, (
    select count(*)::double precision / 20.0
    from public.knowledge_states ks
    where ks.user_id = p_user_id and ks.next_due_at <= now()
  ));
$$;

comment on function public.due_pressure is
  'Recall backlog scaled to 0..1. 20+ due items saturates the term.';

drop function if exists public.dismissal_damping(uuid);
create function public.dismissal_damping(p_user_id uuid)
returns double precision
language sql
stable
security invoker
set search_path = ''
as $$
  with recent as (
    select response
    from public.interrupt_events
    where user_id = p_user_id and response is not null
    order by shown_at desc
    limit 10
  )
  select case
    when (select count(*) from recent) < 3 then 1.0::double precision
    else greatest(0.25::double precision, 1.0 - (
      select count(*)::double precision from recent where response = 'dismissed'
    ) / greatest((select count(*)::double precision from recent), 1.0))
  end;
$$;

comment on function public.dismissal_damping is
  'Multiplier in [0.25, 1.0]. Consistent dismissals lower the interrupt rate.';

create or replace function public.plan_interleave(
  p_user_id      uuid,
  p_seed         bigint,
  p_page         int,
  p_page_size    int,
  p_cards_before int default 0,
  p_used_budget  int default 0
)
returns table (slot_index int, kind public.interrupt_kind)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  cfg          public.interleave_config;
  pref_rate    double precision := 1.0;
  pressure     double precision;
  damping      double precision;
  probability  double precision;
  budget_left  int;
  last_placed  int;
  i            int;
  absolute_pos int;
  draw         double precision;
  pick         double precision;
  chosen       public.interrupt_kind;
  cum          int;
begin
  select * into cfg from public.interleave_config where id;

  select coalesce(pp.interrupt_rate::double precision, 1.0) into pref_rate
  from public.preference_profiles pp where pp.user_id = p_user_id;
  pref_rate := coalesce(pref_rate, 1.0);

  budget_left := greatest(cfg.max_per_session - p_used_budget, 0);
  if budget_left = 0 or pref_rate = 0 then
    return;
  end if;

  pressure := public.due_pressure(p_user_id);
  damping  := public.dismissal_damping(p_user_id);

  probability := least(
    cfg.max_probability,
    (cfg.base_probability + cfg.pressure_multiplier * pressure * 10.0)
      * damping * pref_rate
  );

  last_placed := -1000;

  for i in 0 .. p_page_size - 1 loop
    exit when budget_left <= 0;
    absolute_pos := p_cards_before + i;

    if absolute_pos < cfg.warmup_cards then
      continue;
    end if;
    if absolute_pos - last_placed <= cfg.min_gap_cards then
      continue;
    end if;

    draw := public.seeded_unit(p_seed, p_page, i, 'place');
    if draw >= probability then
      continue;
    end if;

    pick := public.seeded_unit(p_seed, p_page, i, 'kind') * 100.0;
    cum := cfg.weight_recall;
    if pick < cum then
      chosen := 'recall';
    else
      cum := cum + cfg.weight_say_it_back;
      if pick < cum then
        chosen := 'say_it_back';
      else
        cum := cum + cfg.weight_conviction;
        if pick < cum then
          chosen := 'conviction';
        else
          cum := cum + cfg.weight_counterpull;
          if pick < cum then
            chosen := 'counterpull';
          else
            chosen := 'delta_probe';
          end if;
        end if;
      end if;
    end if;

    slot_index := i;
    kind := chosen;
    return next;

    last_placed := absolute_pos;
    budget_left := budget_left - 1;
  end loop;
end;
$$;

comment on function public.plan_interleave is
  'Bounded, seeded plan of question slots for one feed page. Deterministic per (seed, page).';
