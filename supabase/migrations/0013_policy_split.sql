-- A `for all` policy also covers SELECT. On a table that already has its own
-- read policy, that means two permissive policies get OR-ed together for every
-- row of every read — a cost paid on the hot path, since summaries, stashes and
-- notes are read constantly.
--
-- The performance advisor flagged 25 of these. Split each write policy into
-- INSERT/UPDATE/DELETE so every action is covered exactly once.

-- follows
drop policy follows_write_own on public.follows;
create policy follows_insert_own on public.follows
  for insert with check ((select auth.uid()) = follower_id);
create policy follows_delete_own on public.follows
  for delete using ((select auth.uid()) = follower_id);

-- summaries
drop policy summaries_author_write on public.summaries;
create policy summaries_author_insert on public.summaries
  for insert with check ((select auth.uid()) = author_id);
create policy summaries_author_update on public.summaries
  for update using ((select auth.uid()) = author_id)
  with check ((select auth.uid()) = author_id);
create policy summaries_author_delete on public.summaries
  for delete using ((select auth.uid()) = author_id);

-- stashes
drop policy stashes_write_own on public.stashes;
create policy stashes_insert_own on public.stashes
  for insert with check ((select auth.uid()) = user_id);
create policy stashes_update_own on public.stashes
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy stashes_delete_own on public.stashes
  for delete using ((select auth.uid()) = user_id);

-- notes
drop policy notes_write_own on public.notes;
create policy notes_insert_own on public.notes
  for insert with check ((select auth.uid()) = user_id);
create policy notes_update_own on public.notes
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy notes_delete_own on public.notes
  for delete using ((select auth.uid()) = user_id);

-- feed_recipes
drop policy feed_recipes_write_own on public.feed_recipes;
create policy feed_recipes_insert_own on public.feed_recipes
  for insert with check ((select auth.uid()) = user_id);
create policy feed_recipes_update_own on public.feed_recipes
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy feed_recipes_delete_own on public.feed_recipes
  for delete using ((select auth.uid()) = user_id);
