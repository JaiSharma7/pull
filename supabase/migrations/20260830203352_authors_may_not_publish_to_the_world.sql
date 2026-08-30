-- Owning a summary is not the same as being allowed to publish it.
--
-- `summaries_author_insert` and `summaries_author_update` (20260829125021) check only
-- that `auth.uid() = author_id`. `status` and `visibility` are left entirely to the
-- caller. That was inert while nothing set `author_id` on a generated row — and this
-- branch is what changed that: `createSummary` now assigns `author_id = requester_id`,
-- which it must, or a private summary is unreadable by the person who asked for it.
--
-- The consequence is that the requester ends up owning the row the service role just
-- generated, and `summary_is_readable` is
--
--     (status = 'published' and visibility = 'public')
--       or (author_id is not null and author_id = auth.uid())
--
-- so flipping two columns makes it world-readable.
--
-- Two distinct attacks, both closed by the same clause:
--
--   PUBLISH  Every job is created `private` (the enqueue default), and BOTH rights
--            gates short-circuit on private jobs — `resolve_identity` checks rights
--            only when visibility is public, and `moderate` returns early. So any
--            reader could submit a copyrighted chapter, have the pipeline generate a
--            real summary with real Pulls and real embeddings as service_role, then
--            PATCH visibility to public. Law 4 bypassed, `critic` bypassed, and the
--            Pulls become eligible for the feed because the pipeline embedded them.
--
--   POISON   `findPublishedSummaryByHash` — the reuse branch this PR introduces —
--            trusts any summary that is published and public. A reader could INSERT
--            exactly that row against a known `content_hash`, and every later job
--            fingerprinting that source would adopt it, skip synthesis, and report
--            success while serving attacker-authored content to strangers.
--
-- The narrowest true statement is: published-and-public is a state only `moderate`
-- may put a row into. service_role bypasses RLS, so the pipeline is unaffected — this
-- constrains the API roles and nothing else. Authors keep every other edit, including
-- unpublishing their own work.
--
-- Append-only per law 6: this supersedes the two policies rather than editing them.

drop policy if exists summaries_author_insert on public.summaries;
create policy summaries_author_insert on public.summaries
  for insert
  with check (
    (select auth.uid()) = author_id
    and not (status = 'published' and visibility = 'public')
  );

drop policy if exists summaries_author_update on public.summaries;
create policy summaries_author_update on public.summaries
  for update
  using ((select auth.uid()) = author_id)
  with check (
    (select auth.uid()) = author_id
    and not (status = 'published' and visibility = 'public')
  );

comment on policy summaries_author_insert on public.summaries is
  'An author may create their own summary, but never directly in the published+public '
  'state — that transition belongs to the pipeline moderate gate, which is the only '
  'place rights are checked. See 20260830203352.';

comment on policy summaries_author_update on public.summaries is
  'An author may edit and unpublish their own summary, but may not make it '
  'published+public: that would bypass both rights gates, since every enqueued job is '
  'private by default and both gates short-circuit on private. See 20260830203352.';
