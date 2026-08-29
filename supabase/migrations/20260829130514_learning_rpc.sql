-- Recompute a user's knowledge centroid. Used for ranking (predicted interest),
-- never for the Delta filter — see the note in get_feed.
create or replace function public.refresh_knowledge_vector(p_user_id uuid default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := coalesce(p_user_id, (select auth.uid()));
  vec extensions.vector(1536);
  n   int;
begin
  if uid is null then
    return;
  end if;

  select avg(p.embedding)::extensions.vector(1536), count(*)
    into vec, n
  from public.knowledge_states ks
  join public.pulls p on p.id = ks.pull_id
  where ks.user_id = uid and p.embedding is not null;

  if vec is null then
    delete from public.user_knowledge_vectors where user_id = uid;
    return;
  end if;

  insert into public.user_knowledge_vectors (user_id, embedding, idea_count, updated_at)
  values (uid, vec, coalesce(n, 0), now())
  on conflict (user_id) do update
    set embedding = excluded.embedding,
        idea_count = excluded.idea_count,
        updated_at = now();
end;
$$;

-- Reading a card is itself weak evidence of knowing it. Records history,
-- impression and an initial knowledge state in one call.
create or replace function public.record_read(
  p_pull_id  uuid,
  p_dwell_ms int default null,
  p_position int default 0
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    return;
  end if;

  insert into public.history_events (user_id, kind, pull_id, summary_id, work_id, dwell_ms)
  select uid, 'read', p.id, p.summary_id, s.work_id, p_dwell_ms
  from public.pulls p join public.summaries s on s.id = p.summary_id
  where p.id = p_pull_id;

  insert into public.feed_impressions (user_id, pull_id, position, action)
  values (uid, p_pull_id, p_position, 'opened');

  -- A read starts the memory clock but claims little: stability 1 day, and the
  -- Delta will not treat it as known once that decays.
  insert into public.knowledge_states (user_id, pull_id, acquired_via, last_seen_at, next_due_at)
  values (uid, p_pull_id, 'read', now(), now() + interval '1 day')
  on conflict (user_id, pull_id) do update
    set last_seen_at = now();
end;
$$;

-- Record how the user answered an interleaved question. A dismissal matters as
-- much as an answer: dismissal_damping reads it back and lowers the rate.
create or replace function public.record_interrupt(
  p_pull_id  uuid,
  p_kind     public.interrupt_kind,
  p_slot     int,
  p_response public.interrupt_response,
  p_grade    public.recall_grade default null,
  p_session  uuid default null,
  p_latency  int default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    return;
  end if;

  insert into public.interrupt_events
    (user_id, session_id, pull_id, kind, slot_position, response, grade, latency_ms, responded_at)
  values (uid, p_session, p_pull_id, p_kind, p_slot, p_response, p_grade, p_latency, now());

  if p_response = 'answered' and p_grade is not null then
    perform public.grade_recall(p_pull_id, p_grade);
  end if;

  if p_session is not null then
    update public.session_seeds
       set interrupts_shown = interrupts_shown + 1
     where id = p_session and user_id = uid;
  end if;
end;
$$;

-- The Review queue: what is fading, most-forgotten first.
create or replace function public.get_due_reviews(p_limit int default 20)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  res jsonb;
begin
  if uid is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(t order by t ->> 'retrievability'), '[]'::jsonb) into res
  from (
    select jsonb_build_object(
      'pullId', p.id,
      'headline', p.headline,
      'body', p.body,
      'whyItMatters', p.why_it_matters,
      'workTitle', w.title,
      'workSlug', w.slug,
      'retrievability', round(public.retrievability(ks.stability, ks.last_seen_at)::numeric, 3),
      'stability', round(ks.stability::numeric, 2),
      'reps', ks.reps,
      'dueAt', ks.next_due_at,
      'question', (
        select q.prompt from public.quiz_questions q
        where q.pull_id = p.id limit 1
      )
    ) as t
    from public.knowledge_states ks
    join public.pulls p on p.id = ks.pull_id
    join public.summaries s on s.id = p.summary_id
    join public.works w on w.id = s.work_id
    where ks.user_id = uid and ks.next_due_at <= now()
    order by public.retrievability(ks.stability, ks.last_seen_at) asc
    limit p_limit
  ) x;

  return res;
end;
$$;

-- Conviction Ledger: record a stance, superseding the previous one rather than
-- overwriting it, so belief change stays queryable.
create or replace function public.set_conviction(
  p_pull_id   uuid,
  p_stance    public.stance,
  p_confidence real default 0.6,
  p_rationale text default null
)
returns public.convictions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid    uuid := (select auth.uid());
  fresh  public.convictions;
  prior  uuid;
begin
  if uid is null then
    raise exception 'set_conviction requires an authenticated user';
  end if;

  select id into prior
  from public.convictions
  where user_id = uid and pull_id = p_pull_id and superseded_by is null;

  -- Insert first, then point the old row at it: the partial unique index allows
  -- only one un-superseded stance per pull, so the order matters.
  if prior is not null then
    update public.convictions set superseded_by = id where id = prior;
  end if;

  insert into public.convictions (user_id, pull_id, stance, confidence, rationale)
  values (uid, p_pull_id, p_stance, p_confidence, p_rationale)
  returning * into fresh;

  if prior is not null then
    update public.convictions set superseded_by = fresh.id where id = prior;
  end if;

  return fresh;
end;
$$;
