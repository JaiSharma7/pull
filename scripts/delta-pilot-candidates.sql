-- Public catalogue candidate pairs for a small two-reviewer pilot.
-- Headline and source title are public generated metadata; no reader data.
with public_ideas as materialized (
  select p.id,p.headline,p.embedding,s.work_id,w.title source_title
  from public.pulls p
  join public.summaries s on s.id=p.summary_id
  join public.works w on w.id=s.work_id
  where s.status='published' and s.visibility='public'
), topic_anchors as (
  select t.slug::text topic,pi.id,
         row_number() over (partition by t.id order by md5(pi.id::text)) rn
  from public_ideas pi
  join public.work_topics wt on wt.work_id=pi.work_id
  join public.topics t on t.id=wt.topic_id
  where t.slug::text in (
    'philosophy','psychology','society','ethics','education',
    'economics','habits','stoicism','biography','evolution',
    'attention','medicine','world-philosophy','mathematics','computation'
  )
), sample as (
  select a.topic,a.id known_pull_id,n.id candidate_pull_id,
         n.distance,'nearest_cross_source'::text retrieval
  from topic_anchors a
  join public_ideas known on known.id=a.id
  cross join lateral (
    select p2.id,
           (p2.embedding OPERATOR(extensions.<=>) known.embedding) distance
    from public_ideas p2
    where p2.id<>a.id and p2.work_id<>known.work_id
      and p2.embedding is not null and known.embedding is not null
    order by p2.embedding OPERATOR(extensions.<=>) known.embedding,p2.id
    limit 1
  ) n
  where a.rn<=2
), legacy_opposition as (
  select 'legacy-opposition'::text topic,pr.from_pull_id known_pull_id,
         pr.to_pull_id candidate_pull_id,
         (k.embedding OPERATOR(extensions.<=>) c.embedding) distance,
         'legacy_opposes'::text retrieval
  from public.pull_relations pr
  join public_ideas k on k.id=pr.from_pull_id
  join public_ideas c on c.id=pr.to_pull_id
  where pr.kind='opposes' and pr.from_pull_id<pr.to_pull_id
)
select x.topic,x.retrieval,x.known_pull_id,x.candidate_pull_id,
       k.headline known_headline,k.source_title known_source,
       c.headline candidate_headline,c.source_title candidate_source,
       round(x.distance::numeric,4) cosine_distance
from (select * from sample union all select * from legacy_opposition) x
join public_ideas k on k.id=x.known_pull_id
join public_ideas c on c.id=x.candidate_pull_id
order by x.topic,x.retrieval,x.known_pull_id;
