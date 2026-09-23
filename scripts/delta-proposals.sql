-- Bounded, resumable proposal backfill for public published ideas.
-- Run with psql against the intended database. Dry-run is the default.
-- Example:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v delta_batch_size=10
--   -v delta_after_id=00000000-0000-0000-0000-000000000000
--   -v delta_dry_run=on -f scripts/delta-proposals.sql
-- Change delta_dry_run to off only after inspecting the dry-run output.
-- Every resulting row is uncertain/proposed and has no read-path effect.
\set ON_ERROR_STOP on
\if :{?delta_batch_size}
\else
\set delta_batch_size 10
\endif
\if :{?delta_after_id}
\else
\set delta_after_id 00000000-0000-0000-0000-000000000000
\endif
\if :{?delta_dry_run}
\else
\set delta_dry_run on
\endif

begin;
with anchors as materialized (
  select p.id, p.embedding, s.work_id
  from public.pulls p
  join public.summaries s on s.id=p.summary_id
  where s.status='published' and s.visibility='public'
    and p.id > :'delta_after_id'::uuid
  order by p.id
  limit least(greatest((:delta_batch_size)::int,1),100)
), neighbors as (
  select a.id candidate_id, n.id neighbor_id
  from anchors a
  cross join lateral (
    select p2.id
    from public.pulls p2
    join public.summaries s2 on s2.id=p2.summary_id
    where s2.status='published' and s2.visibility='public'
      and p2.id<>a.id and p2.embedding is not null
      and a.embedding is not null and s2.work_id<>a.work_id
    order by p2.embedding OPERATOR(extensions.<=>) a.embedding, p2.id
    limit 4
  ) n
  union all
  select a.id, n.id
  from anchors a
  cross join lateral (
    select p2.id
    from public.pulls p2
    join public.summaries s2 on s2.id=p2.summary_id
    where s2.status='published' and s2.visibility='public'
      and p2.id<>a.id and p2.embedding is not null
      and a.embedding is not null and s2.work_id=a.work_id
    order by p2.embedding OPERATOR(extensions.<=>) a.embedding, p2.id
    limit 2
  ) n
), pairs as materialized (
  select distinct least(candidate_id,neighbor_id) a,
                  greatest(candidate_id,neighbor_id) b
  from neighbors
), inserted as (
  insert into public.delta_relations
    (pull_a_id,pull_b_id,kind,status,provenance)
  select a,b,'uncertain','proposed','vector-neighbor-v1'
  from pairs
  on conflict (pull_a_id,pull_b_id) do nothing
  returning pull_a_id,pull_b_id
)
select (select count(*) from anchors) anchors_scanned,
       (select id from anchors order by id desc limit 1) next_after_id,
       (select count(*) from pairs) candidate_pairs,
       (select count(*) from inserted) new_proposals;
select count(*) total_pending_proposals
from public.delta_relations where status='proposed';
\if :delta_dry_run
rollback;
\else
commit;
\endif
