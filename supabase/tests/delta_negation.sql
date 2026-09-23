-- The Delta treats knowledge as evidence, not exposure. All assertions execute
-- as authenticated readers under real RLS; the transaction rolls back.
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.assert_reader() returns void language plpgsql as $$
begin
  if current_user <> 'authenticated' then
    raise exception 'Delta assertions require authenticated RLS, got %', current_user;
  end if;
end $$;
create or replace function pg_temp.must(ok boolean, message text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception '%', message; end if;
end $$;

do $$
declare
  reader_a uuid := extensions.gen_random_uuid();
  reader_b uuid := extensions.gen_random_uuid();
  signup uuid;
  mill uuid;
  opposite uuid;
  paraphrase uuid;
  private_pull uuid;
  private_summary uuid;
  public_summary uuid;
  on_liberty uuid;
  walden uuid;
  feed jsonb;
  delta jsonb;
  before_feed jsonb;
  pair_a uuid;
  pair_b uuid;
  score_blank numeric;
  score_a numeric;
  expected_minutes numeric;
  cap_work uuid;
  cap_summary uuid;
  cap_candidate uuid;
  known_in uuid;
  known_out uuid;
  boundary_seconds double precision;
  tie_work uuid;
  tie_summary uuid;
  tie_hi uuid := 'ffffffff-ffff-4fff-8fff-fffffffffff1';
  tie_lo uuid := '11111111-1111-4111-8111-111111111111';
  tie_hi_pos bigint;
  tie_lo_pos bigint;
begin
  perform pg_temp.must(has_table_privilege('anon','public.delta_relations','SELECT')
    and has_table_privilege('authenticated','public.delta_relations','SELECT'),
    'reader roles need approved relation SELECT access');
  perform pg_temp.must(not has_table_privilege('anon','public.delta_relations','TRUNCATE')
    and not has_table_privilege('authenticated','public.delta_relations','TRUNCATE'),
    'reader roles must not be able to bypass RLS with TRUNCATE');
  perform pg_temp.must(not has_table_privilege('authenticated','public.delta_relations','INSERT')
    and not has_table_privilege('authenticated','public.delta_relations','UPDATE')
    and not has_table_privilege('authenticated','public.delta_relations','DELETE')
    and not has_table_privilege('anon','public.delta_relations','INSERT'),
    'relation review writes must remain owner-only');
  if (select count(*) from public.pulls) > 500 then
    raise exception 'Delta test only runs against the local seed corpus';
  end if;
  select p.id into strict mill from public.pulls p
    where p.headline like 'Silencing an opinion%';
  select p.id into strict opposite from public.pulls p
    where p.headline like 'Living deliberately%';
  select p.id into strict paraphrase from public.pulls p
    where p.headline like 'An unchallenged truth%';
  select id into strict on_liberty from public.works where slug = 'on-liberty';
  select summary_id into strict public_summary from public.pulls where id=mill;
  select id into strict walden from public.works where slug = 'walden';

  foreach signup in array array[reader_a,reader_b] loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    values (signup, '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      'delta-' || left(signup::text,8) || '@example.test', '',
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  end loop;

  -- Make a real opposition closer than any paraphrase. Vector distance alone
  -- must never hide it, even if its authored edge goes missing.
  update public.pulls set embedding = (select embedding from public.pulls where id = mill)
    where id in (opposite, paraphrase);
  delete from public.pulls p using public.summaries s
    where p.summary_id = s.id and s.work_id = walden and p.id <> opposite;

  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  perform public.record_read(mill);
  perform pg_temp.must(
    exists(select 1 from public.knowledge_states where user_id=reader_a and pull_id=mill),
    'reading should still start a knowledge state');
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=0,
    'reading without recall must not count as known');
  -- Pre-outcome legacy events have no recorded stability. Current state can
  -- grow later through calibration, so such an event cannot prove knowledge.
  perform set_config('role','postgres',true);
  insert into public.recall_events (user_id,pull_id,kind,grade)
    values (reader_a,mill,'recall','easy');
  update public.knowledge_states set stability=100,last_seen_at=now()
    where user_id=reader_a and pull_id=mill;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=0,
    'legacy recall without recorded stability must remain unverified');
  -- A client clock in the future must not outrank a later failed attempt.
  perform public.grade_recall(mill,'easy',p_kind:='recall',
    p_submitted_at:=now() + interval '1 year');

  perform set_config('role','postgres',true);
  update public.knowledge_states set stability=100,last_seen_at=now()
    where user_id=reader_a and pull_id=mill;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=1,
    'successful recall must make the directly recalled idea known');
  delta := public.get_source_delta(walden);
  perform pg_temp.must((delta->>'known')::int=0 and (delta->>'new')::int=1,
    'near-identical contradiction must remain unverified on its source');
  feed := public.get_feed(p_limit:=100,p_seed:=424242,p_page:=0);
  perform pg_temp.must(exists(
    select 1 from jsonb_array_elements(feed->'rows') row
    where (row->>'id')::uuid=opposite),
    'near-identical contradiction must be visible in feed');
  before_feed := feed;
  feed := public.get_feed(p_limit:=100,p_seed:=424242,p_page:=0);
  perform pg_temp.must(feed=before_feed,'identical feed requests must be stable');

  -- Equal-score cards must have a stable ID order regardless of heap order.
  perform set_config('role','postgres',true);
  insert into public.works (kind,title,slug,rights_status)
    values ('essay','Tie high','delta-tie-high','public_domain') returning id into tie_work;
  insert into public.summaries (work_id,title,status,visibility,published_at)
    values (tie_work,'Tie high','published','public',now()) returning id into tie_summary;
  insert into public.pulls (id,summary_id,ordinal,headline,body,estimated_read_seconds)
    values (tie_hi,tie_summary,1,'Tie high','Stable sorting fixture.',20);
  insert into public.works (kind,title,slug,rights_status)
    values ('essay','Tie low','delta-tie-low','public_domain') returning id into tie_work;
  insert into public.summaries (work_id,title,status,visibility,published_at)
    values (tie_work,'Tie low','published','public',now()) returning id into tie_summary;
  insert into public.pulls (id,summary_id,ordinal,headline,body,estimated_read_seconds)
    values (tie_lo,tie_summary,1,'Tie low','Stable sorting fixture.',20);
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  perform set_config('enable_indexscan','off',true);
  perform set_config('enable_bitmapscan','off',true);
  feed := public.get_feed(p_limit:=100,p_seed:=424242,p_page:=0);
  select ord into tie_hi_pos from jsonb_array_elements(feed->'rows') with ordinality r(row,ord)
    where (row->>'id')::uuid=tie_hi;
  select ord into tie_lo_pos from jsonb_array_elements(feed->'rows') with ordinality r(row,ord)
    where (row->>'id')::uuid=tie_lo;
  perform pg_temp.must(tie_lo_pos is not null and tie_hi_pos is not null and tie_lo_pos<tie_hi_pos,
    'equal-score feed cards must use pull ID as a deterministic tie-break');
  perform set_config('enable_indexscan','on',true);
  perform set_config('enable_bitmapscan','on',true);

  -- Server application order wins over an inaccurate client clock. A delayed
  -- offline success submitted before a failure cannot erase that failure.
  perform public.grade_recall(mill,'hard',p_kind:='recall',
    p_submitted_at:=now()-interval '1 year');
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=0,
    'newly applied backdated failure must revoke earlier recall proof');
  perform public.grade_recall(mill,'easy',p_kind:='recall',
    p_submitted_at:=now()-interval '1 year');
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=0,
    'late offline success submitted before failure must not revive proof');
  perform public.grade_recall(mill,'easy',p_kind:='recall');
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=1,
    'a fresh success after failure must restore proof');

  -- Each storage direction of one opposition protects ranking independently.
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_b,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  feed := public.get_feed(p_limit:=100,p_seed:=424242,p_page:=0);
  select (row->>'score')::numeric into strict score_blank
    from jsonb_array_elements(feed->'rows') row
    where (row->>'id')::uuid=opposite;
  perform set_config('role','postgres',true);
  delete from public.pull_relations
    where from_pull_id=mill and to_pull_id=opposite and kind='opposes';
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  feed := public.get_feed(p_limit:=100,p_seed:=424242,p_page:=0);
  select (row->>'score')::numeric into strict score_a
    from jsonb_array_elements(feed->'rows') row
    where (row->>'id')::uuid=opposite;
  perform pg_temp.must(score_a=score_blank,
    'known-to-candidate one-direction opposition must protect ranking');

  perform set_config('role','postgres',true);
  insert into public.pull_relations (from_pull_id,to_pull_id,kind,weight)
    values (mill,opposite,'opposes',0.75) on conflict do nothing;
  delete from public.pull_relations
    where from_pull_id=opposite and to_pull_id=mill and kind='opposes';
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  feed := public.get_feed(p_limit:=100,p_seed:=424242,p_page:=0);
  select (row->>'score')::numeric into strict score_a
    from jsonb_array_elements(feed->'rows') row
    where (row->>'id')::uuid=opposite;
  perform pg_temp.must(score_a=score_blank,
    'candidate-to-known one-direction opposition must protect ranking');
  perform set_config('role','postgres',true);
  insert into public.pull_relations (from_pull_id,to_pull_id,kind,weight)
    values (opposite,mill,'opposes',0.75) on conflict do nothing;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();

  -- A candidate at distance zero stays visible until a reviewed equivalent
  -- relationship exists. A proposal is never suppression evidence.
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=1,
    'vector-identical paraphrase without a relation must not be suppressed');
  pair_a := least(mill,paraphrase);
  pair_b := greatest(mill,paraphrase);
  perform set_config('role','postgres',true);
  insert into public.delta_relations
    (pull_a_id,pull_b_id,kind,status,evidence,provenance,confidence,updated_at)
  values (pair_a,pair_b,'equivalent','proposed',
    'Reviewed wording required before activation','test',0.9,now()-interval '1 day');
  insert into public.delta_relations
    (pull_a_id,pull_b_id,kind,status,evidence,provenance)
  values (least(mill,opposite),greatest(mill,opposite),
    'elaborates','proposed','Direction requires a schema field','test');
  begin
    update public.delta_relations set status='approved',reviewed_at=now(),
      reviewer_refs=array['test reviewer A','test reviewer B']
      where pull_a_id=least(mill,opposite) and pull_b_id=greatest(mill,opposite);
    raise exception 'directionless elaboration was approved';
  exception when check_violation then null;
  end;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  perform pg_temp.must(not exists (
    select 1 from public.delta_relations where pull_a_id=pair_a and pull_b_id=pair_b),
    'unapproved relation proposal must stay private');
  begin
    insert into public.delta_relations (pull_a_id,pull_b_id,kind,provenance)
      values (least(mill,opposite),greatest(mill,opposite),'equivalent','client');
    raise exception 'reader inserted an unreviewed relation';
  exception when insufficient_privilege then null;
  end;
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=1,
    'proposed equivalence must not suppress');
  perform set_config('role','postgres',true);
  begin
    update public.delta_relations set status='approved', reviewed_at=now(),
      reviewer_refs=array['same reviewer','same reviewer']
      where pull_a_id=pair_a and pull_b_id=pair_b;
    raise exception 'duplicate reviewer references were accepted';
  exception when check_violation then null;
  end;
  update public.delta_relations set status='approved',reviewed_at=now(),reviewer_refs=array['test reviewer A','test reviewer B']
    where pull_a_id=pair_a and pull_b_id=pair_b;
  perform pg_temp.must(
    (select updated_at > now()-interval '1 hour' from public.delta_relations
      where pull_a_id=pair_a and pull_b_id=pair_b),
    'review updates must refresh relation updated_at');
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=2,
    'approved equivalence must suppress the paraphrase');
  perform pg_temp.must((delta->>'total')::int=4 and (delta->>'new')::int=2
    and (delta->>'minutesSaved')::numeric=1.1,
    'Source display contract must report 2 of 4 matched and 1.1 estimated minutes');
  -- The displayed feed fields count the bounded candidate search, not the
  -- returned cards. Remove the read impression so the direct idea is eligible.
  perform set_config('role','postgres',true);
  delete from public.feed_impressions where user_id=reader_a and pull_id=mill;
  select round((sum(estimated_read_seconds)/60.0)::numeric,1)
    into expected_minutes from public.pulls where id in (mill,paraphrase);
  perform pg_temp.must(expected_minutes=1.1,
    'Feed display contract seed minutes changed; update the rendered-copy fixture');
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  feed := public.get_feed(p_limit:=100,p_seed:=424242,p_page:=0);
  perform pg_temp.must((feed->>'skippedKnownCount')::int=2,
    'displayed matched count must be direct pool match plus approved shortlist match');
  perform pg_temp.must((feed->>'minutesSaved')::numeric=expected_minutes,
    'displayed estimated minutes must sum the same two matches');
  perform pg_temp.must(not exists(
    select 1 from jsonb_array_elements(feed->'rows') row
    where (row->>'id')::uuid=paraphrase),
    'feed and source must agree on approved equivalence');

  -- A reviewed equivalence remains valid even if its candidate has no vector.
  perform set_config('role','postgres',true);
  update public.pulls set embedding=null where id=paraphrase;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=2,
    'approved equivalence must work without a candidate embedding');

  -- A later failed recall revokes evidence even while stability is high.
  perform public.grade_recall(mill,'forgot',p_kind:='recall');
  perform set_config('role','postgres',true);
  update public.knowledge_states set stability=100,last_seen_at=now()
    where user_id=reader_a and pull_id=mill;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=0,
    'failed recall must revoke direct and equivalent suppression');
  perform public.grade_recall(mill,'easy',p_kind:='delta_probe');
  perform set_config('role','postgres',true);
  update public.knowledge_states set stability=100,last_seen_at=now()
    where user_id=reader_a and pull_id=mill;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=2,
    'explicit Already knew it should restore evidence');

  -- Knowing both sides directly wins over their opposition.
  perform public.grade_recall(opposite,'easy',p_kind:='recall');
  perform set_config('role','postgres',true);
  update public.knowledge_states set stability=100,last_seen_at=now()
    where user_id=reader_a and pull_id=opposite;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(walden);
  perform pg_temp.must((delta->>'known')::int=1,
    'direct knowledge of both sides must retain the second side');

  -- A reviewed but disabled equivalence no longer suppresses.
  perform set_config('role','postgres',true);
  update public.delta_relations set status='disabled',review_note='bad edge'
    where pull_a_id=pair_a and pull_b_id=pair_b;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=1,
    'disabling a bad equivalence must immediately restore the idea');

  -- Another reader's private pull and approved relation must be invisible.
  perform set_config('role','postgres',true);
  insert into public.summaries
    (work_id,title,status,visibility,author_id,published_at,version)
  values (on_liberty,'Private claim','published','private',reader_a,now(),999)
  returning id into private_summary;
  insert into public.pulls (summary_id,ordinal,headline,body,embedding)
    select private_summary,1,'Private claim','Reader A only',embedding
    from public.pulls where id=mill
    returning id into private_pull;
  insert into public.knowledge_states (user_id,pull_id,stability,last_seen_at)
    values (reader_b,private_pull,100,now());
  insert into public.recall_events (user_id,pull_id,kind,grade)
    values (reader_b,private_pull,'recall','easy');
  insert into public.delta_relations
    (pull_a_id,pull_b_id,kind,status,evidence,provenance,reviewed_at,reviewer_refs)
    values (least(private_pull,mill),greatest(private_pull,mill),
      'equivalent','approved','Private fixture','test',now(),array['test reviewer A','test reviewer B']);
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_b,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  perform pg_temp.must(not exists(
    select 1 from public.delta_relations
    where pull_a_id=least(private_pull,mill) and pull_b_id=greatest(private_pull,mill)),
    'private relation leaked across reader RLS');
  perform pg_temp.must(not exists(select 1 from public.pulls where id=private_pull),
    'private pull leaked across reader RLS');
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=0,
    'another reader private evidence must not suppress public ideas');
  feed := public.get_feed(p_limit:=100,p_seed:=424242,p_page:=0);
  perform pg_temp.must(exists(
    select 1 from jsonb_array_elements(feed->'rows') row
    where (row->>'id')::uuid=opposite),
    'another reader private evidence must not affect feed');

  -- The Source page shows one selected summary; the Library work count spans
  -- all readable published versions, including this reader's own private one.
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_summary_delta(public_summary);
  perform pg_temp.must((delta->>'total')::int=4,
    'selected summary Delta must match the visible Source page idea list');
  delta := public.get_summary_delta(private_summary);
  perform pg_temp.must((delta->>'total')::int=1,
    'private summary Delta must be readable to its own author');
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'total')::int=5,
    'work-wide Delta should still count the readable private version');
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_b,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_summary_delta(private_summary);
  perform pg_temp.must((delta->>'total')::int=0,
    'private summary Delta must be invisible to another reader');

  -- The strict retrievability floor is shared by direct and semantic
  -- decisions. Keep the test a minute either side of the computed boundary
  -- so timestamp precision cannot decide it accidentally.
  perform public.grade_recall(mill,'easy',p_kind:='recall');
  boundary_seconds := ln(public.known_retrievability_floor()) / ln(0.9) * 86400;
  perform set_config('role','postgres',true);
  update public.knowledge_states set stability=1,
    last_seen_at=now()-make_interval(secs=>boundary_seconds+60)
    where user_id=reader_b and pull_id=mill;
  update public.recall_events set applied_at=now()-make_interval(secs=>boundary_seconds+60), stability_after=1
    where user_id=reader_b and pull_id=mill and kind='recall';
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_b,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=0,
    'just below retrievability floor must not count direct knowledge');
  perform public.record_read(mill);
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=0,
    'reading must not revive an expired recall without a new attempt');
  perform public.grade_recall(mill,'easy',p_kind:='calibration');
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=0,
    'calibration must not extend expired recall proof');
  perform set_config('role','postgres',true);
  update public.knowledge_states set
    last_seen_at=now()-make_interval(secs=>boundary_seconds-60)
    where user_id=reader_b and pull_id=mill;
  update public.recall_events set applied_at=now()-make_interval(secs=>boundary_seconds-60)
    where user_id=reader_b and pull_id=mill and kind='recall';
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_b,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(on_liberty);
  perform pg_temp.must((delta->>'known')::int=1,
    'just above retrievability floor must count direct knowledge');

  -- Build enough proven facts to cross the exact 500-idea semantic cap.
  -- Direct facts remain known even outside it; an equivalent candidate only
  -- matches when at least one endpoint survives the deterministic cap.
  -- Keep these vectors null: hundreds of rolled-back HNSW entries starve
  -- the later search fixture's approximate nearest-neighbor scan.
  perform set_config('role','postgres',true);
  insert into public.works (kind,title,slug,rights_status)
    values ('book','Delta cap fixture','delta-cap-fixture','public_domain')
    returning id into cap_work;
  insert into public.summaries
    (work_id,title,status,visibility,published_at)
    values (cap_work,'Delta cap fixture','published','public',now())
    returning id into cap_summary;
  insert into public.pulls
    (summary_id,ordinal,headline,body,embedding,estimated_read_seconds)
  select cap_summary,n,'Cap fact ' || n,'Public fixture fact.',
         null,20
  from generate_series(1,502) n;
  select id into strict cap_candidate from public.pulls
    where summary_id=cap_summary and ordinal=502;
  insert into public.knowledge_states
    (user_id,pull_id,stability,last_seen_at)
  select reader_a,id,100,now() from public.pulls
    where summary_id=cap_summary and ordinal<=501;
  insert into public.recall_events (user_id,pull_id,kind,grade,stability_after)
  select reader_a,id,'recall','easy',100 from public.pulls
    where summary_id=cap_summary and ordinal<=501;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  select pull_id into strict known_in from (
    select ks.pull_id,row_number() over (
      order by public.retrievability(ks.stability,ks.last_seen_at) desc,ks.pull_id
    ) rn from public.knowledge_states ks
    where ks.user_id=reader_a
      and public.retrievability(ks.stability,ks.last_seen_at)
        > public.known_retrievability_floor()
      and public.delta_has_evidence(ks.pull_id)
  ) ranked where rn=500;
  select pull_id into strict known_out from (
    select ks.pull_id,row_number() over (
      order by public.retrievability(ks.stability,ks.last_seen_at) desc,ks.pull_id
    ) rn from public.knowledge_states ks
    where ks.user_id=reader_a
      and public.retrievability(ks.stability,ks.last_seen_at)
        > public.known_retrievability_floor()
      and public.delta_has_evidence(ks.pull_id)
  ) ranked where rn=501;
  perform set_config('role','postgres',true);
  insert into public.delta_relations
    (pull_a_id,pull_b_id,kind,status,evidence,provenance,reviewed_at,reviewer_refs)
    values (least(known_out,cap_candidate),greatest(known_out,cap_candidate),
      'equivalent','approved','Cap boundary fixture','test',now(),
      array['test reviewer A','test reviewer B']);
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(cap_work);
  perform pg_temp.must((delta->>'known')::int=501,
    'equivalent edge to fact 501 must not pass the 500-idea cap');
  perform set_config('role','postgres',true);
  insert into public.delta_relations
    (pull_a_id,pull_b_id,kind,status,evidence,provenance,reviewed_at,reviewer_refs)
    values (least(known_in,cap_candidate),greatest(known_in,cap_candidate),
      'equivalent','approved','Cap boundary fixture','test',now(),
      array['test reviewer A','test reviewer B']);
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',
    json_build_object('sub',reader_a,'role','authenticated')::text,true);
  perform pg_temp.assert_reader();
  delta := public.get_source_delta(cap_work);
  perform pg_temp.must((delta->>'known')::int=502,
    'equivalent edge to fact 500 must pass the deterministic cap');

  raise notice 'Delta evidence, equivalence review, opposition and private RLS passed';
end $$;
rollback;
