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
-- neither -- a free-standing note is still a note. The columns are written `notes.pull_id`
-- rather than bare, so the leg cannot be captured by a column of the same name should
-- one ever be added to the table it looks up.
--
-- THE UPDATE HALF TOO, for the reason 20260905110000 gave about questions: an insert
-- guard alone is one statement from useless -- insert the note against a readable pull,
-- then move it. But the update half cannot live in `notes_update_own`. A policy's
-- `with check` sees only the row as it will be, so a readability leg there would refuse
-- EVERY edit to a note whose pull has since stopped being readable, and a reader who can
-- no longer read the idea could no longer fix a typo in, or unpublish, what they wrote
-- about it. Today that state is reached only by an operator or the pipeline unpublishing
-- or privatising a summary -- nothing a reader can do does it, and an undone import
-- cascades the note away with its pull -- so this is the shape held ahead of the path
-- rather than a live failure. The note was true when it was written. What must not
-- happen is its being MOVED onto something unreadable, and that is a comparison of old
-- and new, which only a trigger can make. `notes_keep_readable` fires before an update
-- of `pull_id` or `summary_id` and refuses -- 42501, the code the policy would have
-- raised -- when the new target differs from the old and the caller cannot read it.
-- Clearing either column is always allowed, and setting a column to the value it
-- already has is not a move.
--
-- The trigger function is `security invoker`, so its subqueries run under the caller's
-- own RLS on `pulls` and `summaries`, exactly as the insert policy's do, and it pins
-- `search_path` for the reason every function here does. Its execute right is revoked
-- as `set_updated_at`'s was in 20260829124835: a trigger fires without it, and nothing
-- else should be able to call the function at all. `notes_update_own` itself keeps the
-- shape 20260901190000 gave it -- owner and guest legs -- and gains a comment saying
-- where the other half now lives.
--
-- `apply_path_step` is the other writer of `notes`, and it is `security definer`, so no
-- policy applies to it. It selects the step's pull through `summary_is_readable` before
-- writing (20260909010000), so it only ever writes a note against a pull the caller can
-- read. `paths.sql` asserts that a step behind a summary the caller cannot read raises
-- rather than writes.
--
-- Invariant 5 (no two permissive policies overlapping on SELECT) is untouched: this
-- file redefines no SELECT policy, and `notes_read` remains the one on the table.
--
-- `highlights_own`, `saved_items_own` and `history_events_own` (20260829124730) have
-- the same shape and the same hole, and are written by the client too. They are not
-- fixed here: each is `for all`, so each needs the same split into an insert leg and a
-- trigger, and `history_events` is written on every read, which makes the cost of the
-- subquery on that path a decision of its own rather than a line in this file.
-- -----------------------------------------------------------------------------

drop policy if exists notes_insert_own on public.notes;
create policy notes_insert_own on public.notes
  for insert
  with check (
    (select auth.uid()) = user_id
    and (visibility <> 'public' or not (select public.is_guest()))
    and (notes.pull_id is null
         or exists (select 1 from public.pulls p where p.id = notes.pull_id))
    and (notes.summary_id is null
         or exists (select 1 from public.summaries s where s.id = notes.summary_id))
  );

create or replace function public.notes_keep_readable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pull_id is not null
     and new.pull_id is distinct from old.pull_id
     and not exists (select 1 from public.pulls p where p.id = new.pull_id) then
    raise insufficient_privilege using
      message = 'A note can be moved only onto a pull you can read.';
  end if;

  if new.summary_id is not null
     and new.summary_id is distinct from old.summary_id
     and not exists (select 1 from public.summaries s where s.id = new.summary_id) then
    raise insufficient_privilege using
      message = 'A note can be moved only onto a summary you can read.';
  end if;

  return new;
end $$;

revoke all on function public.notes_keep_readable() from anon, authenticated, public;

drop trigger if exists notes_keep_readable on public.notes;
create trigger notes_keep_readable
  before update of pull_id, summary_id on public.notes
  for each row execute function public.notes_keep_readable();

comment on function public.notes_keep_readable() is
  'Before a note is moved: the new pull or summary must be readable by the caller under '
  'their own RLS. Old and new are compared here because a policy cannot see both, and a '
  'note whose pull has since become unreadable must stay editable. See 20260909020000.';

comment on policy notes_insert_own on public.notes is
  'A reader may write their own note, against a pull or summary they can read. A guest '
  'may write one and may not publish it: notes_read lets a public note out to anon. '
  'See 20260901190000 and 20260909020000.';

comment on policy notes_update_own on public.notes is
  'A reader may edit their own note, and may not publish it as a guest. Moving it onto '
  'a pull or summary they cannot read is refused by the notes_keep_readable trigger, '
  'not here, so that a note outlives the readability of what it was written about. '
  'See 20260901190000 and 20260909020000.';

-- -----------------------------------------------------------------------------
-- AND THE PRECEDENT GETS THE SAME TREATMENT. `user_questions_update_own`
-- (20260905110000) is the sibling of the insert policy the leg above was copied from,
-- and it repeats that readability leg in its `with check` -- so a question the reader wrote
-- about an idea that has since been withdrawn cannot be retired, which is the documented
-- way to stop being asked it, nor edited, for exactly the reason given above. The same
-- split: the policy keeps the owner leg, and `user_questions_keep_readable` refuses the
-- move. `pull_id` is `not null` there, so the trigger has one leg rather than two.
-- -----------------------------------------------------------------------------

drop policy if exists user_questions_update_own on public.user_questions;
create policy user_questions_update_own on public.user_questions
  for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.user_questions_keep_readable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pull_id is distinct from old.pull_id
     and not exists (select 1 from public.pulls p where p.id = new.pull_id) then
    raise insufficient_privilege using
      message = 'A question can be moved only onto a pull you can read.';
  end if;

  return new;
end $$;

revoke all on function public.user_questions_keep_readable() from anon, authenticated, public;

drop trigger if exists user_questions_keep_readable on public.user_questions;
create trigger user_questions_keep_readable
  before update of pull_id on public.user_questions
  for each row execute function public.user_questions_keep_readable();

comment on function public.user_questions_keep_readable() is
  'Before a question is moved: the new pull must be readable by the caller under their '
  'own RLS. Old and new are compared here because a policy cannot see both, and a '
  'question whose pull has since become unreadable must stay editable and retirable. '
  'See 20260909020000.';

comment on policy user_questions_update_own on public.user_questions is
  'A reader may edit or retire their own question. Moving it onto a pull they cannot '
  'read is refused by the user_questions_keep_readable trigger, not here, so that a '
  'question outlives the readability of the idea it was written about. See '
  '20260905110000 and 20260909020000.';
