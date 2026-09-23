-- An event recorded before stability_after existed cannot prove durable recall.
-- Current state may have grown through calibration after that event; using it
-- would revive an old success without a new recall attempt.
create or replace function public.delta_has_evidence(p_pull_id uuid)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select coalesce((
    select ((re.kind in ('review', 'recall', 'say_it_back')
               and re.grade in ('good', 'easy'))
         or (re.kind = 'delta_probe' and re.grade = 'easy'))
      and re.stability_after is not null
      and public.retrievability(re.stability_after,
            least(ks.last_seen_at,
                  least(coalesce(re.submitted_at, re.applied_at), re.applied_at)))
          > public.known_retrievability_floor()
      and not exists (
        select 1 from public.recall_events failed
        where failed.user_id = re.user_id and failed.pull_id = re.pull_id
          and failed.kind in ('review', 'recall', 'say_it_back', 'delta_probe')
          and failed.grade in ('forgot', 'hard')
          and failed.applied_at <= re.applied_at
          and failed.applied_at >= least(
            coalesce(re.submitted_at, re.applied_at), re.applied_at)
      )
    from public.recall_events re
    join public.knowledge_states ks on ks.user_id = re.user_id and ks.pull_id = re.pull_id
    where re.user_id = (select auth.uid()) and re.pull_id = p_pull_id
      and re.kind in ('review', 'recall', 'say_it_back', 'delta_probe')
    -- Server application order makes a new failure authoritative even if its
    -- client clock is backdated. A delayed offline success cannot erase a
    -- failure applied after that success was submitted. Clock skew causes
    -- conservative undercoverage rather than false suppression.
    order by re.applied_at desc, re.id desc
    limit 1
  ), false)
$$;
comment on function public.delta_has_evidence(uuid) is
  'Latest server-applied retrieval or Already knew it evidence, vetoed by failures applied after submission. Legacy events without recorded stability remain unverified.';
