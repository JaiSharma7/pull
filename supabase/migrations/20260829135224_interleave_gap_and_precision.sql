-- Codex review, two findings on the interleave planner.
--
-- 1. `preference_profiles.interrupt_rate` was left as `real` when the config
--    columns moved to double precision. For a non-default rate such as 0.3, SQL
--    rounds to float4 before widening while TypeScript keeps the float64 it
--    parsed — reintroducing exactly the silent divergence that migration was
--    written to remove.
--
-- 2. The minimum gap was not enforced across a page boundary. `last_placed`
--    reset to the sentinel on every page, so if the previous page placed an
--    interrupt on its final card, slot 0 of the next page was immediately
--    eligible and could place another one card later. The property tests missed
--    this because they only ever planned a single page.
--
--    Fixed by taking the previous absolute interrupt position as a parameter.

alter table public.preference_profiles
  alter column interrupt_rate type double precision;

-- Adding a defaulted parameter creates an overload rather than replacing the
-- function, so drop the old signature explicitly.
drop function if exists public.plan_interleave(uuid, bigint, int, int, int, int);

create or replace function public.plan_interleave(
  p_user_id      uuid,
  p_seed         bigint,
  p_page         int,
  p_page_size    int,
  p_cards_before int default 0,
  p_used_budget  int default 0,
  -- Absolute card position of the last interrupt shown this session, or null if
  -- none. Without it the gap cannot be enforced across pages.
  p_last_placed  int default null
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

  select coalesce(pp.interrupt_rate, 1.0) into pref_rate
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

  -- Carry the previous page's last placement so the gap spans page boundaries.
  -- The sentinel must be far enough back that the first eligible card of a
  -- fresh session is never gap-blocked.
  last_placed := coalesce(p_last_placed, -1000);

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

comment on function public.plan_interleave(uuid, bigint, int, int, int, int, int) is
  'Bounded, seeded plan of question slots for one feed page. Deterministic per (seed, page). p_last_placed carries the minimum gap across page boundaries.';
