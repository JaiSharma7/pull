-- ---------------------------------------------------------------------------
-- Schema invariants. Run by CI check 4 against a freshly replayed database.
--
-- These are not style preferences. Each one, if violated, is a real defect:
-- a table without RLS is readable by every user of the API; a table with RLS
-- but no policy is silently unreadable by everyone; an unindexed foreign key
-- turns an ordinary join into a sequential scan once the table has rows.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- 1. Every table in `public` must have row level security enabled.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offenders
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT c.relrowsecurity;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'RLS is not enabled on: %. Enable it in the same migration that creates the table.',
      offenders;
  END IF;
END $$;

-- 2. Every RLS-enabled table must carry at least one policy, otherwise it is
--    locked to everyone including its owner's own rows.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offenders
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'RLS enabled but no policy defined on: %. The table is unreadable as written.',
      offenders;
  END IF;
END $$;

-- 3. Every foreign key must be supported by an index whose leading column is
--    the first column of the constraint, and which covers the whole table. A
--    PARTIAL index does not: it serves only the rows matching its predicate, so
--    accepting one here would let a FK look supported while the rows outside
--    the predicate still sequential-scan. The schema has carried partial
--    indexes since the first migration, several leading with a FK column, so
--    this was always reachable -- it was simply never checked.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s.%s', con.conrelid::regclass, con.conname), ', ')
    INTO offenders
  FROM pg_constraint con
  WHERE con.contype = 'f'
    AND con.connamespace = 'public'::regnamespace
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index i
      WHERE i.indrelid = con.conrelid
        AND i.indkey[0] = con.conkey[1]
        AND i.indpred IS NULL
    );

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Foreign keys without a supporting index: %', offenders;
  END IF;
END $$;

-- 4. Functions that run with elevated rights must pin search_path, or a caller
--    can shadow the objects they resolve.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO offenders
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND NOT EXISTS (
      SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg
      WHERE cfg LIKE 'search_path=%'
    );

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'SECURITY DEFINER functions without a pinned search_path: %', offenders;
  END IF;
END $$;

-- 5. No two permissive policies may cover SELECT for the same role on the same
--    table: Postgres OR-s them together on every row of every read. Usually
--    caused by adding a `for all` write policy beside an existing read policy.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT rel, ', ')
    INTO offenders
  FROM (
    SELECT p.polrelid::regclass::text AS rel, unnest(p.polroles) AS role_oid
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND p.polpermissive
      AND p.polcmd IN ('r', '*')       -- SELECT, or ALL (which includes SELECT)
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) dupes;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Overlapping permissive SELECT policies on: %. Split `for all` into INSERT/UPDATE/DELETE.',
      offenders;
  END IF;
END $$;

-- 6. No two indexes with identical definitions on the same table. A duplicate costs
--    double on every write and buys nothing on any read: the planner uses one and the
--    other is dead weight. `artworks` carried a pair for three rounds, reported by the
--    performance advisor and named in the roadmap, because nothing in CI could see it.
--
--    Compared on the definition with the index name removed, so two indexes differing
--    only in what they are called are recognised as the same index.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(names, '; ')
    INTO offenders
  FROM (
    SELECT string_agg(i.indexname, ' = ' ORDER BY i.indexname) AS names
    FROM pg_indexes i
    WHERE i.schemaname = 'public'
    GROUP BY i.tablename,
             regexp_replace(i.indexdef, ' INDEX [^ ]+ ON ', ' INDEX ON ')
    HAVING count(*) > 1
  ) dupes;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Indexes with identical definitions: %. Drop all but one.', offenders;
  END IF;
END $$;

SELECT 'schema invariants: ok' AS result;
