-- Local-only 709-idea Delta benchmark. Transaction rolls back.
-- Refuses a database larger than the demo seed before inserting anything.
\set ON_ERROR_STOP on
begin;
do $$
declare
  reader_id uuid := extensions.gen_random_uuid();
  v_work_id uuid;
  v_summary_id uuid;
  seed_embedding extensions.vector(1536);
  needed int;
begin
  if (select count(*) from public.pulls) > 500 then
    raise exception 'Refusing Delta benchmark outside the local demo seed';
  end if;
  select embedding into strict seed_embedding from public.pulls
    where headline like 'Silencing an opinion%';
  needed := 709-(select count(*) from public.pulls);
  if needed < 500 then
    raise exception 'Expected a small local seed, got % ideas', 709-needed;
  end if;
  insert into auth.users
    (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
     created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
  values (reader_id,'00000000-0000-0000-0000-000000000000',
    'authenticated','authenticated','delta-bench@example.test','',
    now(),now(),now(),
    '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb);
  insert into public.works (kind,title,slug,rights_status)
    values ('book','Delta benchmark fixture','delta-benchmark-fixture','public_domain')
    returning id into v_work_id;
  insert into public.summaries
    (work_id,title,status,visibility,published_at)
    values (v_work_id,'Delta benchmark fixture','published','public',now())
    returning id into v_summary_id;
  insert into public.pulls
    (summary_id,ordinal,headline,body,embedding,estimated_read_seconds)
  select v_summary_id,n,'Benchmark claim ' || n,'Public synthetic test claim.',
         seed_embedding,20
  from generate_series(1,needed) n;
  insert into public.knowledge_states
    (user_id,pull_id,stability,last_seen_at)
  select reader_id,p.id,100,now() from public.pulls p
  where p.summary_id=v_summary_id and p.ordinal<=500;
  insert into public.recall_events (user_id,pull_id,kind,grade)
  select reader_id,p.id,'recall','easy' from public.pulls p
  where p.summary_id=v_summary_id and p.ordinal<=500;
  perform set_config('delta.bench_reader',reader_id::text,true);
  perform set_config('delta.bench_work',v_work_id::text,true);
  raise notice 'benchmark catalogue: % public ideas, 500 proven-known ideas',
    (select count(*) from public.pulls p
     join public.summaries s on s.id=p.summary_id
     where s.status='published' and s.visibility='public');
end $$;
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub',current_setting('delta.bench_reader'),'role','authenticated')::text,
  true);
explain (analyze,buffers) select public.get_feed(p_limit:=20,p_seed:=424242,p_page:=0);
explain (analyze,buffers) select public.get_source_delta(
  current_setting('delta.bench_work')::uuid);
do $$
declare
  feed_ms double precision[] := array[]::double precision[];
  source_ms double precision[] := array[]::double precision[];
  started timestamptz;
  i int;
  p50 double precision;
  p95 double precision;
begin
  if current_user <> 'authenticated' then
    raise exception 'benchmark calls must run under authenticated RLS';
  end if;
  for i in 1..10 loop
    started := clock_timestamp();
    perform public.get_feed(p_limit:=20,p_seed:=424242,p_page:=0);
    feed_ms := array_append(feed_ms,
      extract(epoch from (clock_timestamp()-started))*1000.0);
    started := clock_timestamp();
    perform public.get_source_delta(current_setting('delta.bench_work')::uuid);
    source_ms := array_append(source_ms,
      extract(epoch from (clock_timestamp()-started))*1000.0);
  end loop;
  select percentile_cont(0.5) within group (order by x),
         percentile_cont(0.95) within group (order by x)
    into p50,p95 from unnest(feed_ms) x;
  raise notice 'feed 709 ideas / 500 known: 10 calls, p50=% ms, p95=% ms',
    round(p50::numeric,1),round(p95::numeric,1);
  select percentile_cont(0.5) within group (order by x),
         percentile_cont(0.95) within group (order by x)
    into p50,p95 from unnest(source_ms) x;
  raise notice 'source 709 ideas / 500 known: 10 calls, p50=% ms, p95=% ms',
    round(p50::numeric,1),round(p95::numeric,1);
end $$;
rollback;
