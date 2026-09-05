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
  p_items       jsonb
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

  uid          uuid := (select auth.uid());
  v_import_id  uuid;
  v_item       jsonb;
  v_title      text;
  v_author     text;
  v_raw        text;
  v_locator    text;
  v_clean      text;
  v_slug_body  text;
  v_slug       text;
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
  v_touched    uuid[] := '{}';
  v_works_out  jsonb;
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

  -- One batch per file, even when the file arrives in six calls. Outside the window a
  -- fresh batch is right: re-importing a clippings file that has grown since is a new
  -- act, and its already-held highlights fall out as duplicates rather than as rows.
  if p_file_hash is not null then
    select i.id into v_import_id
      from public.imports i
     where i.user_id = uid
       and i.source_kind = p_source_kind
       and i.file_hash = p_file_hash
       and i.undone_at is null
       and i.created_at > now() - reuse_window
     order by i.created_at desc
     limit 1;
  end if;

  if v_import_id is null then
    insert into public.imports (user_id, source_kind, file_hash)
    values (uid, p_source_kind, p_file_hash)
    returning id into v_import_id;
  end if;

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
    v_slug_body := btrim(
      regexp_replace(lower(v_title || ' ' || coalesce(v_author, '')), '[^a-z0-9]+', '-', 'g'),
      '-'
    );
    v_slug := 'imported-'
      || coalesce(nullif(left(v_slug_body, 60), ''), 'untitled')
      || '-'
      || left(
           encode(
             sha256(convert_to(lower(v_title) || '|' || lower(coalesce(v_author, '')), 'UTF8')),
             'hex'
           ),
           8
         );

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
    -- Matched on `lower(slug::text)` rather than against a `citext` literal. `search_path`
    -- is pinned empty here and `citext` lives in `extensions`, so an unqualified cast does
    -- not resolve at all. Qualifying it would work; comparing as text is better anyway,
    -- because every slug this function writes is lowercase by construction, which makes
    -- the comparison exact rather than dependent on which `=` operator resolution picks.
    -- `attribute_work` matches contributors the same way, for the same reason.
    select w.id into v_work_id from public.works w where lower(w.slug::text) = v_slug;
    if v_work_id is null then
      insert into public.works (kind, title, slug, rights_status)
      values ('book', v_title, v_slug, 'user_owned')
      on conflict (slug) do nothing
      returning id into v_work_id;

      if v_work_id is null then
        select w.id into v_work_id from public.works w where lower(w.slug::text) = v_slug;
      end if;

      if v_author is not null then
        perform public.attribute_work(v_work_id, v_author);
      end if;
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

revoke all on function public.commit_import(text, text, jsonb) from public, anon;
grant execute on function public.commit_import(text, text, jsonb) to authenticated;

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
-- AND IT IS REVERSIBLE. The timestamp is what makes it so: an undone item stops counting
-- against the ceiling and stops blocking a re-import, so uploading the same file again
-- restores exactly what was taken. Without it this was a one-way door -- no restore, no
-- delete policy on `import_items`, and the ceiling still charging for highlights the
-- reader no longer had. What survives an Undo is therefore the fingerprint, the book and
-- the location, and `docs/privacy.md` says so rather than promising less.
--
-- The work is left standing. Nothing has to clean it up, because 20260905101000 already
-- decides what a work with nothing readable behind it is worth: invisible.
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
begin
  if uid is null then
    raise exception 'undo_import requires an authenticated user';
  end if;

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

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text, 1));

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

  update public.imports set undone_at = now() where id = p_import_id;

  return jsonb_build_object(
    'importId', p_import_id, 'removed', v_removed, 'alreadyUndone', false
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
      'question', coalesce(mine.prompt, canon.prompt),
      'questionId', coalesce(mine.id, canon.id),
      'questionSource',
        case
          when mine.id is not null then 'user'
          when canon.id is not null then 'canonical'
          else null
        end
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
