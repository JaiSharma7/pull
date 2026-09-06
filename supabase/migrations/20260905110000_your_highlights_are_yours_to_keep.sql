-- Your highlights are yours to keep.
--
-- `routes/Ingestion.tsx` has parsed Kindle and Readwise exports in the browser since the
-- first round, and then thrown them away: the screen says so itself. Everything needed to
-- keep them already exists -- works, summaries, pulls, knowledge_states, the review
-- scheduler -- and none of it was reachable by a reader, because a reader may not insert
-- the works/summaries/pulls triple and should not be able to. So the reachable part is one
-- `security definer` RPC, and this migration is the tables it writes and the boundary it
-- keeps.
--
-- The shape of the thing: an import is a batch, an item is one highlight in it, and each
-- item becomes a pull under a private summary the reader authors on a work marked
-- `user_owned`. Their own highlights then flow through the mechanics the product already
-- has -- Review schedules them, the Library holds them, Undo removes them -- with no
-- second code path for "imported" content anywhere above this file.
--
-- TWO MECHANICS DO NOT REACH THEM YET, and review was right to catch both claims. Search
-- does not: `search_catalogue` (20260901090000:316-320) filters `visibility = 'public'` in
-- all three of its branches, so a reader cannot find their own imported highlight through
-- it. Nor does the Delta: nothing writes `pulls.embedding` outside the generation pipeline,
-- which imports never enter, and `refresh_knowledge_vector` skips a null embedding. Neither
-- is a leak -- nothing is exposed, something is absent -- and each is a change of its own
-- size. The Delta one needs the privacy promise revisited first, because embedding a
-- reader's verbatim highlight is a model call over their own text.
--
-- Three boundaries this migration is responsible for, and each is asserted in
-- `supabase/tests/imports.sql`:
--
--   * Law 4. Highlight text is stored verbatim, and that is only defensible because it is
--     the reader's own copy of something they own: `rights_status = 'user_owned'`, the
--     summary is `visibility = 'private'`, `get_feed` takes `published + public` so an
--     imported pull can never enter anybody's feed, and `og/index.ts` unfurls with the
--     anon key so it can never be unfurled. It is never sent to canonical generation.
--   * Law 5. Every table here enables RLS and carries its policies in this file.
--   * Law 2. Nothing here calls a model. An import is Postgres arithmetic on text the
--     browser already parsed.
--
-- The one thing an import must not do is make a reader's library enumerable, and
-- 20260905101000 landed first for exactly that reason: `works` is visible only behind a
-- readable summary, so an imported book is invisible to everyone but its importer even
-- though the `works` row itself is shared.

-- ------------------------------------------------------------------------- imports
--
-- One row per batch. `file_hash` is the sha256 of the uploaded file, which the client
-- computes with `crypto.subtle.digest`; it is null for a paste, which has no file.
--
-- It is deliberately NOT unique. `commit_import` is chunked at 500 items a call, so a
-- 3,000-highlight clippings file arrives as six calls carrying the same hash, and all six
-- must land in one batch or Undo would only undo a sixth of it. The reuse window below is
-- what joins them; a unique index would have refused the second chunk instead.
create table public.imports (
  id              uuid        primary key default extensions.gen_random_uuid(),
  user_id         uuid        not null references auth.users (id) on delete cascade,
  source_kind     text        not null,
  file_hash       text,
  item_count      int         not null default 0,
  duplicate_count int         not null default 0,
  work_count      int         not null default 0,
  created_at      timestamptz not null default now(),
  undone_at       timestamptz,
  constraint imports_source_kind_known
    check (source_kind in ('kindle', 'readwise', 'csv', 'paste')),
  constraint imports_file_hash_shape
    check (file_hash is null or file_hash ~ '^[0-9a-f]{64}$'),
  constraint imports_counts_sane
    check (item_count >= 0 and duplicate_count >= 0 and work_count >= 0)
);

comment on table public.imports is
  'One batch of highlights a reader kept. Undo works on a whole batch.';
comment on column public.imports.file_hash is
  'sha256 of the uploaded file, or null for a paste. Not unique: a chunked import shares one.';

create index imports_user_idx on public.imports (user_id, created_at desc);

-- ------------------------------------------------------------------- import_items
--
-- One row per highlight this reader holds, and the reason the second import of a grown
-- clippings file is cheap: a highlight already on record is counted as a duplicate and
-- gets no second row, so re-uploading the whole file costs one hash lookup an item.
--
-- `pull_id` and `work_id` are `on delete set null` rather than cascade: deleting a pull
-- must not erase the evidence that this reader already has that highlight, or the next
-- import would hand it back as new.
create table public.import_items (
  id           uuid        primary key default extensions.gen_random_uuid(),
  import_id    uuid        not null references public.imports (id) on delete cascade,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  pull_id      uuid        references public.pulls (id) on delete set null,
  work_id      uuid        references public.works (id) on delete set null,
  locator      text,
  content_hash text        not null,
  created_at   timestamptz not null default now(),
  -- Set when Undo takes this highlight back, and it is what makes Undo REVERSIBLE.
  --
  -- The row has to survive an Undo or the dedupe key goes with it and the next
  -- upload of an unchanged file hands back everything the reader just removed. But
  -- a surviving row that still counts as "held" made Undo a one-way door: the
  -- highlight was gone, re-importing the same file restored nothing, there is no
  -- delete policy on this table, and the ceiling still charged for it -- so a
  -- reader who imported 20,000 and undid was locked out holding nothing. In a
  -- feature called "your highlights are yours to keep", one mis-tapped Undo
  -- destroyed their own text for good.
  --
  -- With a timestamp instead, the row is a tombstone rather than a claim: it keeps
  -- the fingerprint so an ACCIDENTAL re-upload of something still held is a no-op,
  -- and stops counting and stops blocking once the reader has explicitly said they
  -- do not want it. Uploading the file again is then how you undo an Undo.
  undone_at    timestamptz,
  constraint import_items_locator_length
    check (locator is null or length(locator) <= 200),
  constraint import_items_hash_shape
    check (content_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.import_items is
  'One highlight in a batch. content_hash is what makes a re-import a no-op.';
comment on column public.import_items.content_hash is
  'sha256 of the work slug and the normalised highlight text. Unique per reader.';

-- The dedupe key, and the index that supports the `user_id` foreign key: leading column,
-- not partial, which is what lint invariant 3 asks for. Hashing the work slug alongside
-- the text is deliberate -- the same sentence highlighted in two different books is two
-- highlights, not a duplicate.
create unique index import_items_user_content_key
  on public.import_items (user_id, content_hash);
create index import_items_import_idx on public.import_items (import_id);
create index import_items_pull_idx   on public.import_items (pull_id);
create index import_items_work_idx   on public.import_items (work_id);

-- ------------------------------------------------------------------ user_questions
--
-- A reader's own question about an idea. A separate table rather than a row in
-- `quiz_questions`, for a mechanical reason: the pipeline upserts canonical questions with
-- `on conflict (pull_id, kind)`, and a partial unique index added to make room for reader
-- rows there would change which conflict target that upsert resolves against. Two tables
-- cost one union in `get_due_reviews` and nothing else.
create table public.user_questions (
  id                 uuid        primary key default extensions.gen_random_uuid(),
  user_id            uuid        not null references auth.users (id) on delete cascade,
  pull_id            uuid        not null references public.pulls (id) on delete cascade,
  kind               text        not null default 'recall',
  prompt             text        not null,
  answer             text,
  options            jsonb       not null default '[]'::jsonb,
  client_mutation_id uuid,
  retired_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint user_questions_kind_known
    check (kind in ('recall', 'cloze', 'mcq', 'short_answer')),
  constraint user_questions_prompt_length
    check (length(prompt) between 1 and 2000),
  constraint user_questions_answer_length
    check (answer is null or length(answer) <= 2000),
  constraint user_questions_options_is_array
    check (jsonb_typeof(options) = 'array')
);

comment on table public.user_questions is
  'A question a reader wrote for themselves. Preferred over the canonical one in Review.';
comment on column public.user_questions.retired_at is
  'Set when the reader stops wanting to be asked this. Kept, not deleted: it is their writing.';

create index user_questions_user_idx on public.user_questions (user_id, created_at desc);
create index user_questions_pull_idx on public.user_questions (pull_id);

-- Live questions for a reader-and-pull, which is the lookup `get_due_reviews` makes.
create index user_questions_live_idx
  on public.user_questions (user_id, pull_id)
  where retired_at is null;

-- The same replay key as explanations, convictions and recall_events.
create unique index user_questions_client_mutation_key
  on public.user_questions (user_id, client_mutation_id)
  where client_mutation_id is not null;

create trigger user_questions_updated_at
  before update on public.user_questions
  for each row execute function public.set_updated_at();

-- A grade against a reader's own question needs somewhere to say so, and it cannot be
-- `quiz_question_id`: that column carries a composite foreign key into `quiz_questions`,
-- so a user-question id there would be refused -- correctly, and uselessly.
--
-- COMPOSITE, for the reason 20260905100000 gives for the canonical column and one more.
-- A plain reference would check only that the question exists, so a client writing to
-- `recall_events` directly -- which `recall_events_insert_own` permits, on the strength of
-- the row's `user_id` alone -- could file an answer against a question belonging to a
-- different pull, permanently, in a table with no update or delete policy. That is exactly
-- the per-question evidence the neighbouring composite key was added to protect. This one
-- carries `user_id` as well, because a user question is a reader's own writing and a
-- stranger's id on this pull would otherwise pass.
alter table public.user_questions
  add constraint user_questions_id_user_pull_key unique (id, user_id, pull_id);

alter table public.recall_events
  add column user_question_id uuid;

alter table public.recall_events
  add constraint recall_events_user_question_is_theirs
  foreign key (user_question_id, user_id, pull_id)
  references public.user_questions (id, user_id, pull_id)
  on delete set null (user_question_id);

-- One question or the other, never both. Nothing forbade it: `grade_recall` only ever
-- writes one, but `recall_events_insert_own` admits a direct write on the strength of the
-- row's `user_id`, and review demonstrated a row naming a canonical question and one of
-- the reader's own for the same pull. The log has no update or delete policy, so that row
-- would be permanent and would mean two things at once.
alter table public.recall_events
  add constraint recall_events_one_question
  check (quiz_question_id is null or user_question_id is null);

comment on column public.recall_events.user_question_id is
  'Set instead of quiz_question_id when the reader answered their own question. Checked against user and pull together.';

create index recall_events_user_question_idx
  on public.recall_events (user_question_id);

-- ------------------------------------------------------------------------ law 5
alter table public.imports        enable row level security;
alter table public.import_items   enable row level security;
alter table public.user_questions enable row level security;

-- Batches and items are read-only through the API: they are written by `commit_import`,
-- which is definer, and unwound by `undo_import`, which is definer too. A reader with an
-- INSERT policy here could fabricate an item and claim a dedupe key, which buys nothing
-- and would let them poison their own next import.
create policy imports_read_own on public.imports
  for select using ((select auth.uid()) = user_id);
create policy import_items_read_own on public.import_items
  for select using ((select auth.uid()) = user_id);

-- Questions are the reader's own writing, so all four verbs, self-scoped. The insert
-- additionally requires the pull to be readable: this function-free `exists` runs under
-- the caller's own RLS on `pulls`, so a pull they cannot see yields no row and the check
-- fails. Guests are not excluded -- a guest may already grade, save and explain, and a
-- question they wrote for themselves is the same kind of act.
create policy user_questions_read_own on public.user_questions
  for select using ((select auth.uid()) = user_id);
create policy user_questions_insert_own on public.user_questions
  for insert with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.pulls p where p.id = pull_id)
  );
-- The UPDATE check repeats the INSERT check's readability clause, or the insert guard is
-- one statement from useless: review demonstrated inserting a question against a readable
-- pull and then moving it onto a pull the reader cannot read. Nothing leaks today, because
-- `get_due_reviews` joins `pulls` under invoker RLS and drops it -- but "a user_questions
-- row implies its pull was readable" is the kind of invariant the next feature will assume,
-- and it was false. The same shape as 20260905101000's summaries pair, for the same reason.
create policy user_questions_update_own on public.user_questions
  for update using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.pulls p where p.id = pull_id)
  );
create policy user_questions_delete_own on public.user_questions
  for delete using ((select auth.uid()) = user_id);

-- ------------------------------------------ and the door attribution left open
--
-- Review finding, and it defeats the point of the migration above it. `commit_import`
-- calls `attribute_work` when an imported book names an author, which inserts a
-- `contributors` row and a `work_contributors` row joining it to the work. Both tables
-- have carried `using (true)` since 20260829124730, and both are selectable by `anon` --
-- so one `GET /rest/v1/work_contributors?select=work_id,contributor_id` handed any
-- visitor the UUID of every private imported work and the author it is by. The `works`
-- policy from 20260905101000 was hiding the title while the join table published the row.
--
-- Superseded rather than skipped, because the attribution itself is right: an imported
-- book by Marcus Aurelius should reach the same contributor row the seeded one does, so
-- that a reader's own copy and the catalogue's agree about who wrote it. What was wrong
-- was that the join was world-readable. It is now readable exactly when the work is,
-- which is the same sentence the `works` policy makes and reuses its answer: the
-- subquery runs under the caller's own RLS, so a work they cannot see yields no row.
--
-- `contributors` follows, one step further out. A name on its own looks harmless, but a
-- row created by an import exists only because somebody imported that author, so an
-- obscure one is a signal about a reader. A contributor is visible when at least one work
-- they are on is -- which keeps every seeded contributor visible, since seeded works are
-- public, and hides one that exists only behind somebody's private book.
drop policy work_contributors_read_all on public.work_contributors;
create policy work_contributors_read_readable on public.work_contributors
  for select using (
    exists (select 1 from public.works w where w.id = work_contributors.work_id)
  );

comment on policy work_contributors_read_readable on public.work_contributors is
  'A work''s contributors are visible exactly when the work is. See 20260905101000.';

drop policy contributors_read_all on public.contributors;
create policy contributors_read_readable on public.contributors
  for select using (
    -- No join to `works` here: `work_contributors` carries the policy above, which
    -- already asks whether the work is readable, and this subquery runs under it. The
    -- join evaluated `summary_is_readable` a second time for nothing.
    exists (
      select 1
      from public.work_contributors wc
      where wc.contributor_id = contributors.id
    )
  );

comment on policy contributors_read_readable on public.contributors is
  'A contributor is visible when at least one work they are on is. Keeps an imported author out of a stranger''s reach.';

-- --------------------------------------------------------- imported_work_slug
--
-- The slug an imported book gets, as one function two callers share.
--
-- It exists because `commit_import` now needs the slug TWICE: once in the ordered
-- pre-pass that creates the works, and once in the item loop that attaches pulls to
-- them. Two copies of this expression that drifted apart would attach a reader's
-- highlights to a work nobody else lands on, which is the quiet version of the bug
-- the pre-pass exists to fix.
--
-- `imported-` can never collide with a catalogue slug, which matters: adopting the
-- seeded `meditations` would attach a reader's private pulls to a public work. The
-- readable stem is for whoever reads the table; the hash is what actually keeps two
-- books apart.
create function public.imported_work_slug(p_title text, p_author text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Bare `left`, `encode`, `sha256` and the rest: they live in `pg_catalog`, which is
  -- always searched even under an empty `search_path`. The same idiom the rest of this
  -- migration uses; only `citext` and `extensions.*` need qualifying.
  select 'imported-'
    || coalesce(
         nullif(
           left(btrim(regexp_replace(lower(p_title || ' ' || coalesce(p_author, '')),
                                     '[^a-z0-9]+', '-', 'g'), '-'), 60),
           ''
         ),
         'untitled'
       )
    || '-'
    -- Sixteen hex, not eight. For any book whose slugified "title author" runs past 60
    -- characters the readable stem is truncated, so the hash is the ONLY thing keeping
    -- two titles apart -- and two readers landing on one slug share the `works` row,
    -- whose `title` is whatever the first importer supplied. 32 bits is inside reach of
    -- an offline search; 64 is not.
    || left(
         encode(
           sha256(convert_to(lower(p_title) || '|' || lower(coalesce(p_author, '')), 'UTF8')),
           'hex'
         ),
         16
       );
$$;

revoke all on function public.imported_work_slug(text, text) from public, anon, authenticated;

-- --------------------------------------------------------------- attribute_work
--
-- Re-stated for ONE LINE, and it is the same line this migration already fixed one
-- table over. `attribute_work` looked its contributor up with `lower(c.slug::text) =
-- as_slug`, which wraps a `citext` column with a unique btree in a function the index
-- cannot answer -- so it ran a SEQUENTIAL SCAN, once per distinct author in the chunk.
--
-- That was affordable while `contributors` held the seeded few. `commit_import` is what
-- makes it grow, and it now calls this once per author per import, so the feature feeds
-- its own scan. Measured on one 500-item chunk of fresh authors: 3.2 s at 7,856
-- contributors, 7.1 s at 23,356, 14.7 s at 53,856, 29.8 s at 114,356. `authenticated`
-- carries an 8 s `statement_timeout`, so somewhere past 20,000 contributors a full chunk
-- begins failing outright -- `canceling statement due to statement timeout`, raised
-- inside `attribute_work`, rolling back all 500 highlights with a message the reader
-- cannot act on.
--
-- Schema-qualifying the operator keeps the index: 36.5 ms and 817 buffers become 0.105
-- ms and 4 at 67,855 rows. Migrations are append-only, so the fix is a `create or
-- replace` here rather than an edit to 20260901160000.
create or replace function public.attribute_work(p_work_id uuid, p_author text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned        text;
  as_slug        text;
  contributor_id uuid;
begin
  cleaned := nullif(btrim(coalesce(p_author, '')), '');
  if cleaned is null or p_work_id is null then
    return;
  end if;
  cleaned := left(cleaned, 200);

  as_slug := btrim(regexp_replace(lower(cleaned), '[^a-z0-9]+', '-', 'g'), '-');
  if as_slug = '' then
    return;
  end if;

  select c.id into contributor_id
    from public.contributors c
   where c.slug operator(extensions.=) as_slug::extensions.citext;

  if contributor_id is null then
    insert into public.contributors (name, slug)
    values (cleaned, as_slug)
    on conflict (slug) do nothing
    returning id into contributor_id;

    if contributor_id is null then
      select c.id into contributor_id
        from public.contributors c
       where c.slug operator(extensions.=) as_slug::extensions.citext;
    end if;
  end if;

  if contributor_id is null then
    return;
  end if;

  insert into public.work_contributors (work_id, contributor_id, role)
  values (p_work_id, contributor_id, 'author')
  on conflict do nothing;
end;
$$;

-- ------------------------------------------------------------------ commit_import
--
-- The only non-pipeline writer of the works/summaries/pulls triple, and `security
-- definer` because it has to be: a reader may not insert a work, may not insert a pull,
-- and must not be given policies that would let them. Everything it derives it derives
-- itself -- no work id, no summary id and no visibility crosses the boundary from the
-- client, so the worst a hostile caller can do with it is fill their own quota.
--
-- Bounded in three directions. 500 items a call keeps one statement's work bounded and is
-- what the client chunks to; 20,000 items a reader is the ceiling on the whole feature;
-- and the advisory lock serialises a reader against themselves, so two chunks in flight
-- cannot both read the same ordinal or both create the same work.
--
-- Refused to guests, on the authoritative fact rather than the JWT claim, for the reason
-- 20260901190000 sets out at length: an identity that costs nothing to mint makes a
-- per-identity ceiling meaningless, and this is the one door here that writes rows a
-- sweep would then have to clean up.
create function public.commit_import(
  p_source_kind text,
  p_file_hash   text,
  p_items       jsonb,
  -- The batch this chunk continues, from the `importId` the previous chunk returned.
  -- See the reuse window below: with it, "chunk 2 of this paste" is a fact rather than
  -- a guess. Optional, because the first chunk of anything has nothing to name.
  p_import_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  max_items_per_call constant int      := 500;
  max_items_per_user constant int      := 20000;
  reuse_window       constant interval := interval '6 hours';
  /*
   * A ceiling on BATCHES, because the item ceiling has never counted them.
   *
   * The zero-length guard below exists because `commit_import('paste', null, '[]')`
   * inserted an `imports` row and returned, so any signed-in reader could write batch
   * rows in a loop. Narrowing the hashless reuse window to five minutes -- correct for
   * the Undo defect it fixes -- loosened the residual bound on that from four rows a
   * day to 288, and a caller sending a fresh random `file_hash` each time was never
   * bounded at all. Measured: 21 duplicate-only calls six minutes apart produced 21
   * `imports` rows and one `import_items` row.
   *
   * 20,000 items at 500 a chunk is 40 batches for a whole library, so 2,000 is fifty
   * times more than the feature needs and still a number. Tombstoned batches count:
   * an Undo frees item quota deliberately, and letting it free batch quota too would
   * be the same cancellation this round had to fix one bound over.
   */
  max_imports_per_user constant int    := 2000;
  /*
   * A LIFETIME CEILING ON BOOKS, which is the resource that does not come back.
   *
   * `max_items_per_user` counts LIVE items, and an Undo frees it deliberately -- a
   * highlight taken back is not one the reader is holding. The `works` and
   * `contributors` an import created DO NOT go back, because deleting them races every
   * other reader's import (round 5 tried; see `undo_import`). So bounding creation by
   * the room left under a ceiling an Undo refunds is a bound that refunds itself:
   * import 500 fresh titles, undo, repeat, forever.
   *
   * The counter has to be the thing being protected. Counting ITEMS was the first
   * attempt and is wrong in the reader's direction: a reader who has stored 20,000
   * highlights, undone most of them, and wants to import a corrected export would be
   * refused, while the abuse -- fresh TITLES every cycle -- is what actually makes
   * rows. Counting distinct `import_items.work_id` counts BOOKS this reader has ever
   * imported into. Tombstones keep their `work_id`, so no Undo lowers it; re-importing
   * the same book costs nothing, because it is the same work.
   *
   * 2,000 books is a library nobody has and 2,000 shared rows is a bound. 20,000
   * highlights across 2,000 books is ten highlights a book, which is already thin.
   */
  max_works_per_user constant int      := 2000;

  uid          uuid := (select auth.uid());
  v_import_id  uuid;
  v_item       jsonb;
  v_title      text;
  v_author     text;
  v_raw        text;
  v_locator    text;
  v_clean      text;
  v_slug       text;
  v_pre        record;
  v_contributor_id uuid;
  v_hash       text;
  v_work_id    uuid;
  v_summary_id uuid;
  v_pull_id    uuid;
  v_ordinal    int;
  v_words      int;
  v_seconds    int;
  v_added      int := 0;
  v_duplicates int := 0;
  v_ceiling_reached boolean := false;
  v_held       int;
  v_books      int;
  v_batches    int;
  v_touched    uuid[] := '{}';
  /** Contributors this call created or attributed, which the guard below may reuse. */
  v_mine       uuid[] := '{}';
  v_works_out  jsonb;
  v_needed     jsonb;
begin
  if uid is null then
    raise exception 'commit_import requires an authenticated user';
  end if;

  if not exists (
    select 1 from auth.users u where u.id = uid and u.is_anonymous is not true
  ) then
    raise exception
      'Keeping highlights needs an account. Sign in with an email address and try again.'
      using errcode = '28000';
  end if;

  if p_source_kind is null
     or p_source_kind not in ('kindle', 'readwise', 'csv', 'paste') then
    raise exception 'commit_import: unknown source kind %', p_source_kind
      using errcode = '22023';
  end if;

  if p_file_hash is not null and p_file_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'commit_import: a file hash is 64 hex characters'
      using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'commit_import: items must be a JSON array'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > max_items_per_call then
    raise exception 'commit_import: % items in one call, the limit is %',
      jsonb_array_length(p_items), max_items_per_call
      using errcode = '22023';
  end if;

  /*
   * Nothing offered, nothing written. `commit_import('paste', null, '[]')` validated,
   * inserted an `imports` row and returned `added: 0`, so any signed-in reader could
   * write batch rows in a loop indefinitely -- unbounded growth on a free tier, and
   * flatly against this function's own claim above that the worst a hostile caller can
   * do is fill their own quota. The 20,000 ceiling counts `import_items` and has never
   * had anything to say about `imports`.
   */
  if jsonb_array_length(p_items) = 0 then
    return jsonb_build_object(
      'importId', null, 'added', 0, 'duplicates', 0, 'works', '[]'::jsonb,
      'ceilingReached', false
    );
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 1));

  -- Read once, then charged per row actually inserted inside the loop, and NOT refused
  -- here. Refusing on the incoming count turned away a chunk that was mostly duplicates
  -- and would have added almost nothing; refusing on the held count alone turns away a
  -- reader at the ceiling who is re-uploading a file that would add nothing at all. The
  -- ceiling is a bound on what is stored, so the only honest place to charge it is the
  -- moment a row is about to be stored.
  --
  -- `undone_at is null` because a highlight the reader has taken back is not one they
  -- are holding. Counted without it, an Undo freed nothing and a reader who imported
  -- 20,000 and undid every one could never import again.
  select count(*) into v_held
    from public.import_items
   where user_id = uid and undone_at is null;

  -- EVERY book ever, tombstones included: the counter an Undo does not refund. See
  -- `max_works_per_user`.
  select count(distinct ii.work_id) into v_books
    from public.import_items ii
   where ii.user_id = uid and ii.work_id is not null;

  -- One batch per file, even when the file arrives in six calls. Outside the window a
  -- fresh batch is right: re-importing a clippings file that has grown since is a new
  -- act, and its already-held highlights fall out as duplicates rather than as rows.
  --
  -- A HASHLESS SOURCE GETS THE SAME WINDOW, matched on `source_kind` alone. The guard
  -- used to be `if p_file_hash is not null`, so a paste skipped the lookup entirely and
  -- every call opened a fresh batch -- which means the failure the window exists to
  -- prevent, stated three paragraphs up as "all six must land in one batch or Undo
  -- would only undo a sixth of it", was unreachable for exactly one of the four
  -- sources. `commit_import` caps at 500 items a call and accepts 'paste' as a
  -- first-class kind, so a pasted 3,000-highlight passage had the same shape and none
  -- of the protection: measured, three pasted chunks landed in three separate batches.
  --
  -- It also bounds `imports` growth for the one source that can be called without a
  -- file: repeated pastes join the open batch instead of each opening their own.
  /*
   * NAMED, IF THE CALLER NAMED IT. The window below is a heuristic and this is not:
   * `commit_import` returns an `importId`, and a client chunking one upload passes it
   * back for chunks two onward. Then "these items belong with those" is something the
   * client knows and says, rather than something the server infers from a clock.
   *
   * Ownership is checked rather than trusted, and a tombstoned batch is refused: a
   * chunk cannot join something the reader has already taken back.
   */
  if p_import_id is not null then
    select i.id into v_import_id
      from public.imports i
     where i.id = p_import_id and i.user_id = uid and i.undone_at is null;
    if v_import_id is null then
      raise exception 'commit_import: no open batch of yours with that id'
        using errcode = '22023';
    end if;
  end if;

  if v_import_id is null then
  select i.id into v_import_id
    from public.imports i
   where i.user_id = uid
     and i.source_kind = p_source_kind
     and i.undone_at is null
     and i.created_at > now() - (
       -- A HASHLESS SOURCE GETS A MUCH SHORTER WINDOW, because `source_kind` alone
       -- cannot tell "chunk 2 of this paste" from "a different paste entirely".
       -- At six hours it could not: two unrelated pastes five hours apart merged
       -- into one batch, and undoing the second took the first one's highlights
       -- with it -- a reader losing something they never asked to remove, which is
       -- the one thing an Undo must not do. Minutes still cover a chunked upload,
       -- which arrives as fast as the client can post it.
       case when p_file_hash is null then interval '5 minutes' else reuse_window end
     )
     and (
       (p_file_hash is not null and i.file_hash = p_file_hash)
       or (p_file_hash is null and i.file_hash is null)
     )
   order by i.created_at desc
   limit 1;
  end if;

  if v_import_id is null then
    select count(*) into v_batches from public.imports where user_id = uid;
    if v_batches >= max_imports_per_user then
      raise exception
        'You have reached the limit of % import batches. Undo one you no longer need.',
        max_imports_per_user
        using errcode = '54023';
    end if;

    insert into public.imports (user_id, source_kind, file_hash)
    values (uid, p_source_kind, p_file_hash)
    returning id into v_import_id;
  end if;

  /*
   * EVERY WORK AND AUTHOR THIS CHUNK NEEDS, WORKED OUT ONCE AND CREATED FIRST.
   *
   * The find-or-create used to sit inside the item loop, so `works` row locks were
   * taken in the order the reader's file happened to list its books. Two readers whose
   * files name the same new titles in different orders then built a lock cycle, and
   * Postgres killed one of them: two ordinary `commit_import` calls -- no stretched
   * transactions, just what two PostgREST requests look like -- deadlocked on 12 of 12
   * attempts with `40P01`, losing up to 500 highlights to an error the reader cannot
   * act on. It gets MORE likely the more popular a book is, which is the wrong way
   * round for a feature whose whole premise is that two readers own the same books.
   *
   * The advisory lock above does not help: it is keyed on `uid`, so it serialises a
   * reader against themselves and never against anybody else.
   *
   * Hoisting it fixed that and opened something else, because it also hoisted the
   * creation above the dedupe and the ceiling: the pre-pass built shared rows for items
   * the loop then skipped. Measured -- a reader at exactly 20,000 held items called this
   * twice with 500 fresh titles and added 1,000 orphan `works` and about as many
   * `contributors`, `added: 0` both times, repeatable forever. Those are SHARED
   * CATALOGUE tables: no per-reader ceiling covers them, no sweep collects them, and
   * this feature is itself what makes `works` grow, so it fed the very scan the index
   * fix below calls a bomb with its own fuse. It also made the header's own claim --
   * that the worst a hostile caller can do is fill their own quota -- false.
   *
   * Refusing the whole call at the ceiling was the first attempt at that and was wrong:
   * a duplicate-only upload at the ceiling is deliberately accepted, and refusing it
   * threw away the `duplicates` count the reader is shown. The bound belongs on the SET
   * this pre-pass walks, not on the call.
   *
   * So the set below is what the loop can actually store: items whose hash the reader
   * does not already hold, in the order the loop will meet them, capped at the room left
   * under the ceiling. The cap counts DISTINCT SLUGS rather than items, and that is
   * still a superset of what the loop needs -- the loop stores at most `room` items, and
   * each one's slug first occurs at or before it, so at most `room` slugs can first
   * occur that early. A superset is the safe direction: an item reaching the loop to
   * find its work missing is raised on rather than created for, because creating one
   * there would be in item order and would reopen the deadlock.
   *
   * Worked out once and read twice, because the two loops want it in two orders.
   */
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'slug', needed.slug, 'title', needed.title, 'author', needed.author)),
           '[]'::jsonb)
    into v_needed
    from (
      select ranked.slug, ranked.title, ranked.author
        from (
          select first_seen.*, row_number() over (order by first_seen.ord) as rank
            from (
              select distinct on (item.slug) item.ord, item.slug, item.title, item.author
                from (
                  select
                    e.ord,
                    left(btrim(coalesce(e.value ->> 'title', '')), 200) as title,
                    nullif(left(btrim(coalesce(e.value ->> 'author', '')), 200), '')
                      as author,
                    public.imported_work_slug(
                      left(btrim(coalesce(e.value ->> 'title', '')), 200),
                      nullif(left(btrim(coalesce(e.value ->> 'author', '')), 200), '')
                    ) as slug,
                    encode(sha256(convert_to(
                      public.imported_work_slug(
                        left(btrim(coalesce(e.value ->> 'title', '')), 200),
                        nullif(left(btrim(coalesce(e.value ->> 'author', '')), 200), '')
                      ) || '|' || lower(btrim(regexp_replace(
                        coalesce(e.value ->> 'text', ''), '\s+', ' ', 'g'))),
                      'UTF8')), 'hex') as hash
                    from jsonb_array_elements(p_items) with ordinality as e(value, ord)
                   -- Malformed items are skipped rather than raised on here. The item
                   -- loop owns validation and says which item is wrong; a raise from
                   -- inside a pre-pass would name none of them.
                   where jsonb_typeof(e.value) = 'object'
                     and jsonb_typeof(e.value -> 'title') = 'string'
                     and btrim(coalesce(e.value ->> 'title', '')) <> ''
                     and (not (e.value ? 'author')
                          or jsonb_typeof(e.value -> 'author') = 'string')
                ) item
               -- `undone_at is null` matches the loop's own dedupe: a highlight the
               -- reader has taken back is one a re-import may store again.
               -- ANY row, tombstone included, and not just a live one. A tombstoned
               -- hash is a revival: the loop stores it, but its work is already there
               -- (nothing deletes works now), so it needs no creation room and must not
               -- consume a rank slot that a genuinely new item needs.
               where not exists (
                 select 1 from public.import_items ii
                  where ii.user_id = uid and ii.content_hash = item.hash
               )
               order by item.slug, item.ord
            ) first_seen
        ) ranked
       -- BOTH CEILINGS, and `rank` is already a count of DISTINCT SLUGS -- the rows it
       -- numbers are one per slug -- so a book ceiling and an item ceiling are both
       -- upper bounds on it. The holding one stops a reader at the ceiling creating
       -- anything; the book one stops import-undo-repeat refunding the room that bounds
       -- creation. The window is still a superset of what the loop needs: the k-th item
       -- the loop stores has slug rank <= k <= the item room.
       where ranked.rank <= greatest(
               least(max_items_per_user - v_held, max_works_per_user - v_books), 0)
    ) needed;

  -- The works first, and in slug order: every caller takes the same locks in the same
  -- order, and two orders consistently applied cannot form a cycle.
  for v_pre in
    select x.value ->> 'slug' as slug, x.value ->> 'title' as title
      from jsonb_array_elements(v_needed) x
     order by 1
  loop
    if exists (
      select 1 from public.works w
       where w.slug operator(extensions.=) v_pre.slug::extensions.citext
    ) then
      continue;
    end if;

    insert into public.works (kind, title, slug, rights_status)
    values ('book', v_pre.title, v_pre.slug, 'user_owned')
    on conflict (slug) do nothing;
  end loop;

  /*
   * AND THE CONTRIBUTORS AFTER THEM, IN THEIR OWN ORDER.
   *
   * `attribute_work` used to run inside the works loop, which meant `contributors` row
   * locks were taken in WORKS-slug order -- a different total order from the one they
   * need. Two readers importing different books by the same two new authors in crossing
   * order still deadlocked: measured 8 of 12, with `40P01 ... while inserting index
   * tuple in relation "contributors"`. Ordering works alone fixed four scenarios and
   * left this one, which is the more likely of the two, because two readers sharing an
   * AUTHOR is commoner than two readers sharing a book.
   *
   * So: every works lock in slug order, then every contributor lock in author order.
   */
  --
  -- EVERY (author, work) PAIR, not one per author. The first version was `distinct on
  -- (author)`, which passed `attribute_work` the lexicographically smallest slug and
  -- silently dropped the byline on every other book by that author in the same call.
  -- A Kindle export is grouped by book and chunked at 500, so several books by one
  -- author in one chunk is the ordinary case, not the edge: measured, three books by
  -- one new author in one call produced one link. The de-duplication bought nothing --
  -- the lock order is the `order by`, and re-locking a contributor this transaction
  -- already holds is free.
  --
  -- ORDERED BY THE SLUG, WHICH IS WHAT IS LOCKED. Ordering by the raw author string
  -- looked equivalent and is not: `attribute_work` locks
  -- `btrim(regexp_replace(lower(author),'[^a-z0-9]+','-','g'),'-')`, and that map is
  -- many-to-one -- every non-ASCII letter is stripped, so `Emile Zola`, `Émile Zola`
  -- and `Ámile Zola` are one contributor sorting in three places, with any ordinary
  -- name in between crossing them. Measured 12 deadlocks in 12 attempts with two
  -- readers whose files spell one author two ways, both losing their whole chunk:
  -- `40P01 ... while inserting index tuple in relation "contributors"`. Sorting by the
  -- key the lock is taken on is the only thing that makes the order total.
  for v_pre in
    select a.author, a.slug
      from (
        select distinct
               x.value ->> 'author' as author,
               x.value ->> 'slug' as slug,
               btrim(regexp_replace(lower(x.value ->> 'author'), '[^a-z0-9]+', '-', 'g'),
                     '-') as author_slug
          from jsonb_array_elements(v_needed) x
      ) a
     where a.author is not null
     order by a.author_slug, a.slug
  loop
    select w.id into v_work_id
      from public.works w
     where w.slug operator(extensions.=) v_pre.slug::extensions.citext;
    if v_work_id is null then
      continue;
    end if;

    /*
     * Attribution, but never onto a contributor this reader cannot already see.
     *
     * `attribute_work` deduplicates on the slug and REUSES an existing row, which made
     * `contributors` a confirmation oracle: reader B imports a one-line paste naming an
     * obscure author, lands on the row reader A's private import created, and then
     * reads back A's exact capitalisation and punctuation -- learning both that
     * somebody on this instance imported that author and what string they typed.
     *
     * THE FIRST ATTEMPT AT THIS GUARD DID NOTHING, and the reason is worth keeping.
     * It asked `exists (select 1 from public.works w where w.id = wc.work_id)` and
     * relied on RLS to make that false for a work the caller cannot see. But this
     * function is `security definer` owned by `postgres`, which owns `works`, and no
     * table here sets `force row level security` -- so the subquery ran with RLS
     * BYPASSED and was true for every work. The guard degenerated to "the contributor
     * is attached to something", which is true of every row `attribute_work` has ever
     * made. Verified: the oracle was still open with the guard in place.
     *
     * Readability is therefore asked explicitly, with the predicate the rest of the
     * schema uses. `auth.uid()` is still the caller inside a definer, so
     * `summary_is_readable` answers for the right reader.
     */
    select c.id into v_contributor_id
      from public.contributors c
     where c.slug operator(extensions.=)
           btrim(regexp_replace(lower(v_pre.author), '[^a-z0-9]+', '-', 'g'), '-')
               ::extensions.citext;

    /*
     * `v_mine` is the third admitting condition and it is not an optimisation.
     *
     * The readability leg asks for a summary the caller can read behind the
     * contributor -- and inside THIS call there is none yet: the pre-pass runs ahead of
     * the item loop, which is what creates the summaries. So for three books by one new
     * author in one chunk, the first created the contributor and the next two found it
     * and were refused by their own reader's row. Measured: one byline of three, on the
     * ordinary case for a Kindle export, which is grouped by book.
     *
     * A contributor this call created or has already legitimately attributed is one the
     * caller demonstrably reaches, so admitting it discloses nothing a stranger could
     * not already have inferred from their own import succeeding.
     */
    if v_contributor_id is null
       or v_contributor_id = any(v_mine)
       /*
        * OR THIS READER HAS IMPORTED THAT AUTHOR BEFORE, tombstones included.
        *
        * The readability leg asks for a summary the caller can read behind the
        * contributor, and an Undo deletes exactly that summary -- so a reader who
        * imported an author, took it back, and imported them again got no byline the
        * second time. The guard could not tell their own abandoned row from a
        * stranger's. Round 5 answered that by DELETING the abandoned row, which turned
        * out to race every other reader's import; this asks the question directly.
        *
        * It discloses nothing: the leg is true only when the caller has themselves
        * imported a book this contributor is on, which is a fact they already hold.
        */
       or exists (
         select 1
           from public.import_items ii
           join public.work_contributors wc2 on wc2.work_id = ii.work_id
          where ii.user_id = uid and wc2.contributor_id = v_contributor_id
       )
       or exists (
         select 1
           from public.work_contributors wc
           join public.summaries s on s.work_id = wc.work_id
          where wc.contributor_id = v_contributor_id
            and public.summary_is_readable(s.*)
       )
    then
      perform public.attribute_work(v_work_id, v_pre.author);
      -- Re-read rather than reused: on the first book of an author `v_contributor_id`
      -- was null, and it is `attribute_work` that decided the id.
      select c.id into v_contributor_id
        from public.contributors c
       where c.slug operator(extensions.=)
             btrim(regexp_replace(lower(v_pre.author), '[^a-z0-9]+', '-', 'g'), '-')
                 ::extensions.citext;
      if v_contributor_id is not null and not (v_contributor_id = any(v_mine)) then
        v_mine := v_mine || v_contributor_id;
      end if;
    end if;
    v_contributor_id := null;
  end loop;
  v_work_id := null;

  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'commit_import: every item must be a JSON object'
        using errcode = '22023';
    end if;

    -- `->>` renders a non-string JSON value as its text, so an object arrived as a
    -- title reading `{"a": {"b": "c"}}`. A title is a string or the item is malformed.
    if v_item ? 'title' and jsonb_typeof(v_item -> 'title') <> 'string' then
      raise exception 'commit_import: a title must be a string' using errcode = '22023';
    end if;
    if v_item ? 'text' and jsonb_typeof(v_item -> 'text') <> 'string' then
      raise exception 'commit_import: a highlight must be a string' using errcode = '22023';
    end if;
    -- The same guard for the other two, which the commit that added it missed. `author`
    -- feeds the work slug AND a `contributors.name` that becomes visible to anyone who
    -- can see the work, and an object arrived through `->>` reading `{"nested": "object"}`.
    if v_item ? 'author' and jsonb_typeof(v_item -> 'author') <> 'string' then
      raise exception 'commit_import: an author must be a string' using errcode = '22023';
    end if;
    if v_item ? 'locator' and jsonb_typeof(v_item -> 'locator') <> 'string' then
      raise exception 'commit_import: a locator must be a string' using errcode = '22023';
    end if;
    v_title   := left(btrim(coalesce(v_item ->> 'title', '')), 200);
    v_author  := nullif(left(btrim(coalesce(v_item ->> 'author', '')), 200), '');
    v_raw     := coalesce(v_item ->> 'text', '');
    v_locator := nullif(left(btrim(coalesce(v_item ->> 'locator', '')), 200), '');

    -- Whitespace collapsed once, here, so the stored text, the headline and the dedupe
    -- key all agree. A highlight that survives a copy through three apps arrives with
    -- different line breaks and is the same highlight.
    -- Collapse first, then trim: `btrim` with one argument removes spaces only, so a
    -- highlight of tabs and newlines survived the empty check below and stored a pull
    -- whose body was a single space.
    v_clean := btrim(regexp_replace(v_raw, '\s+', ' ', 'g'));

    if v_title = '' then
      raise exception 'commit_import: an item has no title' using errcode = '22023';
    end if;
    if v_clean = '' then
      raise exception 'commit_import: an item has no text' using errcode = '22023';
    end if;
    if length(v_clean) > 20000 then
      raise exception 'commit_import: a highlight of % characters exceeds 20000',
        length(v_clean) using errcode = '22023';
    end if;

    -- Deterministic and namespaced. `imported-` can never collide with a catalogue slug,
    -- which matters: adopting the seeded `meditations` would attach a reader's private
    -- pulls to a public work and put their book in the catalogue's shape. The hash
    -- suffix keeps two different books that slugify alike apart; the readable stem is
    -- there so an operator reading the table can tell what a row is.
    v_slug := public.imported_work_slug(v_title, v_author);

    v_hash := encode(sha256(convert_to(v_slug || '|' || lower(v_clean), 'UTF8')), 'hex');

    -- THE DEDUPE CHECK COMES FIRST, before anything is created. Review found this the
    -- wrong way round: with the work and summary made ahead of it, re-uploading a file
    -- whose highlights were all already held -- or all removed by an Undo, which keeps
    -- the hashes precisely so a re-import stays a no-op -- created an empty private
    -- summary anyway, which put the book back in the reader's library with nothing in
    -- it and made the work readable to them again. A duplicate now costs one hash
    -- lookup and touches nothing.
    if exists (
      select 1 from public.import_items ii
       where ii.user_id = uid and ii.content_hash = v_hash and ii.undone_at is null
    ) then
      v_duplicates := v_duplicates + 1;
      continue;
    end if;

    -- And the ceiling is charged per row actually written, for the same reason. Counted
    -- against the whole incoming chunk it refused a reader at 19,800 highlights who
    -- re-uploaded a 500-item file of which 498 were duplicates -- an operation that
    -- would have added two rows.
    v_held := v_held + 1;
    if v_held > max_items_per_user then
      -- STOP, do not raise. A raise here aborts the transaction and rolls back every
      -- row already added in this call, so a reader with room for two of a
      -- five-hundred-item chunk stored none of them -- and with the client chunking
      -- at 500, the last few hundred highlights they had room for were all lost with
      -- a message that did not say how many would have fitted. Keeping what fits and
      -- reporting the stop is the same bound with none of that.
      v_ceiling_reached := true;
      exit;
    end if;

    -- The work is shared: two readers who import the same book land on the same row, and
    -- see each other's nothing, because 20260905101000 makes a work visible only behind a
    -- summary the caller can read and each holds only their own.
    --
    -- Qualified rather than cast to text, and this is a performance fact rather than a
    -- style one. `works.slug` is `citext` with a unique btree, and `lower(w.slug::text)`
    -- wraps the column in a function the index cannot answer -- so this ran a SEQUENTIAL
    -- SCAN, once per highlight. Measured: 0.20 s for a 500-item chunk against the 16
    -- seeded works, and 13.4 s against 60,000. `authenticated` carries an 8 s
    -- `statement_timeout`, so a full chunk begins failing outright at roughly 37,000
    -- works and the whole transaction aborts, storing nothing. This feature is itself
    -- what makes `works` grow, so it was a bomb with its own fuse.
    --
    -- The earlier comment said an unqualified `citext` cast cannot resolve under
    -- `search_path = ''`, which is true, and concluded that comparing as text was better
    -- anyway, which was wrong. Schema-qualifying the operator resolves fine and keeps the
    -- index: 25.4 ms -> 0.10 ms on the same 60,000 rows.
    select w.id into v_work_id
      from public.works w
     where w.slug operator(extensions.=) v_slug::extensions.citext;
    /*
     * MISSING MEANS THE BOOK CEILING STOPPED IT, and that is the only thing it can mean
     * now -- so this stops the call rather than raising.
     *
     * It used to raise `no work for %`, on the reasoning that the pre-pass creates
     * every work and anything absent is an item the validation should have refused.
     * That reasoning had a second case even then, and round 6 measured it: a concurrent
     * `undo_import` deleting the work between the pre-pass and here, 3 of 3, aborting a
     * 500-highlight chunk with an internal error naming a slug. That delete is gone.
     * What is left is the pre-pass declining a slug because this reader is at
     * `max_works_per_user` -- a ceiling, and every other ceiling here stops and reports
     * rather than rolling back what the reader had room for.
     */
    if v_work_id is null then
      v_ceiling_reached := true;
      exit;
    end if;

    -- `summaries unique (work_id, version, author_id)` is what makes this one row per
    -- reader per book. Published so it is reachable by the reader's own paths, private so
    -- it reaches nobody else: `get_feed` pools on published AND public.
    select s.id into v_summary_id
      from public.summaries s
     where s.work_id = v_work_id and s.author_id = uid and s.version = 1;

    if v_summary_id is null then
      insert into public.summaries
        (work_id, version, status, visibility, author_id, title, published_at)
      values
        (v_work_id, 1, 'published', 'private', uid, v_title, now())
      on conflict (work_id, version, author_id) do nothing
      returning id into v_summary_id;

      if v_summary_id is null then
        select s.id into v_summary_id
          from public.summaries s
         where s.work_id = v_work_id and s.author_id = uid and s.version = 1;
      end if;
    end if;

    v_words   := coalesce(array_length(regexp_split_to_array(v_clean, ' '), 1), 1);
    v_seconds := greatest(3, least(900, ceil(v_words / 4.0)::int));

    select coalesce(max(p.ordinal), 0) + 1 into v_ordinal
      from public.pulls p where p.summary_id = v_summary_id;

    insert into public.pulls
      (summary_id, ordinal, headline, body, estimated_read_seconds)
    values
      (v_summary_id, v_ordinal, left(v_clean, 80), v_clean, v_seconds)
    returning id into v_pull_id;

    -- Revives a tombstone rather than colliding with it. The unique key is
    -- `(user_id, content_hash)`, so an item the reader undid still occupies it; the
    -- upsert re-points it at this batch, this pull and this work and clears
    -- `undone_at`. That is what makes re-uploading the file the way to undo an Undo.
    insert into public.import_items
      (import_id, user_id, pull_id, work_id, locator, content_hash)
    values
      (v_import_id, uid, v_pull_id, v_work_id, v_locator, v_hash)
    on conflict (user_id, content_hash) do update
      set import_id = excluded.import_id,
          pull_id   = excluded.pull_id,
          work_id   = excluded.work_id,
          locator   = excluded.locator,
          undone_at = null;

    -- KEPT MEANS KEPT, and without these two rows it did not. `get_due_reviews` is driven
    -- from `knowledge_states` and the Library screen reads `saved_items`, so a highlight
    -- that landed as a pull and nothing else appeared in neither -- while this file's own
    -- header and `docs/privacy.md` both say an import flows through the mechanics the
    -- product already has. Review found it, and it was the difference between a feature
    -- and a table.
    --
    -- The same two writes `remember_pull` makes, for the same reason and with the same
    -- shape: acquired by saving rather than by reading, and due tomorrow at the default
    -- stability, like anything else newly acquired.
    insert into public.knowledge_states (user_id, pull_id, acquired_via)
    values (uid, v_pull_id, 'saved')
    on conflict (user_id, pull_id) do nothing;

    insert into public.saved_items (user_id, pull_id)
    values (uid, v_pull_id)
    on conflict (user_id, pull_id) where pull_id is not null
      do nothing;

    v_added := v_added + 1;
    if not (v_work_id = any(v_touched)) then
      v_touched := v_touched || v_work_id;
    end if;
  end loop;

  update public.imports
     set item_count      = item_count + v_added,
         duplicate_count = duplicate_count + v_duplicates,
         work_count      = (
           select count(distinct ii.work_id)
             from public.import_items ii
            where ii.import_id = v_import_id
         )
   where id = v_import_id;

  select coalesce(
           jsonb_agg(jsonb_build_object('workId', w.id, 'title', w.title, 'slug', w.slug)
                     order by w.title),
           '[]'::jsonb
         )
    into v_works_out
    from public.works w
   where w.id = any(v_touched);

  return jsonb_build_object(
    'importId',       v_import_id,
    'added',          v_added,
    'duplicates',     v_duplicates,
    -- So the screen can say "we kept the first N; you are at your limit" rather than
    -- leaving a reader to work out why a file half arrived.
    'ceilingReached', v_ceiling_reached,
    'works',          v_works_out
  );
end;
$$;

comment on function public.commit_import is
  'Keep a batch of highlights as private pulls the reader authored. Definer: a reader may not write the triple.';

revoke all on function public.commit_import(text, text, jsonb, uuid) from public, anon;
grant execute on function public.commit_import(text, text, jsonb, uuid) to authenticated;

-- -------------------------------------------------------------------- undo_import
--
-- Definer for the same reason `commit_import` is: the rows to remove are pulls, and a
-- reader has no delete policy on `pulls` and should not be given one. Scoped by the
-- ownership check on the batch, so it can only ever unwind the caller's own.
--
-- Deleting the pull is enough to take the whole idea back: `knowledge_states` and
-- `saved_items` cascade from it, so a highlight that was scheduled for review stops being
-- scheduled. The `import_items` row survives with a null `pull_id` and an `undone_at` --
-- the dedupe key is the record that this reader has seen this highlight, and erasing it
-- would make the next import hand back everything they just removed.
--
-- THE TEXT COMES BACK; THE WORK BUILT ON IT DOES NOT. The timestamp is what makes the
-- first half true: an undone item stops counting against the ceiling and stops blocking a
-- re-import, so uploading the same file again restores the highlights. Without it this was
-- a one-way door in every direction -- no restore, no delete policy on `import_items`, and
-- the ceiling still charging for highlights the reader no longer had.
--
-- The claim written here when that landed said it "restores exactly what was taken", and
-- that is false, which matters because `docs/privacy.md` repeated it on a page served at
-- /privacy. Seventeen tables cascade from `pulls`, six of them holding the reader's own
-- writing: `user_questions`, `recall_events`, `notes`, `highlights`, `explanations` and
-- `convictions`. A re-import mints a NEW pull id, so none of it reattaches. Measured: one
-- highlight with a question the reader wrote, two grades, a note and a highlight -- undo,
-- re-upload, and the text is back with all six gone.
--
-- Kept as a hard delete rather than made non-destructive, and that is a decision rather
-- than an omission. Leaving the pull standing would leave the book in the reader's
-- library with the summary still readable behind it, which is precisely what an Undo is
-- for taking away. Deleting an idea deletes what hangs off it; the defect was the promise,
-- not the behaviour.
--
-- So the promise is now the truth, in three places: here, in `docs/privacy.md`, and in the
-- return value -- which carries the counts of what went with the pulls, so the screen that
-- eventually hangs off this can say "this also removed 2 questions you wrote and 5 grades".
-- AFTER the fact, and the earlier version of this sentence said before, which this function
-- cannot do: the counts are computed on the way past and returned once the rows are gone.
-- Saying it first needs a dry run, which does not exist and belongs with the screen that
-- would call it.
--
-- The work does not always stand. A work this batch created that nothing else now uses --
-- no summary at all, no item from another batch -- goes with the highlights, and so does
-- a contributor left with no work. That is not tidiness: the ceiling bounds shared-row
-- creation by the room left under it, an Undo gives that room back, and without this the
-- two cancel into unbounded growth. See the delete below.
create function public.undo_import(p_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid       uuid := (select auth.uid());
  v_import  public.imports;
  v_removed int  := 0;
  v_emptied uuid[] := '{}';
  v_lost_questions  int := 0;
  v_lost_grades     int := 0;
  v_lost_notes      int := 0;
  v_lost_highlights int := 0;
  v_lost_explanations int := 0;
  v_lost_convictions  int := 0;
  v_orphan_works uuid[] := '{}';
  v_orphan_contributors uuid[] := '{}';
begin
  if uid is null then
    raise exception 'undo_import requires an authenticated user';
  end if;

  -- The lock comes FIRST, above the read it protects. Taken after it, a retry arriving
  -- while the first call was still in flight read `undone_at` as null, passed the
  -- idempotency guard, waited here, and then found nothing to do -- so both calls
  -- returned `alreadyUndone: false` and a client rendered the second as "we removed
  -- nothing" rather than "already undone". The end state was right; the answer was not,
  -- and the comment below names precisely the case it was getting wrong.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 1));

  select * into v_import
    from public.imports i
   where i.id = p_import_id and i.user_id = uid;

  if not found then
    raise exception 'undo_import: no such import' using errcode = '42704';
  end if;

  -- Idempotent: a second Undo, a retried request or a double-tap all report the same
  -- thing rather than doing it again.
  if v_import.undone_at is not null then
    return jsonb_build_object(
      'importId', v_import.id, 'removed', 0, 'alreadyUndone', true
    );
  end if;

  /*
   * Counted before the delete, because after it there is nothing left to count.
   *
   * These are the reader's own writing, and they are about to go. The numbers exist so
   * the caller can say what an Undo cost -- past tense, and the earlier version of this
   * sentence said "while it is still a question", which is a dry run this function does
   * not have. Counting here rather than after is what makes even the past tense possible.
   */
  select
    count(*) filter (where t.kind = 'question'),
    count(*) filter (where t.kind = 'grade'),
    count(*) filter (where t.kind = 'note'),
    count(*) filter (where t.kind = 'highlight'),
    count(*) filter (where t.kind = 'explanation'),
    count(*) filter (where t.kind = 'conviction')
    into v_lost_questions, v_lost_grades, v_lost_notes, v_lost_highlights,
         v_lost_explanations, v_lost_convictions
    from (
      select 'question' as kind from public.user_questions q
       where q.user_id = uid and q.pull_id in (
         select ii.pull_id from public.import_items ii
          where ii.import_id = p_import_id and ii.user_id = uid and ii.pull_id is not null)
      union all
      select 'grade' from public.recall_events r
       where r.user_id = uid and r.pull_id in (
         select ii.pull_id from public.import_items ii
          where ii.import_id = p_import_id and ii.user_id = uid and ii.pull_id is not null)
      union all
      select 'note' from public.notes n
       where n.user_id = uid and n.pull_id in (
         select ii.pull_id from public.import_items ii
          where ii.import_id = p_import_id and ii.user_id = uid and ii.pull_id is not null)
      union all
      select 'highlight' from public.highlights h
       where h.user_id = uid and h.pull_id in (
         select ii.pull_id from public.import_items ii
          where ii.import_id = p_import_id and ii.user_id = uid and ii.pull_id is not null)
      -- The header names SIX tables of the reader's own writing that cascade from
      -- `pulls`, and the first version of this counted four. A confirmation screen
      -- built on it would have been wrong by two whole categories, in the change
      -- whose stated purpose was that the promise is now the truth.
      union all
      select 'explanation' from public.explanations x
       where x.user_id = uid and x.pull_id in (
         select ii.pull_id from public.import_items ii
          where ii.import_id = p_import_id and ii.user_id = uid and ii.pull_id is not null)
      union all
      select 'conviction' from public.convictions c
       where c.user_id = uid and c.pull_id in (
         select ii.pull_id from public.import_items ii
          where ii.import_id = p_import_id and ii.user_id = uid and ii.pull_id is not null)
    ) t;

  with gone as (
    delete from public.pulls p
     where p.id in (
       select ii.pull_id from public.import_items ii
        where ii.import_id = p_import_id
          and ii.user_id = uid
          and ii.pull_id is not null
     )
    returning p.summary_id
  )
  select count(*), coalesce(array_agg(distinct summary_id), '{}')
    into v_removed, v_emptied
    from gone;

  -- The items become tombstones rather than claims: they keep the fingerprint, so an
  -- accidental re-upload of something still held is a no-op, and stop counting against
  -- the ceiling and stop blocking a deliberate re-import of what was just removed.
  update public.import_items
     set undone_at = now()
   where import_id = p_import_id and user_id = uid and undone_at is null;

  -- A book with no highlights left is not a book the reader has. Their summary is the
  -- only thing holding it in their library, so it goes too -- bounded to THE SUMMARIES
  -- THIS BATCH'S OWN PULLS BELONGED TO, and nothing else.
  --
  -- The bound is the fix for a real defect, and it took two goes to get right. The
  -- first version matched every empty private summary the caller authored on any
  -- `user_owned` work, so undoing a batch about book Y deleted an unrelated draft they
  -- had started about book X. Scoping by WORK was not enough either: a reader can hold
  -- a second summary of the same book (`summaries` is unique per work, version and
  -- author), so a draft about the very book being undone would still have gone. Only
  -- the summary a deleted pull actually hung from is this batch's to clean up.
  delete from public.summaries s
   where s.id = any(v_emptied)
     and s.author_id = uid
     and s.visibility = 'private'
     and not exists (select 1 from public.pulls p where p.summary_id = s.id);

  /*
   * NOTHING SHARED IS DELETED HERE, and round 5's attempt to is recorded because it
   * looked obviously right and was three separate ways of losing a reader's data.
   *
   * It deleted the `works` this batch created that nothing else appeared to use, to
   * stop the item ceiling (which bounds shared-row creation by the room left) and the
   * Undo (which frees that room) cancelling into unbounded growth. All three of its
   * guards are evaluated against the deleting statement's snapshot, and
   * `summaries.work_id` is `on delete cascade`:
   *
   *   * ANOTHER READER'S IMPORT, IN FLIGHT, IS DESTROYED. B's `commit_import` holds a
   *     `for key share` lock on the shared work but its rows are invisible to A, so
   *     A's delete passes the guards, waits on the lock, and does not re-check. The
   *     cascade takes B's summary, B's pull, `knowledge_states` and `saved_items`.
   *     Measured 12 silent losses in 14 ordinary runs -- B's call returns `added: 500`
   *     with no error, B has 499 pulls, and the dedupe tombstone then refuses the
   *     re-upload that is supposed to be the way back.
   *   * OR THE IMPORT ABORTS. The other crossing order lands A's delete between B's
   *     pre-pass and B's item loop, and the loop raises `no work for %` on a slug.
   *     3 of 3.
   *   * OR A BYLINE GOES. `work_contributors.contributor_id` cascades too, so A's
   *     delete strips the author off B's just-committed book. 3 of 4.
   *
   * And it bounded nothing. The guard read `import_items ii2 where ii2.import_id <>
   * p_import_id` -- no user filter, no `undone_at` filter -- so any second batch that
   * ever touched the work pinned it forever, including a fully undone one. Importing
   * each title into two batches and undoing both left 500 works and 500 contributors
   * per five cycles with the item quota fully refunded: the exact cancellation it was
   * written to close.
   *
   * The bound belongs where the row is CREATED, which is a decision one transaction
   * can make about itself. See `max_created_per_user` in `commit_import`.
   */
  update public.imports set undone_at = now() where id = p_import_id;

  -- `alsoRemoved` is the count of everything that went with the highlights, AFTER it
  -- has gone. See the header: a re-import brings the text back and reattaches none of
  -- it, so this is what a Library screen reports rather than what it warns with --
  -- warning beforehand needs a dry run, which this function does not have and which
  -- belongs with the screen that would call it.
  --
  -- It counts every category that cascades, which the first version did not: it named
  -- four of the six tables of the reader's own writing the header lists, so a
  -- confirmation built on it would have been wrong by two whole categories, in the
  -- change whose stated purpose is that the promise is now the truth.
  return jsonb_build_object(
    'importId', p_import_id,
    'removed', v_removed,
    'alreadyUndone', false,
    'alsoRemoved', jsonb_build_object(
      'questions', v_lost_questions,
      'grades', v_lost_grades,
      'notes', v_lost_notes,
      'highlights', v_lost_highlights,
      'explanations', v_lost_explanations,
      'convictions', v_lost_convictions
    )
  );
end;
$$;

comment on function public.undo_import is
  'Take a batch of kept highlights back. Idempotent; leaves the dedupe record so a re-import stays a no-op.';

revoke all on function public.undo_import(uuid) from public, anon;
grant execute on function public.undo_import(uuid) to authenticated;

-- ------------------------------------------------------------------- remember_pull
--
-- `security invoker`, unlike the two above, and that is the point: everything it writes
-- is a row a reader already has a policy for, so it runs as them and the policies do the
-- checking. In particular the insert into `user_questions` is checked by
-- `user_questions_insert_own`, whose `exists` on `pulls` runs under the caller's own RLS
-- -- so a question against a pull they cannot read is refused by the policy rather than
-- by an argument in here that could drift away from it.
--
-- Guests may. A guest can already grade, save and write an explanation; a question they
-- wrote for themselves is the same act and lives in the same account.
create function public.remember_pull(
  p_pull_id     uuid,
  p_prompt      text,
  p_answer      text default null,
  p_kind        text default 'recall',
  p_mutation_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid       uuid := (select auth.uid());
  v_id      uuid;
  v_created boolean := true;
begin
  if uid is null then
    raise exception 'remember_pull requires an authenticated user';
  end if;

  insert into public.user_questions
    (user_id, pull_id, kind, prompt, answer, client_mutation_id)
  values
    (uid, p_pull_id, coalesce(p_kind, 'recall'), btrim(p_prompt), nullif(btrim(coalesce(p_answer, '')), ''),
     p_mutation_id)
  on conflict (user_id, client_mutation_id) where client_mutation_id is not null
    do nothing
  returning id into v_id;

  -- A replay carrying an id already on record writes nothing and says so, exactly as
  -- grade_recall does. The id it returns is the one the first call created.
  if v_id is null then
    v_created := false;
    select uq.id into v_id
      from public.user_questions uq
     where uq.user_id = uid and uq.client_mutation_id = p_mutation_id;

    if v_id is null then
      raise exception 'remember_pull: the question was neither written nor found';
    end if;
  end if;

  -- Writing a question about an idea is a claim to want it back, so it enters the
  -- scheduler if it is not already there -- tomorrow, at the default stability, like
  -- anything else newly acquired. An idea already in review keeps its own schedule:
  -- being asked about is not evidence about when it should next be asked.
  insert into public.knowledge_states (user_id, pull_id, acquired_via)
  values (uid, p_pull_id, 'saved')
  on conflict (user_id, pull_id) do nothing;

  insert into public.saved_items (user_id, pull_id)
  values (uid, p_pull_id)
  on conflict (user_id, pull_id) where pull_id is not null
    do nothing;

  return jsonb_build_object('questionId', v_id, 'created', v_created);
end;
$$;

comment on function public.remember_pull is
  'Write your own question about an idea, and put it in review. Replay-safe by client_mutation_id.';

revoke all on function public.remember_pull(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.remember_pull(uuid, text, text, text, uuid) to authenticated;

-- --------------------------------------------------------------- get_due_reviews
--
-- Restated, same signature, so every caller keeps working and `create or replace` is
-- enough: the client calls it by name with no arguments, and `scripts/smoke-read-path.sql`
-- needs the top level to stay an array, which it does.
--
-- What changes is which question a reader is asked. Their own, unretired, most recent,
-- if they have written one; otherwise the canonical one; otherwise nothing and the screen
-- falls back to free recall as it does today. `questionSource` says which, so Review can
-- label it and so `grade_recall` can be told what the id means.
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
      -- All three off ONE decision, made in `chosen` below. They used to be
      -- computed separately -- two coalesces and a `case` on `mine.id` -- which
      -- meant they could describe different questions. A review mutant that
      -- reversed the coalesces made this return the canonical prompt and the
      -- canonical id while still reporting `questionSource: 'user'`, and
      -- `grade_recall` would then have filed the answer in `quiz_question_id`
      -- against a source the caller was told was theirs. The fields cannot
      -- disagree now because there is nothing left to disagree about.
      'question', chosen.prompt,
      'questionId', chosen.id,
      'questionSource', chosen.source
    ) as t
    from public.knowledge_states ks
    join public.pulls p on p.id = ks.pull_id
    join public.summaries s on s.id = p.summary_id
    join public.works w on w.id = s.work_id
    left join lateral (
      select uq.id, uq.prompt
        from public.user_questions uq
       where uq.user_id = uid and uq.pull_id = p.id and uq.retired_at is null
       order by uq.created_at desc
       limit 1
    ) mine on true
    left join lateral (
      select q.id, q.prompt
        from public.quiz_questions q
       where q.pull_id = p.id
       limit 1
    ) canon on true
    -- The reader's own question wins, and this is the only place that says so.
    left join lateral (
      select
        coalesce(mine.id, canon.id) as id,
        coalesce(mine.prompt, canon.prompt) as prompt,
        case
          when mine.id is not null then 'user'
          when canon.id is not null then 'canonical'
          else null
        end as source
    ) chosen on true
    where ks.user_id = uid and ks.next_due_at <= now()
    order by public.retrievability(ks.stability, ks.last_seen_at) asc
    limit p_limit
  ) x;

  return res;
end;
$$;

comment on function public.get_due_reviews is
  'The reader''s due ideas, each with their own question if they wrote one and the canonical one otherwise.';

-- ------------------------------------------------------------------- grade_recall
--
-- Same signature, so nothing that calls it changes -- `record_interrupt` included -- and
-- `create or replace` is enough. One thing is different in the body: `p_question_id` may
-- now name a question the reader wrote, and those live in a different table.
--
-- Routed by lookup rather than by a new `p_source` argument, deliberately. A new argument
-- would have forced a drop-and-recreate of both this function and `record_interrupt` (the
-- overload resolution failure 20260905100000 already had to work around), and it would
-- have let a caller assert the wrong source for an id, which the lookup cannot: the id is
-- accepted as the reader's own only if it really is one of theirs, on this pull. Anything
-- else stays on the canonical column, where the composite foreign key refuses it if it is
-- not a real question of that pull.
create or replace function public.grade_recall(
  p_pull_id      uuid,
  p_grade        public.recall_grade,
  p_mutation_id  uuid        default null,
  p_submitted_at timestamptz default null,
  p_confidence   text        default null,
  p_question_id  uuid        default null,
  p_kind         text        default 'review',
  p_latency_ms   int         default null,
  p_answer       text        default null
)
returns public.knowledge_states
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid       uuid := (select auth.uid());
  ks        public.knowledge_states;
  ev_id     uuid;
  new_s     double precision;
  new_d     double precision;
  v_mine    uuid;
  v_canon   uuid;
begin
  if uid is null then
    raise exception 'grade_recall requires an authenticated user';
  end if;

  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(uid::text || ':' || p_pull_id::text, 0)
  );

  -- Which column the id belongs in. The read runs under the caller's own RLS, so a
  -- stranger's question id simply fails to match and falls through to the canonical
  -- column, where the composite key rejects it.
  if p_question_id is not null then
    select uq.id into v_mine
      from public.user_questions uq
     where uq.id = p_question_id
       and uq.user_id = uid
       and uq.pull_id = p_pull_id;

    if v_mine is null then
      v_canon := p_question_id;
    end if;
  end if;

  select * into ks
  from public.knowledge_states
  where user_id = uid and pull_id = p_pull_id;

  if not found then
    insert into public.knowledge_states (user_id, pull_id, acquired_via)
    values (uid, p_pull_id, 'quizzed')
    returning * into ks;
  end if;

  -- The arithmetic is unchanged from 20260829130252, and from 20260905100000 which
  -- moved it above the insert so the event could carry its own outcome.
  new_d := ks.difficulty;

  case p_grade
    when 'forgot' then
      new_s := greatest(0.5, ks.stability * 0.35);
      new_d := least(1.0, new_d + 0.15);
    when 'hard' then
      new_s := ks.stability * 1.2;
      new_d := least(1.0, new_d + 0.05);
    when 'good' then
      new_s := ks.stability * (2.0 + 1.0 * (1.0 - new_d));
    when 'easy' then
      new_s := ks.stability * (3.0 + 1.5 * (1.0 - new_d));
      new_d := greatest(0.0, new_d - 0.05);
  end case;

  new_s := least(new_s, 730.0);

  insert into public.recall_events
    (user_id, pull_id, quiz_question_id, user_question_id, kind, grade, confidence,
     answer, latency_ms, client_mutation_id, submitted_at, stability_before, stability_after)
  values
    (uid, p_pull_id, v_canon, v_mine, p_kind, p_grade, p_confidence,
     p_answer, p_latency_ms, p_mutation_id, p_submitted_at, ks.stability, new_s)
  on conflict (user_id, client_mutation_id) where client_mutation_id is not null
    do nothing
  returning id into ev_id;

  if ev_id is null then
    return ks;
  end if;

  update public.knowledge_states
     set stability    = new_s,
         difficulty   = new_d,
         reps         = reps + 1,
         lapses       = lapses + (case when p_grade = 'forgot' then 1 else 0 end),
         last_seen_at = now(),
         next_due_at  = now() + (new_s || ' days')::interval
   where user_id = uid and pull_id = p_pull_id
   returning * into ks;

  return ks;
end;
$$;

comment on function public.grade_recall is
  'Record a recall attempt and reschedule the item. Replay-safe by client_mutation_id. Half-Life mechanic.';

-- --------------------------------------------------- delete_my_account, again
--
-- `20260901140000` removes `summaries where author_id = uid and visibility <> 'public'`,
-- and until now that was the whole set a reader could have authored. This migration makes
-- it the wrong test, because it is the first thing to put THIRD-PARTY VERBATIM TEXT behind
-- `summaries.author_id` -- twenty thousand highlights a reader, stored as `user_owned` on
-- the strength of that reader owning a copy.
--
-- The gap is reachable with three ordinary calls, all permitted:
--
--   1. `commit_import(...)` -- highlights land under a private summary.
--   2. `PATCH /summaries?id=eq.<s>` with `{"status":"draft","visibility":"public"}` --
--      accepted, because `summaries_author_update` bars only `published` AND `public`.
--   3. `delete_my_account()` -- skips that summary on `visibility <> 'public'`, and the
--      account row going away then sets `author_id` to null (`on delete set null`).
--
-- What is left is an ownerless, private-in-effect summary whose pulls still hold the
-- publisher's paragraphs. Nothing can read it -- `summary_is_readable` is false for a
-- draft with no author -- so this is retention rather than exposure, and it is exactly the
-- retention the RPC exists to prevent. No sweep will ever collect it, `docs/privacy.md`
-- says an import goes with the account, and law 4 says we do not keep the source text.
-- Verified before fixing: the flipped summary and its imported pull both survived, body
-- intact, `author_id` null.
--
-- The predicate deliberately does NOT match the update policy's own, and the two
-- attempts that did are recorded beside it below. Anything the reader did not publish to
-- the world goes with them, and so does anything they IMPORTED, however they have since
-- moved or re-labelled it. A summary genuinely published to the world and not imported
-- stays, which is the existing and deliberate behaviour -- it is part of the catalogue by
-- then, and `20260830203352` is what makes reaching that state a decision rather than an
-- accident.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  age int;
begin
  if uid is null then
    raise exception 'delete_my_account requires an authenticated user';
  end if;

  age := public.session_age_seconds();
  if age is null or age > 600 then
    raise exception
      'Deleting an account needs a recent sign-in. Request a new code, enter it, '
      'and try again.'
      using errcode = '28000';
  end if;

  delete from public.generation_jobs g where g.requester_id = uid;
  /*
   * Bounded to the reader's OWN material, which is what this migration widened it for.
   *
   * The first version was `not (status = 'published' and visibility = 'public')`,
   * matching the update policy's predicate -- and that reached further than intended.
   * `pipeline.ts` writes a canonical summary as `draft` + `public` with the requester
   * as author, and it becomes `published` only at the final step; so a canonical
   * generation sits in exactly that state for the whole run, and permanently for any
   * job that dies before publishing. One requester closing their account destroyed
   * shared catalogue content the project paid for and stranded its work. Verified:
   * the summary and its pulls were both gone.
   *
   * THE SECOND VERSION READ THE WORK'S CURRENT `rights_status`, AND THE READER CAN
   * MOVE THE SUMMARY. `summaries_author_update` constrains `author_id`, the
   * published+public pair, and `work_is_authorable(work_id)` -- which is true of every
   * catalogue work, because every catalogue work carries a published public summary.
   * `authenticated` holds column UPDATE on `work_id`, so one PATCH sets
   * `work_id = <any seeded work>, status = 'draft', visibility = 'public'` and neither
   * leg matches any more. Verified: the summary and its pulls survived
   * `delete_my_account` with the reader's `auth.users` row gone, leaving an ownerless
   * summary whose pulls hold a publisher's paragraphs -- the exact state described
   * above, reached by the one column the predicate did not look at.
   *
   * So it asks PROVENANCE instead, which the reader cannot move: `import_items` is
   * read-only through the API, `pulls` has no update policy, and the item names the
   * pull it created. A summary this reader imported into goes, wherever its work now
   * points and whatever they set its visibility to. A canonical draft has no
   * `import_items` behind it and stays.
   */
  delete from public.summaries s
   where s.author_id = uid
     and (
       s.visibility <> 'public'
       or exists (
         select 1
           from public.import_items ii
           join public.pulls p on p.id = ii.pull_id
          where ii.user_id = uid and p.summary_id = s.id
       )
     );

  delete from auth.users u where u.id = uid;
end;
$$;

revoke all on function public.delete_my_account() from anon, authenticated, public;
grant execute on function public.delete_my_account() to authenticated;
