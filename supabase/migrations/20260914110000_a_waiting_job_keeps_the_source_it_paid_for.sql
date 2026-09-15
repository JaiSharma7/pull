/*
 * Three corrections from the eleventh review round.
 *
 * 1. THE CLAIM RENEWAL IN `embed` WAS DEAD CODE. 20260914080000's worker change renews a
 *    job's source claim when the day's budget refuses the embedding step -- the text is
 *    already synthesised and paid for, so losing the claim means another job pays for the
 *    same synthesis again. It read the hash from `priorOutputs.acquire`, and
 *    `NEEDS.embed` is `['cards', 'synthesize']`: 20260902160000 narrowed every step to
 *    what it declares it reads, precisely so the source text is not handed to steps that
 *    do not need it, so `acquire` is not there and the renewal never fired. Widening
 *    `NEEDS` would drag the whole source text into the step to read one string, so the
 *    renewal asks by JOB instead -- which is the key the claim already carries an index
 *    on.
 *
 * 2. `record_mute_impression` DISCARDED THE POSITION ON THE PATH IT SAYS IS COMMON. Its
 *    own comment is that the card has almost always been shown already today, so the
 *    insert conflicts and the DO UPDATE runs -- and that branch set `action` alone. The
 *    Feed now plumbs the card's position through to it, and it was being dropped in every
 *    case but the rare one.
 *
 * 3. `budget_reservations_open_idx` INDEXED A CONSTANT. It was `(settled_at) where
 *    settled_at is null`, so every entry in the partial index carries the same NULL key
 *    and none of its three readers -- `spend_today`, `reserve_budget`, the sweep's
 *    terminal pass -- can use it for the `created_at` range they actually scan.
 */

-- ------------------------------------------------- 1. renewing a claim by job
create function public.renew_source_claim(
  p_job_id uuid,
  p_lease interval default interval '30 minutes'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  renewed boolean;
begin
  if p_lease < interval '3 minutes' then
    raise exception
      'renew_source_claim: lease % is under the three-minute floor that claim_source_hash '
      'keeps, and a lease shorter than a call hands the source to a second payer', p_lease;
  end if;

  /*
   * The job's OWN claim and no other. A job that never claimed anything, or whose claim
   * was taken over by another job once its lease lapsed, renews nothing and is told so --
   * `false` is not an error here, it is the answer that the source is somebody else's now.
   */
  update public.generation_hash_claims c
     set expires_at = now() + p_lease
   where c.job_id = p_job_id;

  get diagnostics renewed = row_count;
  return renewed;
end;
$$;

comment on function public.renew_source_claim(uuid, interval) is
  'Extends the lease on whatever source hash a job already holds. For a job parked on the daily budget: its text is synthesised and paid for, and losing the claim would have a second job pay for the same synthesis again.';

revoke all on function public.renew_source_claim(uuid, interval) from public, anon, authenticated;
grant execute on function public.renew_source_claim(uuid, interval) to service_role;

-- --------------------------------------------- 2. a mute records where it was
create or replace function public.record_mute_impression(p_pull_id uuid, p_position int default 0)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.feed_impressions (user_id, pull_id, position, action)
  select (select auth.uid()), p_pull_id, coalesce(p_position, 0), 'muted'
  where (select auth.uid()) is not null
  on conflict (user_id, pull_id, shown_on) do update
    set action = 'muted',
        -- AND THE POSITION, which this dropped. The comment on the original says the
        -- card has almost always been shown already today -- so this branch is the
        -- common one, and setting `action` alone meant the position the client sends
        -- was recorded only in the rare case where no row existed yet.
        position = excluded.position;
$$;

comment on function public.record_mute_impression is
  'Mark the card a reader muted from, and where in the feed it was, on the server''s clock. See 20260914030000 and 20260914110000.';

revoke all on function public.record_mute_impression(uuid, int) from public, anon;
grant execute on function public.record_mute_impression(uuid, int) to authenticated;

-- ------------------------------------ 3. an index on the column its readers scan
--
-- Dropped and recreated rather than renamed: the old one is keyed on the column its own
-- partial predicate holds constant, which is an index Postgres can only scan whole.
drop index if exists public.budget_reservations_open_idx;

create index if not exists budget_reservations_open_idx
  on public.budget_reservations (created_at)
  where settled_at is null;

comment on index public.budget_reservations_open_idx is
  'The open holds, by the column every reader of them range-scans: spend_today and reserve_budget take the day and the TTL from below, the sweep takes its threshold from above.';
