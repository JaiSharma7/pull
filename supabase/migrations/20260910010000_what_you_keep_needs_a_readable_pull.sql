-- -----------------------------------------------------------------------------
-- What you keep needs a readable pull.
--
-- 20260909020000 closed this hole in `notes` and named the three tables that still
-- had it. They are `highlights_own`, `saved_items_own` and `history_events_own`
-- (20260829124730:98-118), never redefined since, all the same shape:
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
--      column is always allowed WHERE IT CAN BE NULL -- `highlights.pull_id` cannot, so
--      that guard has no `is not null` arm and a clear there is refused by the guard
--      itself, 42501, before the NOT NULL constraint sees it (see the note below on why
--      that is not a hole). Setting a column to the value it already holds is not a
--      move, on any of them.
--
-- The trigger functions are `security invoker` (the default, stated by omission as
-- everywhere else here), so their subqueries run under the caller's own RLS exactly
-- as the insert policies' do, and each pins `search_path` for the reason every
-- function here does. Execute is revoked as `set_updated_at`'s is in 20260829124835:
-- a trigger fires without it, and nothing else should be able to call it. That file
-- gives the reason as PostgREST exposing a `public` function as an RPC endpoint;
-- PostgREST in fact excludes functions returning `trigger`, so the revoke is defence
-- in depth rather than the closing of an open door. It is kept for consistency with
-- every other trigger function here, which is worth more than the one line it costs.
--
-- THE PIN IS ASSERTED BY THE TEST FILES, not by `db:lint`: invariant 4 filters on
-- `prosecdef`, and these are `security invoker` deliberately, so the lint structurally
-- cannot see them. Dropping the pin from all three survived the whole suite until
-- section 7 of each file started checking `proconfig`. It is defence in depth rather
-- than a live hole -- `authenticated` holds CREATE on neither the database nor `public`,
-- and every reference in these bodies is schema-qualified -- but a promise nothing keeps
-- is the thing this file has spent twelve review rounds learning not to make.
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
--     `summaries` under the caller's RLS, so an unreadable pull yields no row on THIS
--     table. That is the whole of the claim, and an earlier draft of this header
--     overstated it as "it never had this bug": `record_read` guards only its first
--     statement, and its other two write `p_pull_id` verbatim. Measured, as reader B
--     against reader A's private imported pull:
--
--         record_read(priv) -> history_events=0  knowledge_states=1  feed_impressions=1
--
--     So the new leg here is for the direct PostgREST insert, which the old policy
--     allowed and which no function guards; and `knowledge_states` and
--     `feed_impressions` still carry the hole, named below. Its `on conflict do update
--     set dwell_ms` is unaffected: it changes none of the three columns, so the
--     trigger's old/new comparison finds no move (asserted in history_events.sql).
--   * `remember_pull` (20260905110000) is `security invoker` and inserts into
--     `saved_items`. It writes `user_questions` first, and `user_questions_insert_own`
--     has carried the readability leg since 20260905110000, so the pull is known
--     readable by the time the save is written and this file's leg cannot refuse a
--     call that got that far. That holds on a REPLAY too, and two earlier drafts of
--     this paragraph got the mechanism wrong in opposite directions. Measured:
--     `insert ... on conflict do nothing` DOES evaluate the INSERT `with check` --
--     Postgres checks the PROPOSED row before conflict arbitration, on `do nothing`
--     and `do update` alike -- so a replay against a since-withdrawn pull is refused
--     42501 by `user_questions_insert_own`, first, whether or not the save row
--     survived. This file is never reached.
--   * `commit_import` and `undo_import` (same file) are `security definer`, so no
--     policy applies to them. `commit_import` writes `saved_items` against pulls it
--     has just created under a summary the caller authors.
--
-- THE GUARD IS ONLY AS GOOD AS WHO MAY ADD A TRIGGER BESIDE IT.
--
-- `before update of <cols>` fires on the SET LIST, not on whether the column changed,
-- and BEFORE triggers run in name order. `authenticated` holds TRIGGER on every table
-- in `public` (the blanket `grant all` the platform's default privileges hand out), so
-- a competing trigger sorting after `highlights_keep_readable` can set `new.pull_id`
-- on a statement that never names it -- the guard has already run, or never fired.
-- Reproduced on a database replayed from zero, as reader B against A's private pull:
--
--     update highlights set pull_id = <private>  -> 42501            (the guard works)
--     create trigger zz_aaa before update ...    -> ALLOWED
--     update highlights set text = 'laundered'   -> ACCEPTED, and the row now names
--                                                   the private pull
--
-- Moving the guard to `after update` would fix this BY CONSTRUCTION, and is the better
-- answer of the two: an AFTER trigger sees the row every BEFORE trigger has finished
-- with, one sorting after it cannot mutate the row (its return is ignored), and no grant
-- can undo that. It is not a one-word change, though -- `after update OF <cols>` has the
-- same SET-list semantics as `before`, so the column list would have to go too, which
-- costs the saving the comment on history_events_keep_readable describes. The revoke
-- is what is done here: it
-- closes the reachable class, costs nothing, and is honestly a MITIGATION rather than
-- the structural fix. If a later migration re-grants TRIGGER the hole reopens, which is
-- why every table carrying one of these guards now asserts the revoke in its test file.
--
-- `authenticated` keeps SELECT, INSERT, UPDATE and DELETE -- everything the app uses,
-- since nothing in the product issues DDL -- and `create trigger` becomes
-- 42501. It needs a direct database connection to exploit (PostgREST issues no DDL),
-- so this is defence in depth rather than a live hole, which is also why it is one
-- line rather than a redesign.
--
-- The statement is in section 4, with the rest of the DDL.
--
-- WHAT THIS MIGRATION DOES NOT FIX, said plainly rather than left to be discovered:
-- `saved_items.stash_id` has the same unchecked shape -- a reader may file a save
-- into a stash they do not own, because `saved_items_own` never looked at the stash
-- either. It is a different claim (ownership, not readability), it leaks nothing
-- (`saved_items_select_own` scopes every read of a save to its owner, and it is the
-- only policy that matters here -- `stashes_read` does NOT scope to the owner, since a
-- stash marked public is readable by everyone), and
-- guarding it belongs with the stash policies rather than here.
--
-- Four more, found by the review rounds on this change and left deliberately:
--
--   * `knowledge_states` and `feed_impressions` take an unreadable pull from
--     `record_read`, as measured above, and accept one by direct insert too --
--     `knowledge_states_own` and `feed_impressions_own` are the same unguarded `for
--     all` shape. `knowledge_states` is written on EVERY read, so its guard carries
--     the same cost question `history_events` carried here, and it deserves the same
--     measurement rather than being appended to this file. `convictions`,
--     `explanations`, `progress`, `interrupt_events` and `recall_events` are the same
--     shape again. Nothing leaks, but not for the reason an earlier draft gave: six
--     `security definer` functions name `knowledge_states` and TWO of them read it.
--     `get_daily_pulls` re-filters `published`/`public` on both its candidate and its
--     output query; `test_out` (20260909010000) joins it, and scopes to
--     `ks.user_id = auth.uid()` through `readable_path_steps`, which re-filters
--     readability -- so a forged row naming an unreadable pull can only yield an
--     ordinal for a step the reader could already open. Of the other four,
--     `commit_import` and `complete_path_step` write it; `apply_path_step` writes it
--     but READS the column in its SET expression; and `undo_import` never touches it at
--     all -- it names it only in a comment about a rejected design, and reaches its rows
--     solely through the cascade behind `delete from public.pulls`. (Match that set with
--     `strpos`, not `ilike '%knowledge_states%'`: `_` is a LIKE wildcard and pulls in
--     `sweep_guest_accounts`, whose prose says "knowledge states".)
--   * The TRIGGER revoke in section 4 covers the five tables that carry a
--     `*_keep_readable` trigger -- these three, plus `notes` and `user_questions`.
--     Almost every other table in `public` still hands `authenticated` that privilege
--     (`daily_pull_selections` is the exception: 20260907010000 revoked all and granted
--     back select alone). Eleven of them do carry triggers -- ten `set_updated_at`, plus
--     `rights_requests_rate_limit` -- but NONE of those gates on a column's value:
--     `set_updated_at` stamps a timestamp and the rate limiter never reads `new`, so
--     there is nothing there for a later-sorting trigger to rewrite. Revoking it
--     everywhere is still the tidier end state and still a change to every table's
--     grants, which belongs in a migration whose subject that is.
--   * `authenticated` also holds TRUNCATE on these tables, which bypasses RLS
--     entirely. Same door (a direct connection), same systemic answer, and not what
--     this file is about: truncation destroys rows, it does not forge a claim that a
--     pull was readable.
--   * `notes_keep_readable` (20260909020000) keeps a NULL-comparison coverage gap on ONE
--     of its two legs, the kind the three files here now close on the five of their six
--     that can have one -- `highlights.pull_id` is `not null` (20260829124532), so no
--     move on it ever starts from null and `<>` there cannot let anything through. Not
--     strictly an EQUIVALENT mutant: a BEFORE ROW trigger fires before the NOT NULL
--     constraint is checked, so clearing that column reaches the guard and the two
--     spellings differ in which code refuses it -- 42501 against 23502 -- but nothing
--     lands either way, so there is no hole to pin.
--     `notes.sql` does move `summary_id` from a null start, so that leg's operator is
--     pinned; `pull_id` is moved from a null start only onto a pull the reader CAN read
--     (notes.sql:332-333), so nothing there tells the two operators apart. Writing that
--     comparison as `<>` rather than `is distinct from` therefore survives the whole
--     suite -- `x <> null` is null, the leg never fires from a null start, and a note
--     lands on a pull its writer cannot read. A third: `notes.sql` clears `pull_id` but
--     never `summary_id` alone, so that leg's `is not null` arm is unpinned too, and
--     dropping it refuses a legitimate clear (both notes columns are nullable). Its
--     EXECUTE revoke, and `user_questions_keep_readable`'s,
--     are likewise asserted by nothing. The SHIPPED code is correct in every case; these
--     are tests that do not pin what they cover. Editing another change's test file for a
--     hole that does not exist is not this one's to do, so it is written down here.
--   * THE OFFLINE QUEUE, which is this migration's own blast radius rather than an
--     older table's. A save made in a tunnel is queued, and replayed on reconnect; if
--     the summary was withdrawn in between, the leg above refuses the replay with
--     42501 -- permanently, where before this file that code on a save could only ever
--     mean a token refresh had failed. `isPermanentFailure` does not list 42501 and
--     must not, so the entry is kept and retried for the life of the tab, and through
--     `runDrain`'s `blocked.size === 0` gate it stops other permanent writes being
--     dropped. `Feed.tsx` keeps such a refusal OUT of the queue when the reader is
--     online; the queued-offline case stays open. Two attempts to close it from inside
--     the drain were written and withdrawn during review, both inferring "a session was
--     attached" from another write succeeding in the same pass, which is false twice
--     over: a token can expire mid-pass, and `unsavePull`, `updateSavedItem` and
--     `deleteStash` are bare DELETE/UPDATE with no `.select()`, so as `anon` they
--     return success with zero rows. Measured both. Closing it needs the access token
--     compared around the write, which is a queue change, not a migration's.
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
-- READ THE FIRST TWO ROWS AS INDISTINGUISHABLE. Interleaved on one loaded database over
-- eight rounds, `for all` and the bare split come out 337.8 us and 334.5 us, three
-- microseconds apart, while individual runs swing about ten per cent either way. "The
-- split alone is free" is the honest reading; "324 vs 353" is not a measurement, and no
-- arithmetic should be built on the difference. An earlier draft decomposed the guard
-- into per-leg costs anchored on that number and got 135/135/41/126 us; anchored on the
-- other run of the same configuration it gets 89/88, which is how you can tell the
-- decomposition was noise rather than structure. What survives is the direction and the
-- rough size: three legs, each an index lookup plus a policy evaluation through
-- `summaries`, and no one of them dominating.
--
-- WHAT A REQUEST ACTUALLY PAYS, which the loop above does not show. The harness runs
-- 2,800 calls inside one transaction and rolls back: no commit, no WAL flush, no
-- per-request snapshot, so its denominator is smaller than any real request's. Measured
-- again with pgbench, one client over a local socket, one `record_read` per transaction
-- with the role and claims set as PostgREST sets them:
--
--     empty-transaction floor                     0.211 ms
--     the `for all` policy, as it is today   1.47-1.56 ms     ~661 tps
--     split + all three legs (this file)     1.83-1.92 ms     ~534 tps
--
-- So +0.36 ms of latency per read, and about a fifth of this path's write throughput.
-- The latency is reader-invisible against an HTTP round trip -- more clearly so than the
-- in-transaction +91% suggests -- and the throughput is the number a future reader will
-- actually want, on free-tier Postgres, so it is stated here rather than left to be
-- rediscovered. Buffers per insert, which is the capacity number and far less noisy
-- than wall time, go from 27 to 42 -- +15 shared hits, all cache hits on primary
-- keys and `summaries_work_idx`.
--
-- So the guard costs roughly +300 us of database time and +15 buffer hits per read --
-- +307 us and +91% on the interleaved medians above, +273 and +77% on the first
-- non-interleaved run, which is the spread you should read it with -- and +0.36 ms of
-- real request latency. It is paid, and it is worth paying, because
-- the alternative is that the one table the app writes most is the one place the
-- invariant does not hold -- and it is the table a future feature is likeliest to
-- trust, since `history_events` is what the dwell signal in `get_feed`
-- (20260831210000) already reads.
--
-- A cheaper form was considered and rejected: require the triple to be internally
-- consistent (`summary_id` = the pull's summary, `work_id` = that summary's work)
-- rather than independently readable, which short-circuits the third subquery and
-- lands near the 500 us row -- measured at 564 us against this guard's 631 on the same
-- harness, so it saves about 67 us and not the 125 an earlier draft credited it with,
-- which makes its case weaker than this file first stated. It is stronger AND cheaper
-- for that 67, and it is also a different
-- claim, expressed as three interlocking conditions that a reviewer has to hold in
-- their head at once. The plain `is null or exists` leg is the one 20260909020000
-- established, reads the same on all four tables, and is obviously right at a
-- glance. 67 us is not worth making an RLS policy harder to check.
-- -----------------------------------------------------------------------------


-- 1. highlights --------------------------------------------------------------
--
-- `highlights.pull_id` is `not null` (20260829124532), so there is no `is null` arm
-- here and none in the trigger: a highlight always names a pull.

drop policy highlights_own on public.highlights;

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

drop policy saved_items_own on public.saved_items;

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

drop policy history_events_own on public.history_events;

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
  'caller under their own RLS. Only a move is refused -- old and new are compared here '
  'because a policy cannot see both -- which is what leaves record_read''s `on conflict '
  'do update set dwell_ms` idempotent: it changes none of these columns, so the '
  'comparison is false. Naming the columns on the trigger additionally spares that '
  'replay the call altogether, which is a cost saving and not the thing that makes it '
  'safe. See 20260910010000.';

comment on policy history_events_select_own on public.history_events is
  'A reader sees their own history and nobody else''s. Unlimited and free by law 3. '
  'Split out of history_events_own so the insert half can carry readability legs the '
  'update half must not. See 20260910010000.';

comment on policy history_events_insert_own on public.history_events is
  'A read can be recorded only against a pull, summary and work the reader can read. '
  'record_read cannot trip them: it selects its pull and summary through the caller''s '
  'own RLS, and a readable summary implies a readable work under works_read_readable. '
  'The legs are here for the direct '
  'PostgREST insert the old policy allowed. Costs +273us and +15 buffers per read, '
  'measured -- see the header of 20260910010000.';

comment on policy history_events_update_own on public.history_events is
  'A reader may amend their own history event -- in practice only record_read does, '
  'raising dwell_ms on a replay. Moving one onto something they cannot read is refused '
  'by the history_events_keep_readable trigger, not here. See 20260910010000.';

comment on policy history_events_delete_own on public.history_events is
  'A reader may always forget something they read, whatever became of it. '
  'See 20260910010000.';


-- 4. who may put a trigger beside the guard -------------------------------------
--
-- See the header for the reproduction. `before update of <cols>` fires on the SET
-- list and BEFORE triggers run in name order, so a competing trigger that sorts after
-- one of the three above can set the column the guard is watching on a statement that
-- never names it. `authenticated` holds TRIGGER on every table in `public` by default,
-- which is all that attack needs. It keeps SELECT, INSERT, UPDATE and DELETE -- every
-- privilege the app actually uses -- and loses only the one that lets it rewrite a row
-- behind the guard's back.
--
-- Scoped to the five tables that carry a `*_keep_readable` trigger: these three, and
-- `notes` and `user_questions` from 20260905110000 and 20260909020000. Those two are the
-- precedent this file extends, and the review reproduced the same walk-around against
-- them on `main` -- a trigger sorting after `notes_keep_readable`, an update naming only
-- `body`, and the note lands on a pull its writer cannot read. Shipping the guard on
-- three tables while two carrying the identical guard stayed bypassable would be the
-- invariant-that-holds-everywhere-but-here this file's own header argues against, and it
-- costs two identifiers.
--
-- Every other table in `public` keeps the privilege (bar `daily_pull_selections`,
-- which 20260907010000 revoked it from). Eleven carry triggers, but none of those
-- gates on a column's value --
-- `set_updated_at` stamps a timestamp, and `rights_requests_rate_limit` never reads
-- `new` -- so there is nothing for a later-sorting trigger to rewrite and this is the
-- whole of the reachable class. Taking the privilege away everywhere is a change to
-- every table's grants and belongs in a migration that says so.

revoke trigger on public.highlights, public.saved_items, public.history_events,
                  public.notes, public.user_questions
  from anon, authenticated;
