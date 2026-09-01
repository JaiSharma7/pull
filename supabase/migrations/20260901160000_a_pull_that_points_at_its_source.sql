-- "Every idea is anchored to a real source you can open." It was not.
--
-- The README has said that since round 1, `docs/terms.md` repeats it -- "every Pull
-- carries its source so you can check it, and checking it is the intended use" -- and
-- `docs/content-policy.md` builds the whole rights argument on it. Meanwhile there is
-- no outbound link to any original anywhere in the app, `works` has no column that
-- could hold one, and `upsertWork` takes title, kind, hash, rights, topics and two
-- scores: no author, no URL. On the hosted project that is 6 editions and 6
-- contributors against 108 works -- attribution exists only for the hand-seeded six.
--
-- This is not a copy problem. Law 4 is "analysis, not reproduction", and the argument
-- for why publishing commentary on a work is fair rather than substitutive is that it
-- sends the reader to the original. A summary of a book with no author credited and
-- nothing linking to the source is exactly the artefact that argument disclaims.
--
-- The URL was in hand the whole time: `job.target.url` is validated by
-- `resolve_identity` and returned in its output (`pipeline.ts`). It was simply never
-- written down, and `scripts/seed-corpus.mjs` says why in its own header -- "`author`
-- is deliberately NOT carried into the job target, because `works` has no author
-- column ... Attribution is a schema change, not a manifest field." This is that
-- schema change.

alter table public.works add column source_url text;

/*
 * Bounded and shaped, because this column is rendered as a link a reader clicks.
 *
 * The check is deliberately weak -- http/https and a length ceiling -- rather than a
 * URL parser in a CHECK constraint. What it is actually for is refusing a `javascript:`
 * or `data:` value, which is the one way a value in this column becomes an attack on
 * the person reading the page. Everything else about whether a URL is any good is the
 * pipeline's job, and `assertFetchableUrl` already does it before the fetch.
 */
alter table public.works
  add constraint works_source_url_shape
    check (source_url is null
           or (source_url ~ '^https?://' and length(source_url) between 8 and 2048));

/*
 * The grant, which is the part that is easy to forget and silent when forgotten.
 *
 * 20260831013500 dropped the table-level grant on `works` and re-granted thirteen
 * named columns so `content_hash` could be excluded -- a column-level revoke cannot
 * subtract from a table grant, and the version that tried reported success and changed
 * nothing. The consequence is a standing footgun that file named honestly: any column
 * added later is invisible to the API until someone adds it here. It has already
 * caught one column (`search_tsv`, in 20260901000500). This is the second.
 */
grant select (source_url) on public.works to anon, authenticated;

comment on column public.works.source_url is
  'Where to read the original. Rendered as an outbound link on the source page, which '
  'is what makes "analysis, not reproduction" a description of the product rather than '
  'an aspiration. Added in 20260901160000; remember the column grant.';

-- ---------------------------------------------------------------- attribution

/**
 * File a work under its author.
 *
 * `contributors` and `work_contributors` have existed since round 1 and are written by
 * nothing but the seed migration. The pipeline could not use them because the author
 * never reached it; now that the manifest carries one into the job target, this is the
 * smallest thing that stores it.
 *
 * `security definer` for the same reason `enqueue_generation_job` is: the worker writes
 * as `service_role`, which bypasses RLS anyway, but the seeding path runs as the owner
 * and both want one function rather than two spellings of the same upsert.
 *
 * Idempotent on both halves. A contributor is matched by slug, not by name: `slug` is
 * the `citext unique not null` column the seed migration already keys on, so matching
 * there is exact, index-backed, and agrees with the six rows that exist. Matching on
 * name instead would need its own case folding and would not agree with them.
 *
 * Slug collisions are therefore identity: two people who slugify the same are treated
 * as one contributor. That is the crude answer to "is this Mill the same Mill?", and it
 * is the right one for a few hundred public-domain works -- the alternative is an
 * identity-resolution problem this corpus does not have. When it does, the fix is a
 * disambiguating suffix here, not a different join.
 */
create or replace function public.attribute_work(p_work_id uuid, p_author text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  contributor_id uuid;
  cleaned        text;
  as_slug        text;
begin
  cleaned := nullif(btrim(coalesce(p_author, '')), '');
  if cleaned is null or p_work_id is null then
    return;
  end if;
  cleaned := left(cleaned, 200);

  -- The same shape the seed migration wrote by hand: lowercase, non-alphanumerics
  -- collapsed to single hyphens, no leading or trailing one. 'Marcus Aurelius' ->
  -- 'marcus-aurelius', which is the row already in the table.
  as_slug := btrim(regexp_replace(lower(cleaned), '[^a-z0-9]+', '-', 'g'), '-');
  if as_slug = '' then
    return;
  end if;

  select c.id into contributor_id
    from public.contributors c
   where c.slug = as_slug::extensions.citext;

  if contributor_id is null then
    -- `slug` is not null with no default, so it has to be supplied. The conflict
    -- target closes the race between the select above and this insert; the second
    -- lookup is what makes the loser of that race adopt rather than fail.
    insert into public.contributors (name, slug)
    values (cleaned, as_slug)
    on conflict (slug) do nothing
    returning id into contributor_id;

    if contributor_id is null then
      select c.id into contributor_id
        from public.contributors c
       where c.slug = as_slug::extensions.citext;
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

revoke all on function public.attribute_work(uuid, text) from anon, authenticated, public;
grant execute on function public.attribute_work(uuid, text) to service_role;
