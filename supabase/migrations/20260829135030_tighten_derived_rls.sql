-- Codex review, two P1 findings: RLS does not propagate through a foreign key.
--
-- `artworks` and `pull_relations` were both `using (true)`, on the assumption
-- that a row is only reachable via a summary the reader can already see. That
-- assumption is wrong — PostgREST lets a client query either table directly.
--
--   * artworks leaked storage_path, prompt, model and cost_cents for artwork
--     belonging to draft, unlisted or another user's private summaries.
--   * pull_relations leaked the IDs of private pulls plus the rationale text,
--     which is written prose and can describe the idea it links.
--
-- Both must re-check readability themselves.

drop policy artworks_read_all on public.artworks;
create policy artworks_read_readable on public.artworks
  for select using (
    exists (
      select 1 from public.summaries s
      where s.id = artworks.summary_id and public.summary_is_readable(s)
    )
  );

drop policy pull_relations_read_all on public.pull_relations;
create policy pull_relations_read_readable on public.pull_relations
  for select using (
    -- BOTH endpoints must be readable: a relation exposes the existence and id
    -- of whichever pull the reader cannot otherwise see.
    exists (
      select 1 from public.pulls p
      join public.summaries s on s.id = p.summary_id
      where p.id = pull_relations.from_pull_id and public.summary_is_readable(s)
    )
    and exists (
      select 1 from public.pulls p
      join public.summaries s on s.id = p.summary_id
      where p.id = pull_relations.to_pull_id and public.summary_is_readable(s)
    )
  );

-- Both policies now filter by summary, so the join columns need indexes.
create index if not exists artworks_summary_readable_idx on public.artworks (summary_id);
