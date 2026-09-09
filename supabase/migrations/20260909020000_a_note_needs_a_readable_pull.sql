-- -----------------------------------------------------------------------------
-- A note needs a readable pull.
--
-- `notes_insert_own` (20260901190000) checked two things: the note is the caller's own,
-- and a guest is not publishing it. It never looked at `pull_id`. So a reader could
-- insert a note against ANY pull by uuid -- including another reader's private imported
-- highlight, which `pulls_read_via_summary` hides from them on every read path. Nothing
-- leaked back, because the note is theirs and the pull stays invisible; but a row in
-- `notes` that names a pull is a claim that the pull was readable when it was written,
-- and that claim was false. It is exactly the invariant the next feature would assume,
-- and `user_questions_insert_own` already carries the leg that makes it true:
--
--     and exists (select 1 from public.pulls p where p.id = pull_id)
--
-- The subquery runs under the caller's own RLS on `pulls`, so a pull they cannot see
-- yields no row and the check fails. `summary_id` gets the same leg against `summaries`
-- for the same reason. Both are `is null or exists`, because a note may name either, or
-- neither -- a free-standing note is still a note.
--
-- THE UPDATE HALF TOO, for the reason 20260905110000 gave about questions: an insert
-- guard alone is one statement from useless -- insert the note against a readable pull,
-- then move it. `notes_update_own` repeats both legs in its `with check`.
--
-- `apply_path_step` is the other writer of `notes`, and it is `security definer`, so no
-- policy applies to it. It selects the step's pull through `summary_is_readable` before
-- writing (20260909010000), so it only ever writes a note against a pull the caller can
-- read. `paths.sql` asserts that a step behind a summary the caller cannot read raises
-- rather than writes.
--
-- Invariant 5 (no two permissive policies overlapping on SELECT) is untouched: this
-- file redefines the INSERT and UPDATE policies only, and `notes_read` remains the one
-- SELECT policy on the table.
-- -----------------------------------------------------------------------------

drop policy if exists notes_insert_own on public.notes;
create policy notes_insert_own on public.notes
  for insert
  with check (
    (select auth.uid()) = user_id
    and (visibility <> 'public' or not (select public.is_guest()))
    and (pull_id is null or exists (select 1 from public.pulls p where p.id = pull_id))
    and (summary_id is null
         or exists (select 1 from public.summaries s where s.id = summary_id))
  );

drop policy if exists notes_update_own on public.notes;
create policy notes_update_own on public.notes
  for update
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (visibility <> 'public' or not (select public.is_guest()))
    and (pull_id is null or exists (select 1 from public.pulls p where p.id = pull_id))
    and (summary_id is null
         or exists (select 1 from public.summaries s where s.id = summary_id))
  );

comment on policy notes_insert_own on public.notes is
  'A reader may write their own note, against a pull or summary they can read. A guest '
  'may write one and may not publish it: notes_read lets a public note out to anon. '
  'See 20260901190000 and 20260909020000.';

comment on policy notes_update_own on public.notes is
  'A reader may edit their own note, and may not move it onto a pull or summary they '
  'cannot read, nor publish it as a guest. See 20260909020000.';
