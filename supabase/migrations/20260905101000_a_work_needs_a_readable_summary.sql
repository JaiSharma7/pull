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
