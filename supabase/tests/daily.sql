begin;

insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values ('d7110000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
        'daily-one@example.test', '{"provider":"email"}', '{}'),
       ('d7110000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
        'daily-two@example.test', '{"provider":"email"}', '{}');

create temp table daily_fixture as
select p.id, row_number() over (order by p.id) as n from public.pulls p
join public.summaries s on s.id = p.summary_id
where s.status = 'published' and s.visibility = 'public';
grant select on daily_fixture to authenticated;

insert into public.knowledge_states(user_id, pull_id, stability, last_seen_at)
select 'd7110000-0000-4000-8000-000000000001', id, 1,
       case when n <= 2 then now() - interval '10 days' else now() end
from daily_fixture where n <= 3;
insert into public.feed_impressions(user_id, pull_id)
select 'd7110000-0000-4000-8000-000000000001', id from daily_fixture where n = 4;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d7110000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table first_daily as select public.get_daily_pulls((now() at time zone 'UTC')::date) as data;

do $$
declare d jsonb := (select data from first_daily);
begin
  if jsonb_array_length(d->'pulls') <> 5 then raise exception 'Expected five ideas'; end if;
  if (select count(*) from jsonb_array_elements(d->'pulls') p where p->>'reason' = 'fading') <> 2
    then raise exception 'Expected two fading ideas'; end if;
  if exists (select 1 from jsonb_array_elements(d->'pulls') p join daily_fixture f
    on f.id = (p->>'pullId')::uuid where f.n in (3,4))
    then raise exception 'Known and previously seen ideas must stay out'; end if;
  if public.get_daily_pulls((now() at time zone 'UTC')::date) <> d
    then raise exception 'A same-day reload changed the set'; end if;
  begin
    perform public.get_daily_pulls(null);
    raise exception 'Null day accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.get_daily_pulls((now() at time zone 'UTC')::date + 2);
    raise exception 'Arbitrary future date accepted';
  exception when invalid_parameter_value then null; end;
  begin
    delete from public.daily_pull_selections;
    raise exception 'A reader can erase selection history';
  exception when insufficient_privilege then null; end;
end $$;

-- Simulate a day boundary without changing the database clock.
reset role;
update public.daily_pull_selections set day = day - 1
where user_id = 'd7110000-0000-4000-8000-000000000001';
set local role authenticated;
create temp table second_daily as select public.get_daily_pulls((now() at time zone 'UTC')::date) as data;
do $$
begin
  if jsonb_array_length((select data->'pulls' from second_daily)) <> 5 then
    raise exception 'The next day did not fill from unseen ideas'; end if;
  if exists (select 1 from jsonb_array_elements((select data->'pulls' from first_daily)) a
    join jsonb_array_elements((select data->'pulls' from second_daily)) b
    on a->>'pullId' = b->>'pullId') then raise exception 'Repeated yesterday’s idea'; end if;
end $$;

-- Withdrawing a published summary must also withdraw its cached daily entry.
reset role;
update public.summaries set status = 'draft' where id = (
  select summary_id from public.pulls
  where id = (select (data->'pulls'->0->>'pullId')::uuid from second_daily)
);
set local role authenticated;
do $$
begin
  if exists (select 1 from jsonb_array_elements(public.get_daily_pulls((now() at time zone 'UTC')::date)->'pulls') p
    where p->>'pullId' = (select data->'pulls'->0->>'pullId' from second_daily))
    then raise exception 'Unpublished idea leaked through the cache'; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"d7110000-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.daily_pull_selections) then
    raise exception 'Reader two can see reader one’s selections'; end if;
  perform public.get_daily_pulls((now() at time zone 'UTC')::date);
  if exists (select 1 from public.daily_pull_selections where user_id <> auth.uid()) then
    raise exception 'Selection RPC crossed accounts'; end if;
end $$;

reset role;
set local role anon;
do $$
begin
  begin
    perform public.get_daily_pulls((now() at time zone 'UTC')::date);
    raise exception 'Unauthenticated caller created a selection';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
