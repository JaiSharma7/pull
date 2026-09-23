-- Aggregate-only Delta catalogue audit. Safe to run on the linked project.
-- No reader text, credentials, idea bodies, or individual private rows leave DB.
with public_ideas as (
  select p.id, p.embedding, p.summary_id, s.work_id
  from public.pulls p join public.summaries s on s.id=p.summary_id
  where s.status='published' and s.visibility='public'
)
select count(distinct pi.work_id) as published_public_sources,
       count(distinct pi.id) as published_public_ideas,
       count(distinct wt.topic_id) as represented_topics,
       count(distinct pi.id) filter (where embedding is not null) as embedded_ideas,
       count(distinct pi.id) filter (where embedding is null) as missing_embeddings
from public_ideas pi
left join public.work_topics wt on wt.work_id=pi.work_id;

with public_ideas as (
  select p.id, p.embedding, p.summary_id
  from public.pulls p join public.summaries s on s.id=p.summary_id
  where s.status='published' and s.visibility='public'
)
select case when exists(select 1 from public.generation_jobs j
                        where j.summary_id=pi.summary_id)
            then 'generation_job_linked' else 'no_generation_job_link' end
         as provenance_proxy,
       count(*) as ideas,
       count(*) filter (where embedding is not null) as embedded,
       count(*) filter (where embedding is null) as missing_embedding
from public_ideas pi group by 1 order by 1;

with public_ideas as (
  select p.id from public.pulls p join public.summaries s on s.id=p.summary_id
  where s.status='published' and s.visibility='public'
), edges as (
  select distinct pr.kind::text kind,
         least(pr.from_pull_id,pr.to_pull_id) a,
         greatest(pr.from_pull_id,pr.to_pull_id) b
  from public.pull_relations pr
  join public_ideas x on x.id=pr.from_pull_id
  join public_ideas y on y.id=pr.to_pull_id
)
select kind,count(*) as unordered_public_pairs from edges group by kind order by kind;

with per_source as (
  select s.work_id,count(*)::int ideas
  from public.pulls p join public.summaries s on s.id=p.summary_id
  where s.status='published' and s.visibility='public'
  group by s.work_id
)
select count(*) sources, min(ideas) min_ideas,
       percentile_cont(0.25) within group (order by ideas) p25_ideas,
       percentile_cont(0.5) within group (order by ideas) median_ideas,
       percentile_cont(0.75) within group (order by ideas) p75_ideas,
       max(ideas) max_ideas
from per_source;

with public_ideas as (
  select p.id,s.work_id from public.pulls p
  join public.summaries s on s.id=p.summary_id
  where s.status='published' and s.visibility='public'
)
select t.slug::text topic,count(distinct pi.id) ideas,
       count(distinct pi.work_id) sources
from public.topics t
join public.work_topics wt on wt.topic_id=t.id
join public_ideas pi on pi.work_id=wt.work_id
group by t.slug order by ideas desc, topic;

with public_ideas as (
  select p.id,s.work_id from public.pulls p
  join public.summaries s on s.id=p.summary_id
  where s.status='published' and s.visibility='public'
), edges as (
  select distinct pr.kind::text kind,
         least(pr.from_pull_id,pr.to_pull_id) a,
         greatest(pr.from_pull_id,pr.to_pull_id) b
  from public.pull_relations pr
  join public_ideas x on x.id=pr.from_pull_id
  join public_ideas y on y.id=pr.to_pull_id
)
select t.slug::text topic,e.kind,count(distinct (e.a,e.b)) unordered_pairs
from edges e
join public_ideas pi on pi.id in (e.a,e.b)
join public.work_topics wt on wt.work_id=pi.work_id
join public.topics t on t.id=wt.topic_id
group by t.slug,e.kind order by t.slug,e.kind;

with public_ideas as (
  select p.id,p.summary_id,s.work_id from public.pulls p
  join public.summaries s on s.id=p.summary_id
  where s.status='published' and s.visibility='public'
)
select count(*) filter (where w.source_url is null) ideas_without_source_url,
       count(distinct pi.work_id) filter (where w.source_url is null) sources_without_source_url,
       count(*) filter (where not exists(
         select 1 from public.citation_anchors ca where ca.pull_id=pi.id
       )) ideas_without_citation_anchor,
       count(*) filter (where not exists(
         select 1 from public.work_topics wt where wt.work_id=pi.work_id
       )) ideas_without_topic
from public_ideas pi join public.works w on w.id=pi.work_id;

select operation,count(*) calls,round(avg(cost_cents),4) avg_cents,
       round((percentile_cont(0.5) within group (order by cost_cents))::numeric,4) median_cents,
       round((percentile_cont(0.95) within group (order by cost_cents))::numeric,4) p95_cents,
       round(sum(cost_cents),4) total_cents
from public.cost_ledger group by operation order by operation;
