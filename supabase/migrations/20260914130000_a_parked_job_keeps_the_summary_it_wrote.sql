/*
 * `renew_source_claim` comes back, and the decision it serves is written down here so
 * the next reader finds the argument rather than the flip-flop.
 *
 * It was added in 20260914110000 for `embed`'s budget wait, dropped in 20260914120000
 * when review pointed out that renewing across a 24-hour wait starves every other job on
 * the same text, and is restored now that the other side of the trade has been priced:
 *
 *   RELEASING the claim at `embed` gives a second job the source while THIS job's draft
 *   summary and its Pulls already exist. `findPublishedSummaryByHash` cannot offer a
 *   draft, so that job synthesises again and then either publishes a second public
 *   summary of one work -- `get_feed` serving the same ideas twice, `get_source_delta`
 *   over-counting -- or, for the same requester, collides into this job's draft, has
 *   `cards` upsert over its Pull bodies at `(summary_id, ordinal)`, and leaves this job
 *   to write vectors computed from its own text onto rows now holding another's.
 *
 *   RENEWING starves: a second job gets `held`, waits its bounded thirty minutes and
 *   fails terminally for doing nothing wrong.
 *
 * Between corrupting one work and failing one job, the job fails. Loud and bounded beats
 * silent and permanent, which is the same argument `record_job_step` makes about the
 * ledger and `claim_source_hash` makes about its own lease floor.
 *
 * `renewed int` rather than `boolean`, which the first version got wrong: there is no
 * int8-to-bool cast, so `get diagnostics ... = row_count` worked only through PL/pgSQL's
 * text fallback and would have raised on any count above one -- and `job_id` is not
 * unique in this table.
 */
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
  renewed int;
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
  return renewed > 0;
end;
$$;

comment on function public.renew_source_claim(uuid, interval) is
  'Extends the lease on whatever source hash a job already holds. For a job parked on the daily budget with its draft summary already written: releasing the claim there lets a second job duplicate or overwrite that summary.';

revoke all on function public.renew_source_claim(uuid, interval) from public, anon, authenticated;
grant execute on function public.renew_source_claim(uuid, interval) to service_role;
