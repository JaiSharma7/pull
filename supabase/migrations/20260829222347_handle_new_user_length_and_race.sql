-- Sign-up could fail outright for the second person with a long email address.
--
-- The handle was truncated to 24 characters and a collision then appended '_'
-- plus six hex characters: 31, against a CHECK of `^[a-z0-9_]{3,30}$`. The
-- constraint raised inside this AFTER INSERT trigger, which rolled back the
-- auth.users insert itself -- so the failure was not a bad handle, it was being
-- unable to create an account at all.
--
-- The check-then-insert was also racy: two concurrent sign-ups deriving the same
-- candidate both saw it free, and whichever committed second failed on
-- profiles_handle_key. Retrying on the conflict rather than looking before
-- leaping closes that window, since the unique index is the only authority on
-- whether a handle is taken.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base      text;
  candidate text;
  attempt   int := 0;
  done      boolean := false;
begin
  base := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-zA-Z0-9_]', '', 'g'));
  if base is null or length(base) < 3 then
    base := 'reader';
  end if;
  -- 23 leaves room for the suffix: 23 + '_' + 6 = 30, exactly the cap.
  base := left(base, 23);
  candidate := base;

  loop
    begin
      insert into public.profiles (id, handle, display_name)
      values (new.id, candidate, nullif(new.raw_user_meta_data ->> 'full_name', ''))
      on conflict (id) do nothing;
      done := true;
    exception when unique_violation then
      attempt := attempt + 1;
      candidate := base || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end;
    exit when done or attempt >= 5;
  end loop;

  if not done then
    -- Derived from the user's own id, so it cannot collide with anyone else's.
    -- 'reader_' plus 23 hex characters is 30, and a uuid makes those unique.
    candidate := left('reader_' || replace(new.id::text, '-', ''), 30);
    insert into public.profiles (id, handle, display_name)
    values (new.id, candidate, nullif(new.raw_user_meta_data ->> 'full_name', ''))
    on conflict (id) do nothing;
  end if;

  insert into public.preference_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;
