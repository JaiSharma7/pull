create or replace function public.summary_is_readable(s public.summaries)
returns boolean
language sql
stable
parallel safe
security invoker
set search_path = ''
as $$
  select (s.status = 'published' and s.visibility = 'public')
      or (s.author_id is not null and s.author_id = (select auth.uid()));
$$;

alter table public.profiles enable row level security;
create policy profiles_read_all on public.profiles for select using (true);
create policy profiles_write_own on public.profiles
  for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles
  for insert with check ((select auth.uid()) = id);

alter table public.preference_profiles enable row level security;
create policy preference_profiles_own on public.preference_profiles
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.follows enable row level security;
create policy follows_read_all on public.follows for select using (true);
create policy follows_write_own on public.follows
  for all using ((select auth.uid()) = follower_id)
  with check ((select auth.uid()) = follower_id);

alter table public.works enable row level security;
create policy works_read_all on public.works for select using (true);

alter table public.editions enable row level security;
create policy editions_read_all on public.editions for select using (true);

alter table public.contributors enable row level security;
create policy contributors_read_all on public.contributors for select using (true);

alter table public.work_contributors enable row level security;
create policy work_contributors_read_all on public.work_contributors for select using (true);

alter table public.topics enable row level security;
create policy topics_read_all on public.topics for select using (true);

alter table public.work_topics enable row level security;
create policy work_topics_read_all on public.work_topics for select using (true);

alter table public.summaries enable row level security;
create policy summaries_read_published on public.summaries
  for select using (public.summary_is_readable(summaries));
create policy summaries_author_write on public.summaries
  for all using ((select auth.uid()) = author_id)
  with check ((select auth.uid()) = author_id);

alter table public.pulls enable row level security;
create policy pulls_read_via_summary on public.pulls
  for select using (
    exists (
      select 1 from public.summaries s
      where s.id = pulls.summary_id and public.summary_is_readable(s)
    )
  );

alter table public.citation_anchors enable row level security;
create policy citation_anchors_read on public.citation_anchors
  for select using (
    exists (
      select 1 from public.pulls p
      join public.summaries s on s.id = p.summary_id
      where p.id = citation_anchors.pull_id and public.summary_is_readable(s)
    )
  );

alter table public.pull_relations enable row level security;
create policy pull_relations_read_all on public.pull_relations for select using (true);

alter table public.quiz_questions enable row level security;
create policy quiz_questions_read on public.quiz_questions
  for select using (
    exists (
      select 1 from public.pulls p
      join public.summaries s on s.id = p.summary_id
      where p.id = quiz_questions.pull_id and public.summary_is_readable(s)
    )
  );

alter table public.artworks enable row level security;
create policy artworks_read_all on public.artworks for select using (true);

alter table public.stashes enable row level security;
create policy stashes_read on public.stashes
  for select using (visibility = 'public' or (select auth.uid()) = user_id);
create policy stashes_write_own on public.stashes
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.saved_items enable row level security;
create policy saved_items_own on public.saved_items
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.notes enable row level security;
create policy notes_read on public.notes
  for select using (visibility = 'public' or (select auth.uid()) = user_id);
create policy notes_write_own on public.notes
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.highlights enable row level security;
create policy highlights_own on public.highlights
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.history_events enable row level security;
create policy history_events_own on public.history_events
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.progress enable row level security;
create policy progress_own on public.progress
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.knowledge_states enable row level security;
create policy knowledge_states_own on public.knowledge_states
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.user_knowledge_vectors enable row level security;
create policy user_knowledge_vectors_own on public.user_knowledge_vectors
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.convictions enable row level security;
create policy convictions_own on public.convictions
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.explanations enable row level security;
create policy explanations_own on public.explanations
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.session_seeds enable row level security;
create policy session_seeds_own on public.session_seeds
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.interrupt_events enable row level security;
create policy interrupt_events_own on public.interrupt_events
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.interleave_config enable row level security;
create policy interleave_config_read on public.interleave_config for select using (true);

alter table public.feed_recipes enable row level security;
create policy feed_recipes_read on public.feed_recipes
  for select using (is_public or (select auth.uid()) = user_id);
create policy feed_recipes_write_own on public.feed_recipes
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.feed_impressions enable row level security;
create policy feed_impressions_own on public.feed_impressions
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.daily_pulls enable row level security;
create policy daily_pulls_read_all on public.daily_pulls for select using (true);

alter table public.generation_jobs enable row level security;
create policy generation_jobs_own on public.generation_jobs
  for select using ((select auth.uid()) = requester_id);
create policy generation_jobs_insert_own on public.generation_jobs
  for insert with check ((select auth.uid()) = requester_id);

alter table public.job_steps enable row level security;
create policy job_steps_own on public.job_steps
  for select using (
    exists (
      select 1 from public.generation_jobs j
      where j.id = job_steps.job_id and j.requester_id = (select auth.uid())
    )
  );

alter table public.cost_ledger enable row level security;
create policy cost_ledger_no_api_access on public.cost_ledger for select using (false);

alter table public.rate_limits enable row level security;
create policy rate_limits_own on public.rate_limits
  for select using ((select auth.uid()) = user_id);

alter table public.reports enable row level security;
create policy reports_own on public.reports
  for select using ((select auth.uid()) = reporter_id);
create policy reports_insert_own on public.reports
  for insert with check ((select auth.uid()) = reporter_id);

alter table public.moderation_decisions enable row level security;
create policy moderation_decisions_no_api_access on public.moderation_decisions
  for select using (false);

alter table public.rights_requests enable row level security;
create policy rights_requests_insert_any on public.rights_requests
  for insert with check (true);
create policy rights_requests_no_read on public.rights_requests
  for select using (false);
