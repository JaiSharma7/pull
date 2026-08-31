-- The content_hash revoke in 20260830200114 did nothing.
--
-- It ran without error and changed no privilege, which is the worst way for a
-- security fix to fail: the migration reported success, the review passed it, and
-- the fingerprint stayed world-readable. Caught only by asking Postgres afterwards
-- rather than trusting that the statement meant what it looked like it meant.
--
--   revoke select (content_hash) on public.works from anon, authenticated;
--
-- In Postgres a column-level REVOKE can only subtract from a column-level GRANT.
-- `anon` and `authenticated` hold *table-level* SELECT on `works`, which implies
-- every column including ones added later — so there was no column grant to take
-- away, and the statement was a no-op. Verified after the fact:
--
--   has_column_privilege('authenticated', 'public.works', 'content_hash', 'SELECT')
--   → true
--
-- The only way to exclude a column is to drop the table-level grant and re-grant
-- the columns that should stay readable. Which means this migration carries a
-- maintenance cost worth stating plainly: a column added to `works` later is
-- unreadable by the API until it is granted here too. That is the safe direction —
-- a new column is invisible until someone decides it should not be — but it will
-- look like a bug the first time it happens, so it is written down.
--
-- Why the hash matters more than the rest of the row: `works` is deliberately
-- `for select using (true)` because a work is a bibliographic record the feed
-- needs. Title and kind describe a source. A content hash *proves* one — anyone
-- holding a candidate document can hash it and confirm exactly that it was
-- ingested, which turns a public catalogue into a membership oracle over private
-- sources.
--
-- Append-only per law 6: supersedes the ineffective revoke in 20260830200114.

revoke select on public.works from anon, authenticated;

grant select (
  id, kind, title, subtitle, slug, year, description,
  rights_status, external_ids, quality_score, trust_score,
  created_at, updated_at
) on public.works to anon, authenticated;

comment on column public.works.content_hash is
  'Fingerprint of the source text. Server-side only — the API roles hold column '
  'grants on every other column of this table precisely so this one is excluded. '
  'A column-level revoke cannot do it: a table-level grant implies all columns. '
  'See 20260831013500.';
