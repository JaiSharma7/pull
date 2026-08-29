-- ---------------------------------------------------------------------------
-- The read path. No model ever runs here — ranking, the Delta and the
-- interleave plan are SQL and pgvector arithmetic. See CLAUDE.md law 2.
-- ---------------------------------------------------------------------------

-- How well does this pull match the topics the user asked for?
create or replace function public.topic_affinity(p_work_id uuid, p_weights jsonb)
returns double precision
language sql
stable
parallel safe
set search_path = ''
as $$
  select coalesce(max((p_weights ->> t.slug::text)::double precision * wt.weight), 0.0)
  from public.work_topics wt
  join public.topics t on t.id = wt.topic_id
  where wt.work_id = p_work_id
    and p_weights ? t.slug::text;
$$;

-- The Delta, on one source: how many of its ideas are actually new to you?
--
-- "Known" is deliberately NOT measured against the user's centroid. A centroid
-- over hundreds of ideas drifts toward the mean and starts matching everything,
-- which would silently empty the feed. Instead we ask a precise question: is
-- there a specific idea this user still remembers that is near-identical to
-- this one?
create or replace function public.get_source_delta(p_work_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid       uuid := (select auth.uid());
  total     int;
  known     int;
  minutes   double precision;
begin
  select count(*) into total
  from public.pulls p
  join public.summaries s on s.id = p.summary_id
  where s.work_id = p_work_id and s.status = 'published';

  if uid is null or total = 0 then
    return jsonb_build_object(
      'total', coalesce(total, 0), 'known', 0, 'new', coalesce(total, 0),
      'minutesSaved', 0
    );
  end if;

  with known_ideas as (
    select p2.embedding
    from public.knowledge_states ks
    join public.pulls p2 on p2.id = ks.pull_id
    where ks.user_id = uid
      and p2.embedding is not null
      and public.retrievability(ks.stability, ks.last_seen_at) > 0.7
  ),
  candidates as (
    select p.id, p.embedding, p.estimated_read_seconds,
           exists (
             select 1 from public.knowledge_states ks
             where ks.user_id = uid and ks.pull_id = p.id
               and public.retrievability(ks.stability, ks.last_seen_at) > 0.7
           ) as seen_directly
    from public.pulls p
    join public.summaries s on s.id = p.summary_id
    where s.work_id = p_work_id and s.status = 'published'
  )
  select count(*) filter (where c.seen_directly or c.covered),
         coalesce(sum(c.estimated_read_seconds)
                  filter (where c.seen_directly or c.covered), 0) / 60.0
    into known, minutes
  from (
    select c.*,
           c.embedding is not null and exists (
             select 1 from known_ideas ki
             where (ki.embedding <=> c.embedding) < 0.14
           ) as covered
    from candidates c
  ) c;

  return jsonb_build_object(
    'total', total,
    'known', coalesce(known, 0),
    'new', total - coalesce(known, 0),
    'minutesSaved', round(coalesce(minutes, 0)::numeric, 1)
  );
end;
$$;

comment on function public.get_source_delta is
  'The Delta for one source: "you already know 14 of these 18". No LLM call.';
