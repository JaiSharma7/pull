-- -----------------------------------------------------------------------------
-- What you keep needs a readable pull.
--
-- 20260909020000 closed this hole in `notes` and named the three tables that still
-- had it. They are `highlights_own`, `saved_items_own` and `history_events_own`
-- (20260829124730:95-120), never redefined since, all the same shape:
--
--     for all using (auth.uid() = user_id) with check (auth.uid() = user_id)
--
-- Owner and nothing else. None of them looks at `pull_id` or `summary_id`, so a
-- reader could underline, save or record a read against ANY pull by uuid --
-- including another reader's private imported highlight, which
-- `pulls_read_via_summary` hides from them on every read path. Nothing leaks back:
-- the row is theirs and the pull stays invisible. But a personal row that names a
-- pull is a claim that the pull was readable when it was written, and that claim
-- was false. All three are written by the client, so the uuid is the only thing an
-- attacker needs, and `works_read_readable` (20260905101000) is the reason those
-- uuids are worth guessing at all: an imported book is invisible to everyone but
-- its importer, and a row asserting otherwise is the shape of the next leak.
--
-- Each table gets the same two halves 20260909020000 gave `notes`, and for the
-- same reasons:
--
--   1. THE INSERT POLICY carries an `exists` leg per target column. The subquery
--      runs under the caller's own RLS, so a pull they cannot see yields no row and
--      the check fails. Columns are written qualified (`highlights.pull_id`, not
--      bare `pull_id`) so the leg cannot be captured by a column of the same name
--      should one ever be added to the table it looks up.
--
--   2. THE UPDATE HALF IS A TRIGGER, NOT A POLICY LEG. A policy's `with check` sees
--      only the row as it will be, so a readability leg there refuses EVERY edit to
--      a row whose pull has since stopped being readable -- the summary withdrawn,
--      the import undone, a shared summary made private. A reader who can no longer
--      read the idea must still be able to re-file a save, or delete it. The row was
--      true when it was written; what must not happen is its being MOVED onto
--      something unreadable, and that is a comparison of old and new, which only a
--      trigger can make. Each `*_keep_readable` fires `before update of` its target
--      columns and refuses -- 42501, the code the policy would have raised -- when
--      the new target differs from the old and the caller cannot read it. Clearing a
--      column is always allowed; setting one to the value it already holds is not a
--      move.
--
-- The trigger functions are `security invoker` (the default, stated by omission as
-- everywhere else here), so their subqueries run under the caller's own RLS exactly
-- as the insert policies' do, and each pins `search_path` for the reason every
-- function here does. Execute is revoked as `set_updated_at`'s is in 20260829124835:
-- a trigger fires without it, and a trigger function in `public` is otherwise a
-- PostgREST RPC endpoint nobody meant to publish.
--
-- Splitting `for all` into four is not cosmetic. `for all` covers SELECT, so a
-- second SELECT policy beside it is what `db:lint` invariant 5 exists to catch;
-- after the split each table has exactly one SELECT policy and the write commands
-- are separate, which is what lets the INSERT `with check` differ from the UPDATE
-- one. The DELETE policies keep the owner leg alone, deliberately: a reader must be
-- able to remove a row whatever became of what it points at.
--
-- WHO ELSE WRITES THESE TABLES, and why none of them breaks:
--
--   * `record_read` (20260829222803) is the only writer of `history_events`. It is
--     `security invoker` and its `insert ... select` already joins `pulls` and
--     `summaries` under the caller's RLS, so an unreadable pull yields no row and it
--     never had this bug. The new leg is for the direct PostgREST insert, which the
--     old policy allowed and which no function guards. Its `on conflict do update
--     set dwell_ms` is unaffected: the update names no target column, so the trigger
--     does not fire, and the replay stays idempotent (asserted in history_events.sql).
--   * `remember_pull` (20260905110000) is `security invoker` and inserts into
--     `saved_items`. It writes `user_questions` first, and `user_questions_insert_own`
--     has carried the readability leg since 20260905110000 -- so the pull is already
--     known readable by the time the save is written, and this migration cannot
--     refuse a call that policy accepted.
--   * `commit_import` and `undo_import` (same file) are `security definer`, so no
--     policy applies to them. `commit_import` writes `saved_items` against pulls it
--     has just created under a summary the caller authors.
--
-- WHAT THIS MIGRATION DOES NOT FIX, said plainly rather than left to be discovered:
-- `saved_items.stash_id` has the same unchecked shape -- a reader may file a save
-- into a stash they do not own, because `saved_items_own` never looked at the stash
-- either. It is a different claim (ownership, not readability), it leaks nothing
-- (`stashes_read` and `saved_items_select_own` both scope reads to the owner), and
-- guarding it belongs with the stash policies rather than here.
--
-- -----------------------------------------------------------------------------
-- THE COST ON THE READ PATH, MEASURED
--
-- 20260909020000 left `history_events` out on the grounds that it is written on
-- every read, which makes the subquery's cost a decision of its own. This is that
-- decision, and these are the numbers behind it rather than an intuition.
--
-- Measured on a database replayed from zero and loaded with 400 public works,
-- 20,034 pulls and 12,000 existing history rows for the reader, then `analyze`d.
-- 2,800 `record_read` calls over distinct unread pulls, as `authenticated` under
-- RLS with a real JWT claim, after 200 warm-up calls; five runs per configuration,
-- median reported; `jit` off; no PostgREST and no network in the loop, so this is
-- database time only:
--
--     the `for all` policy, as it is today            353 us/call     27 buffers
--     split into four, no readability leg             324 us/call      - (noise)
--     split, pull leg only                            459 us/call
--     split, pull + summary legs                      500 us/call
--     split, work leg only                            459 us/call
--     split, all three legs (this migration)          626 us/call     42 buffers
--
-- The split alone is free. Each leg costs roughly 100-130 us, and they are additive
-- rather than dominated by one: `pulls_read_via_summary` and `works_read_readable`
-- each resolve through `summaries`, so each leg is an index lookup plus a policy
-- evaluation. Buffers per insert, which is the capacity number and far less noisy
-- than wall time, go from 27 to 42 -- +15 shared hits, all cache hits on primary
-- keys and `summaries_work_idx`.
--
-- So the guard costs +273 us and +15 buffer hits per read: about +77% of the
-- database time `record_read` already spends, and reader-invisible against an HTTP
-- round trip measured in milliseconds. It is paid, and it is worth paying, because
-- the alternative is that the one table the app writes most is the one place the
-- invariant does not hold -- and it is the table a future feature is likeliest to
-- trust, since `history_events` is what the dwell signal in `get_feed`
-- (20260831210000) already reads.
--
-- A cheaper form was considered and rejected: require the triple to be internally
-- consistent (`summary_id` = the pull's summary, `work_id` = that summary's work)
-- rather than independently readable, which short-circuits the third subquery and
-- lands near the 500 us row. It is stronger AND cheaper, and it is also a different
-- claim, expressed as three interlocking conditions that a reviewer has to hold in
-- their head at once. The plain `is null or exists` leg is the one 20260909020000
-- established, reads the same on all four tables, and is obviously right at a
-- glance. 125 us is not worth making an RLS policy harder to check.
-- -----------------------------------------------------------------------------


-- 1. highlights --------------------------------------------------------------
--
-- `highlights.pull_id` is `not null` (20260829124532), so there is no `is null` arm
-- here and none in the trigger: a highlight always names a pull.

drop policy if exists highlights_own on public.highlights;

create policy highlights_select_own on public.highlights
  for select using ((select auth.uid()) = user_id);

create policy highlights_insert_own on public.highlights
  for insert
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.pulls p where p.id = highlights.pull_id)
  );

create policy highlights_update_own on public.highlights
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy highlights_delete_own on public.highlights
  for delete using ((select auth.uid()) = user_id);

create or replace function public.highlights_keep_readable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pull_id is distinct from old.pull_id
     and not exists (select 1 from public.pulls p where p.id = new.pull_id) then
    raise insufficient_privilege using
      message = 'A highlight can be moved only onto a pull you can read.';
  end if;

  return new;
end $$;

revoke all on function public.highlights_keep_readable() from anon, authenticated, public;

drop trigger if exists highlights_keep_readable on public.highlights;
create trigger highlights_keep_readable
  before update of pull_id on public.highlights
  for each row execute function public.highlights_keep_readable();

comment on function public.highlights_keep_readable() is
  'Before a highlight is moved: the new pull must be readable by the caller under their '
  'own RLS. Old and new are compared here because a policy cannot see both, and a '
  'highlight whose pull has since become unreadable must stay deletable. See 20260910010000.';

comment on policy highlights_select_own on public.highlights is
  'A reader sees their own highlights and nobody else''s. Split out of highlights_own so '
  'the insert half can carry a readability leg the update half must not. See 20260910010000.';

comment on policy highlights_insert_own on public.highlights is
  'A reader may underline their own copy of a pull they can read. The exists runs under '
  'their own RLS, so a pull they cannot see is refused. See 20260910010000.';

comment on policy highlights_update_own on public.highlights is
  'A reader may edit their own highlight. Moving it onto a pull they cannot read is '
  'refused by the highlights_keep_readable trigger, not here, so that a highlight '
  'outlives the readability of the pull it was written on. See 20260910010000.';

comment on policy highlights_delete_own on public.highlights is
  'A reader may always remove their own highlight, whatever became of its pull. '
  'See 20260910010000.';


-- 2. saved_items -------------------------------------------------------------
--
-- `saved_items_one_target` (20260829124532) already requires exactly one of
-- `pull_id` and `summary_id`, so in practice one arm of each leg is dead -- but the
-- legs are written `is null or exists` anyway, because a policy that depends on a
-- check constraint for its correctness is one `alter table` away from being wrong.

drop policy if exists saved_items_own on public.saved_items;

create policy saved_items_select_own on public.saved_items
  for select using ((select auth.uid()) = user_id);

create policy saved_items_insert_own on public.saved_items
  for insert
  with check (
    (select auth.uid()) = user_id
    and (saved_items.pull_id is null
         or exists (select 1 from public.pulls p where p.id = saved_items.pull_id))
    and (saved_items.summary_id is null
         or exists (select 1 from public.summaries s where s.id = saved_items.summary_id))
  );

create policy saved_items_update_own on public.saved_items
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy saved_items_delete_own on public.saved_items
  for delete using ((select auth.uid()) = user_id);

create or replace function public.saved_items_keep_readable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pull_id is not null
     and new.pull_id is distinct from old.pull_id
     and not exists (select 1 from public.pulls p where p.id = new.pull_id) then
    raise insufficient_privilege using
      message = 'A save can be moved only onto a pull you can read.';
  end if;

  if new.summary_id is not null
     and new.summary_id is distinct from old.summary_id
     and not exists (select 1 from public.summaries s where s.id = new.summary_id) then
    raise insufficient_privilege using
      message = 'A save can be moved only onto a summary you can read.';
  end if;

  return new;
end $$;

revoke all on function public.saved_items_keep_readable() from anon, authenticated, public;

drop trigger if exists saved_items_keep_readable on public.saved_items;
create trigger saved_items_keep_readable
  before update of pull_id, summary_id on public.saved_items
  for each row execute function public.saved_items_keep_readable();

comment on function public.saved_items_keep_readable() is
  'Before a save is moved: the new pull or summary must be readable by the caller under '
  'their own RLS. Old and new are compared here because a policy cannot see both, and a '
  'save whose pull has since become unreadable must stay filable and deletable. '
  'See 20260910010000.';

comment on policy saved_items_select_own on public.saved_items is
  'A reader sees their own library and nobody else''s. Split out of saved_items_own so '
  'the insert half can carry a readability leg the update half must not. See 20260910010000.';

comment on policy saved_items_insert_own on public.saved_items is
  'A reader may keep a pull or a summary they can read. Unlimited, and free, by law 3: '
  'the leg refuses the stranger, never the save. See 20260910010000.';

comment on policy saved_items_update_own on public.saved_items is
  'A reader may re-file, annotate, archive or unarchive their own save. Moving it onto a '
  'pull or summary they cannot read is refused by the saved_items_keep_readable trigger, '
  'not here, so that a save outlives the readability of what it holds. Note stash_id is '
  'still unchecked, as it was before. See 20260910010000.';

comment on policy saved_items_delete_own on public.saved_items is
  'A reader may always unsave, whatever became of what they had kept. See 20260910010000.';


-- 3. history_events ----------------------------------------------------------
--
-- The hot one. See the measurement in the header for what these three legs cost on
-- the read path and why it is paid. `work_id` is guarded like the other two: a work
-- is readable when a readable summary sits behind it (works_read_readable,
-- 20260905101000), so naming one a reader cannot see is the same false claim.

drop policy if exists history_events_own on public.history_events;

create policy history_events_select_own on public.history_events
  for select using ((select auth.uid()) = user_id);

create policy history_events_insert_own on public.history_events
  for insert
  with check (
    (select auth.uid()) = user_id
    and (history_events.pull_id is null
         or exists (select 1 from public.pulls p where p.id = history_events.pull_id))
    and (history_events.summary_id is null
         or exists (select 1 from public.summaries s where s.id = history_events.summary_id))
    and (history_events.work_id is null
         or exists (select 1 from public.works w where w.id = history_events.work_id))
  );

create policy history_events_update_own on public.history_events
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy history_events_delete_own on public.history_events
  for delete using ((select auth.uid()) = user_id);

create or replace function public.history_events_keep_readable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pull_id is not null
     and new.pull_id is distinct from old.pull_id
     and not exists (select 1 from public.pulls p where p.id = new.pull_id) then
    raise insufficient_privilege using
      message = 'A history event can be moved only onto a pull you can read.';
  end if;

  if new.summary_id is not null
     and new.summary_id is distinct from old.summary_id
     and not exists (select 1 from public.summaries s where s.id = new.summary_id) then
    raise insufficient_privilege using
      message = 'A history event can be moved only onto a summary you can read.';
  end if;

  if new.work_id is not null
     and new.work_id is distinct from old.work_id
     and not exists (select 1 from public.works w where w.id = new.work_id) then
    raise insufficient_privilege using
      message = 'A history event can be moved only onto a work you can read.';
  end if;

  return new;
end $$;

revoke all on function public.history_events_keep_readable() from anon, authenticated, public;

drop trigger if exists history_events_keep_readable on public.history_events;
create trigger history_events_keep_readable
  before update of pull_id, summary_id, work_id on public.history_events
  for each row execute function public.history_events_keep_readable();

comment on function public.history_events_keep_readable() is
  'Before a history event is moved: the new pull, summary or work must be readable by the '
  'caller under their own RLS. Named columns only, so record_read''s `on conflict do '
  'update set dwell_ms` does not fire it and the offline replay stays idempotent. '
  'See 20260910010000.';

comment on policy history_events_select_own on public.history_events is
  'A reader sees their own history and nobody else''s. Unlimited and free by law 3. '
  'Split out of history_events_own so the insert half can carry readability legs the '
  'update half must not. See 20260910010000.';

comment on policy history_events_insert_own on public.history_events is
  'A read can be recorded only against a pull, summary and work the reader can read. '
  'record_read already selects through the same RLS; these legs are for the direct '
  'PostgREST insert the old policy allowed. Costs +273us and +15 buffers per read, '
  'measured -- see the header of 20260910010000.';

comment on policy history_events_update_own on public.history_events is
  'A reader may amend their own history event -- in practice only record_read does, '
  'raising dwell_ms on a replay. Moving one onto something they cannot read is refused '
  'by the history_events_keep_readable trigger, not here. See 20260910010000.';

comment on policy history_events_delete_own on public.history_events is
  'A reader may always forget something they read, whatever became of it. '
  'See 20260910010000.';
