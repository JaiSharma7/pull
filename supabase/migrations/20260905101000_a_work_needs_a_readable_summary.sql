-- A work is readable when something readable sits behind it.
--
-- `works_read_all` is `using (true)` because a work is a bibliographic record the feed
-- needs: a title and a kind describe a source, and every path that lists works filters
-- harder than the policy does -- `get_feed` takes public summaries only, the catalogue and
-- `search_catalogue` require a public summary behind a work before they count it, and a
-- source page is covered by the author clause on `summaries`. That was fine while every
-- row came from the seed or from the pipeline.
--
-- The next migration lets a reader import their Kindle highlights, and each imported book
-- becomes a `works` row with rights `user_owned` behind a private summary. Under
-- `using (true)` that turns the table into a directory of what every reader has been
-- reading, one `GET /rest/v1/works?select=title` away -- and the column grants from
-- 20260831013500, which exist to hide the content hash, would be hiding the wrong column.
--
-- So the policy now states what every reader of the table already assumes: a work is
-- visible when at least one of its summaries is readable by the caller -- published and
-- public, or authored by them. Nothing that currently lists works returns anything
-- different, because each already required exactly that. What changes is that a row with
-- nothing readable behind it stops being enumerable, which is the property an import
-- needs before it can exist.
--
-- Cost: a correlated EXISTS over `summaries (work_id)`, served by the FK index. `get_feed`
-- joins works once per candidate in a pool of a few hundred rows and `summary_is_readable`
-- is an inlinable stable SQL function, so the planner sees the same predicate the join
-- already carries. The column grants are untouched: this narrows rows, not columns.

drop policy works_read_all on public.works;

create policy works_read_readable on public.works
  for select using (
    exists (
      select 1
      from public.summaries s
      where s.work_id = works.id
        and public.summary_is_readable(s)
    )
  );

comment on policy works_read_readable on public.works is
  'A work is visible when one of its summaries is: published and public, or authored by the caller.';

-- ------------------------------------------------- and the door the policy left open
--
-- Review finding, and it defeats everything above. `summaries_author_insert`
-- (20260901190000:226, superseding 20260830203352) checks that the author is the caller,
-- that the row is not published-and-public, and that the caller is not a guest. It says
-- nothing at all about `work_id`. So a signed-in reader who holds a work's UUID may
-- insert a private summary naming that work, at which point `summary_is_readable` is true
-- for a row they own and the EXISTS above hands them the title the policy was written to
-- hide. UUIDs are not a secret to build on: `work_topics_read_all` is still
-- `using (true)`, and a private work's row can be reached from there.
--
-- The narrowest true statement is: a reader may author a summary on a work that is
-- already public. That is what the feature the policy exists for actually needs -- a
-- reader's own commentary on something in the catalogue -- and it is exactly what an
-- attacker cannot use, because a work that is already public has no title left to leak.
--
-- Every legitimate writer of a private summary on a NON-public work bypasses RLS and is
-- unaffected: the pipeline runs as `service_role`, and the next migration's
-- `commit_import` is `security definer` for this reason among others. Nothing in
-- `apps/web` inserts a summary at all.
--
-- The predicate cannot be written inline. A policy on `summaries` whose USING clause
-- selects from `summaries` re-enters the same policy and Postgres refuses it as infinite
-- recursion, so the lookup goes through a definer function, which reads the table without
-- RLS and so terminates. It leaks nothing a reader cannot already see: whether a work has
-- a public summary is precisely what the `works` policy above already tells them.

create function public.work_is_public(p_work_id uuid)
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.summaries s
    where s.work_id = p_work_id
      and s.status = 'published'
      and s.visibility = 'public'
  );
$$;

comment on function public.work_is_public is
  'Does this work carry a published, public summary? SECURITY DEFINER so the summaries '
  'insert policy can ask without re-entering its own policy. Reveals nothing the works '
  'policy does not.';

revoke all on function public.work_is_public(uuid) from public, anon;
grant execute on function public.work_is_public(uuid) to authenticated;

-- Append-only per law 6: this supersedes 20260901190000's policy rather than editing it.
-- The three clauses it already carried are kept verbatim and the work clause is added, so
-- a guest still fails on the guest clause and an author still cannot publish to the world.
drop policy if exists summaries_author_insert on public.summaries;
create policy summaries_author_insert on public.summaries
  for insert
  with check (
    (select auth.uid()) = author_id
    and not (status = 'published' and visibility = 'public')
    and not (select public.is_guest())
    and (select public.work_is_public(work_id))
  );

comment on policy summaries_author_insert on public.summaries is
  'An author may insert their own non-public summary, and only on a work that is already '
  'public -- otherwise attaching one to a stranger''s private work would make that work '
  'readable through works_read_readable. Guests may not author at all. The pipeline and '
  'commit_import bypass RLS. See 20260830203352, 20260901190000 and this migration.';
