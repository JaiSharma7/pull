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
--    the first column of the constraint.
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

SELECT 'schema invariants: ok' AS result;
