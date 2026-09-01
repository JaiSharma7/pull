-- A second factor, and the part every TOTP implementation gets wrong.
--
-- Sign-in here is a one-time code sent to an email address, so the account is exactly
-- as strong as the mailbox. That is a deliberate trade -- no password means no password
-- to reuse, leak or phish -- and it is also the whole attack: someone who reads the
-- inbox is in, and the reader has no way to say "not without the thing in my pocket".
-- TOTP is that way.
--
-- GoTrue implements enrolment, challenge and verification itself (`auth.mfa_factors`,
-- `supabase.auth.mfa.*`), so none of that is here. What is here is the part Supabase
-- does not provide and most implementations bolt on badly: recovery.
--
-- **What a recovery code can and cannot do, stated before the table rather than
-- discovered afterwards.** It cannot log anybody in. Only GoTrue mints tokens, only
-- GoTrue decides that a session has reached `aal2`, and nothing in this schema can
-- forge that -- so a "recovery code" that claims to be an alternative second factor
-- would be a decoration over a lie.
--
-- What it can do is take the factor off. And on this product that is the entire
-- recovery path, because sign-in is passwordless: a reader who has lost their
-- authenticator can still receive an email code and reach `aal1`. They are not locked
-- out of the account, they are held at the second factor. So recovery means "prove you
-- are the person who enrolled this, and let me remove it" -- after which they sign in
-- as they did before and can enrol a new one.
--
-- That is a smaller promise than "codes that get you in", and it is the true one. It
-- also means a stolen recovery code is worth exactly one downgrade to email-only, not
-- a full second factor bypass, which is the correct blast radius for a value a person
-- keeps in a drawer.

create table public.mfa_recovery_codes (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  -- sha256 of the code, hex. Never the code itself: this table is a backup credential
  -- store, and a backup credential stored in plaintext is a credential.
  code_hash  text        not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  primary key (user_id, code_hash),
  constraint mfa_recovery_code_hash_shape check (code_hash ~ '^[0-9a-f]{64}$')
);

-- Law 5: in the migration that creates it.
alter table public.mfa_recovery_codes enable row level security;

/*
 * Self-only, and read-only through the API.
 *
 * There is deliberately no insert, update or delete policy. Every write goes through
 * the definer functions below, because the invariants that matter -- codes are
 * generated as a set, hashed before storage, and consumed exactly once -- are not
 * expressible as a row predicate. A reader who could insert their own row could mint
 * themselves a recovery code whose plaintext they chose.
 *
 * The select policy exists so a reader can be told how many unused codes they have
 * left, which is the one thing about this table a person needs to see. The hash is
 * useless to them and to anyone else.
 */
create policy mfa_recovery_codes_read_own on public.mfa_recovery_codes
  for select using ((select auth.uid()) = user_id);

create index mfa_recovery_codes_unused_idx
  on public.mfa_recovery_codes (user_id)
  where used_at is null;

/**
 * Issue a fresh set of ten codes, returning the plaintext exactly once.
 *
 * Regenerating invalidates every previous code, which is the behaviour a person
 * expects from "show me new codes" and the only safe one: leaving the old set live
 * would mean a printout from a year ago still works after the reader believed they
 * had replaced it.
 *
 * The codes are returned by this call and never again. Nothing stores the plaintext,
 * so a reader who loses them regenerates rather than recovers -- which is fine while
 * they still hold the factor, and is the reason the UI has to make them save the codes
 * at the moment it shows them.
 *
 * Format is 10 lowercase base32-ish characters in two groups, from `gen_random_bytes`
 * rather than `random()`: `random()` is a seeded PRNG, and a credential drawn from it
 * is guessable by anyone who can observe a few outputs.
 */
create or replace function public.generate_mfa_recovery_codes()
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid   uuid := auth.uid();
  codes text[] := '{}';
  code  text;
  raw   text;
  i     int;
begin
  if uid is null then
    raise exception 'generate_mfa_recovery_codes requires an authenticated user'
      using errcode = '28000';
  end if;

  delete from public.mfa_recovery_codes r where r.user_id = uid;

  for i in 1..10 loop
    -- 5 bytes -> 10 hex characters, ~40 bits. Displayed as two groups of five.
    raw  := encode(extensions.gen_random_bytes(5), 'hex');
    code := substr(raw, 1, 5) || '-' || substr(raw, 6, 5);
    codes := codes || code;

    insert into public.mfa_recovery_codes (user_id, code_hash)
    values (uid, encode(extensions.digest(code, 'sha256'), 'hex'))
    on conflict (user_id, code_hash) do nothing;
  end loop;

  return codes;
end;
$$;

revoke all on function public.generate_mfa_recovery_codes()
  from anon, authenticated, public;
grant execute on function public.generate_mfa_recovery_codes() to authenticated;

/**
 * Spend a recovery code to take the second factor off.
 *
 * Not "to sign in" -- see the header. This removes the caller's verified TOTP factors,
 * which returns the account to email-only sign-in, and it is the whole point of the
 * table.
 *
 * The code is marked used before the factors are deleted, in the same transaction, so
 * a failure anywhere leaves neither half applied. `used_at is null` in the UPDATE
 * predicate is what makes a code single-use under concurrency: two simultaneous
 * requests with the same code both match the row, but only one gets `row_count = 1`.
 *
 * Comparison is on the hash, so a wrong code is indistinguishable from an unknown one
 * and neither says anything about what a real code looks like.
 */
create or replace function public.redeem_mfa_recovery_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid        uuid := auth.uid();
  normalised text;
  hashed     text;
  spent      int;
begin
  if uid is null then
    raise exception 'redeem_mfa_recovery_code requires an authenticated user'
      using errcode = '28000';
  end if;

  -- Normalised into the stored display format before hashing, so a code typed with
  -- the dash, without it, or in capitals is the same code. A person reading ten
  -- characters off a printout should not be defeated by punctuation.
  normalised := regexp_replace(lower(coalesce(p_code, '')), '[^0-9a-f]', '', 'g');
  if length(normalised) <> 10 then
    return false;
  end if;
  hashed := encode(
    extensions.digest(substr(normalised, 1, 5) || '-' || substr(normalised, 6, 5), 'sha256'),
    'hex');

  update public.mfa_recovery_codes r
     set used_at = now()
   where r.user_id = uid
     and r.code_hash = hashed
     and r.used_at is null;

  get diagnostics spent = row_count;
  if spent = 0 then
    return false;
  end if;

  delete from auth.mfa_factors f where f.user_id = uid;
  return true;
end;
$$;

revoke all on function public.redeem_mfa_recovery_code(text)
  from anon, authenticated, public;
grant execute on function public.redeem_mfa_recovery_code(text) to authenticated;

comment on table public.mfa_recovery_codes is
  'Single-use codes that remove a reader''s TOTP factor when they have lost the '
  'authenticator. They cannot sign anybody in -- only GoTrue mints tokens and only '
  'GoTrue grants aal2 -- and because sign-in here is passwordless, removing the factor '
  'is a complete recovery path on its own. See 20260901150000.';
