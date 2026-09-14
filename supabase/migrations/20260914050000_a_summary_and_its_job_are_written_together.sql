/*
 * The write and the attach become one transaction, and a function with no caller goes.
 *
 * A generated summary on a work the requester already owns was two statements from the
 * worker: insert the row, then point the job at it. Between them is a network, and the
 * failure it produces is not theoretical -- a lost response after the insert leaves a
 * summary nothing references, and the retry cannot tell that from a fresh start because
 * `generation_jobs.summary_id` is still null. Every version of the answer written in the
 * Edge Function has been wrong in a different direction:
 *
 *   - "the next free version" made each retry write ANOTHER draft, because the orphan
 *     from the last attempt is itself what makes the next version higher. One empty
 *     summary per attempt, on the reader's own book.
 *   - a CONSTANT version made the retry collide and adopt, which is right, and made a
 *     genuine second generation collide with the FIRST one's published summary -- so
 *     `cards` upserted new Pulls over some of its ordinals and left the rest, and a
 *     reader could watch a live summary become a mixture of two documents.
 *
 * Neither is fixable in the client, because both are the same missing property: the row
 * and the reference have to land together or not at all. In one function they do. The
 * job row is locked first, so two deliveries of the same step serialise and the second
 * gets the summary the first wrote; the version is read and used inside that lock, so a
 * second generation gets a version of its own rather than another job's summary.
 *
 * And `settle_job_budget` is dropped. It was created to release every hold a job carries
 * on the two failure paths that never reach `record_failed_job_step`, and both of those
 * paths now settle by `(job, step)` instead -- because a job being failed is not the same
 * moment as every one of its steps being over, and a sibling step dispatched in parallel
 * can still be inside a provider call. It has no callers left, and a `security definer`
 * function that releases money and is invoked by nothing is surface with no owner.
 */

create function public.attach_generated_summary(
  p_job_id         uuid,
  p_work_id        uuid,
  p_title          text,
  p_elevator_pitch text,
  p_why_it_matters text,
  p_sections       jsonb,
  p_visibility     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  author   uuid;
  existing uuid;
  next_ver int;
  new_id   uuid;
begin
  /*
   * The job row, locked.
   *
   * Two deliveries of the same step can be in flight at once -- pgmq redelivers on a
   * visibility timeout, not on a proof that the last attempt died -- and without this
   * both would read a null `summary_id` and both would insert. The second waits here,
   * then finds the first one's summary and returns it.
   */
  select gj.requester_id, gj.summary_id
    into author, existing
  from public.generation_jobs gj
  where gj.id = p_job_id
  for update;

  if not found then
    raise exception 'attach_generated_summary: no job %', p_job_id using errcode = '22023';
  end if;
  if author is null then
    raise exception 'attach_generated_summary: job % has no requester', p_job_id
      using errcode = '22023';
  end if;

  -- Idempotent, and this is the whole point of the lock above.
  if existing is not null then
    return jsonb_build_object('summaryId', existing, 'created', false);
  end if;

  /*
   * The same ownership test the worker makes before it calls this, made again where it
   * is enforceable. `template` adopts a work only where the requester has authored a
   * summary on it; asserting it here means a caller that skipped that check cannot
   * quietly hang a private generation off somebody else's row.
   */
  if not exists (
    select 1 from public.summaries s
    where s.work_id = p_work_id and s.author_id = author
  ) then
    raise exception
      'attach_generated_summary: the requester has authored nothing on work %', p_work_id
      using errcode = '42501';
  end if;

  /*
   * NEVER VERSION 1.
   *
   * An imported book carries the reader's version 1 -- the summary `commit_import`
   * hangs four hundred highlights from. A generated summary landing there would be
   * adopted by nothing and overwritten by `cards`, which upserts Pulls on
   * `(summary_id, ordinal)` and would replace the reader's own highlight text at every
   * ordinal the two lists share. The floor holds even if the ownership row above is
   * somehow at a higher version than 1.
   */
  select greatest(coalesce(max(s.version), 1) + 1, 2)
    into next_ver
  from public.summaries s
  where s.work_id = p_work_id and s.author_id = author;

  insert into public.summaries
    (work_id, version, status, visibility, author_id, title, elevator_pitch,
     why_it_matters, sections)
  values
    (p_work_id, next_ver, 'draft', coalesce(p_visibility, 'private')::public.visibility,
     author, p_title, p_elevator_pitch, p_why_it_matters, coalesce(p_sections, '[]'::jsonb))
  returning id into new_id;

  update public.generation_jobs
     set summary_id = new_id,
         work_id    = p_work_id
   where id = p_job_id;

  return jsonb_build_object('summaryId', new_id, 'version', next_ver, 'created', true);
end;
$$;

comment on function public.attach_generated_summary(uuid, uuid, text, text, text, jsonb, text) is
  'Writes a generated summary on a work its requester owns and points the job at it, in one transaction, so a retry after a lost response adopts rather than duplicates. Draft, never version 1, and the worker''s alone.';

/*
 * Not a reader-facing endpoint, and not one an authenticated client may reach at all:
 * it writes a summary as whoever the job says asked for it. Postgres grants EXECUTE to
 * PUBLIC on a new function, so the grant is removed from everyone and given back only
 * to the role the worker runs as.
 */
revoke all on function
  public.attach_generated_summary(uuid, uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function
  public.attach_generated_summary(uuid, uuid, text, text, text, jsonb, text)
  to service_role;

-- ------------------------------------------------ and the function with no callers
drop function if exists public.settle_job_budget(uuid);
