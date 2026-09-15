-- -----------------------------------------------------------------------------
-- A name is claimed once, and only through the function that owns the rules.
--
-- 20260906090000 added `claim_handle`, which refuses reserved names, refuses a
-- guest, refuses anything shaped like a generated `reader_` handle, and reports a
-- collision as 23505. It was never a gate. Two holes, both found by Codex on the
-- PR that recorded that migration, both verified against the hosted database:
--
--   1. IT IS NOT THE ONLY WAY IN. `anon` and `authenticated` hold column-level
--      UPDATE on every column of `profiles` -- `handle` and `handle_set_at`
--      included -- and `profiles_write_own` permits a reader their own row. So a
--      PostgREST PATCH sets any name at all, passing none of the rules above: a
--      reserved one, somebody else's shape, or `handle_set_at` by hand.
--
--   2. IT IS NOT ONCE. The update matched on `id = uid` alone, so a reader could
--      rename as often as they liked, `handle_set_at` moving each time, while the
--      column's comment called it "when the reader chose this handle".
--
-- Both are closed here rather than in that file: it is applied everywhere, and law
-- 6 is append-only.
--
-- WHAT CHANGES FOR A READER. Nothing today -- nothing calls `claim_handle`, and
-- `handle_set_at` is null on every row. What changes for a screen that comes later
-- is that it must call the function rather than PATCH the column, and that a
-- second claim now fails loudly instead of quietly renaming.
--
-- WHY IT REVOKES THE TABLE AND GRANTS BACK THREE COLUMNS, rather than revoking two.
-- A column-level revoke against a role holding TABLE-level UPDATE does nothing: the
-- table grant still authorises every column, and Postgres does not subtract from it.
-- The first draft of this file did exactly that, and the test below caught it on the
-- first run -- a reader still set `handle` directly. So the table privilege goes, and
-- `display_name`, `bio` and `avatar_path` come back: a profile screen edits those
-- directly and has no reason to route them through an RPC. `profiles_write_own` still
-- decides WHICH row; this decides which columns.
--
-- `anon` gets nothing back. A signed-out visitor has no row of their own, so
-- `profiles_write_own` already matched nothing for them; the grant was reach with no
-- purpose.
--
-- WHY THE FUNCTION BECOMES SECURITY DEFINER. Once the caller has no UPDATE
-- privilege on `handle`, an invoker-rights function called BY that caller has none
-- either, and every claim would fail. Definer rights with `search_path = ''` and
-- fully qualified names is the pattern every other privileged RPC here uses; the
-- `where id = uid` is what keeps it to the caller's own row now that RLS is no
-- longer doing it.
-- -----------------------------------------------------------------------------

revoke update on public.profiles from anon, authenticated;
grant update (display_name, bio, avatar_path) on public.profiles to authenticated;

create or replace function public.claim_handle(new_handle text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  wanted text := lower(btrim(coalesce(new_handle, '')));
  uid    uuid := (select auth.uid());
  taken  boolean;
  reserved constant text[] := array[
    'admin', 'administrator', 'moderator', 'mod', 'staff', 'team', 'official',
    'support', 'help', 'security', 'abuse', 'root', 'system', 'api',
    'whatapull', 'pull', 'anonymous', 'guest', 'null', 'undefined'
  ];
begin
  if uid is null then
    raise exception 'Sign in before choosing a username.' using errcode = '42501';
  end if;

  if public.is_guest() then
    raise exception 'A guest session cannot hold a username. Sign in to keep one.'
      using errcode = '42501';
  end if;

  if wanted !~ '^[a-z0-9_]{3,30}$' then
    raise exception
      'A username is 3 to 30 characters, using letters, numbers and underscores only.'
      using errcode = '22023';
  end if;

  if wanted like 'reader\_%' then
    raise exception 'Usernames cannot begin with "reader_" -- that prefix is ours.'
      using errcode = '22023';
  end if;

  if wanted = any (reserved) then
    raise exception 'That username is reserved.' using errcode = '22023';
  end if;

  /*
   * ONE CLAIM, decided by the UPDATE itself rather than by a SELECT before it.
   *
   * `where … and handle_set_at is null` is the whole guard: two calls racing each
   * other both pass every check above, and the second one updates no row because the
   * first has already set the column. A `select … if found` ahead of the update would
   * have both callers read null and both write. Postgres serialises the two updates
   * on the row, so exactly one wins, and the loser is told below.
   */
  begin
    update public.profiles
       set handle = wanted, handle_set_at = now()
     where id = uid and handle_set_at is null;
  exception when unique_violation then
    raise exception 'That username is already taken.' using errcode = '23505';
  end;

  if not found then
    /*
     * Nothing updated, and the two reasons are different answers to the caller.
     *
     * A row that exists with a handle already chosen is "you have one"; no row at all
     * is the account having been deleted out from under an unexpired token, which is
     * the same case `enqueue_generation_job` guards. 55000 (object not in prerequisite
     * state) rather than 23505: a collision is somebody else's name, this is the
     * caller's own, and a screen should say different things about them.
     */
    select exists (select 1 from public.profiles p where p.id = uid) into taken;
    if taken then
      raise exception
        'You have already chosen a username. Ask us if you need it changed.'
        using errcode = '55000';
    end if;
    raise exception 'Could not find your profile to update.' using errcode = 'P0002';
  end if;

  return wanted;
end;
$$;

comment on function public.claim_handle(text) is
  'Claim a username for the calling reader, once. Normalises case and whitespace, '
  'refuses reserved and generated-shape names, refuses a guest, reports a taken name '
  'as 23505 and a second claim as 55000. The only writer of profiles.handle: '
  '20260915020000 revoked UPDATE on the table and granted back only display_name, '
  'bio and avatar_path.';

revoke all on function public.claim_handle(text) from public, anon;
grant execute on function public.claim_handle(text) to authenticated;
