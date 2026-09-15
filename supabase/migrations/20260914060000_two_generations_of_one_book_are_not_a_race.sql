/*
 * The version is chosen under a lock on the WORK, not only on the job.
 *
 * 20260914050000 locks the job row so two deliveries of one step serialise, and says of
 * the version it then picks that it is "never a version another job is already using".
 * That is true of a retry and false of two jobs: a reader who submits the same imported
 * book twice has two `generation_jobs` rows, each attempt locks its own, both read
 * `max(version) = 1`, and both insert version 2. The second violates
 * `summaries_work_id_version_author_id_key`, which nothing here catches, so the step
 * fails unbilled and burns one of the job's attempts -- recovering only because the next
 * delivery re-reads a higher max. A migration that states an invariant should hold it.
 *
 * The fix is to lock the thing the version is scoped to. `(work_id, author_id)` is not a
 * row, but the reader's EXISTING summary on that work is -- the import's version 1, whose
 * presence this function already requires as its ownership check. Locking it makes the
 * check and the mutual exclusion one statement: the second job waits there, and reads a
 * max that includes the first job's row.
 *
 * `for update` rather than an advisory lock because it ends with the transaction whatever
 * happens to the connection, and because it is the row the answer is actually about. It
 * is held for the two writes below and no longer.
 */
create or replace function public.attach_generated_summary(
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
  owned    uuid;
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
   * The ownership check and the second lock, in one statement.
   *
   * `template` adopts a work only where the requester has authored a summary on it;
   * asserting it here means a caller that skipped that check cannot quietly hang a
   * private generation off somebody else's row. Taking the lock ON that row is what
   * makes the version below safe against a SECOND JOB rather than only against a
   * second delivery: the ordering is by id so two jobs cannot take the reader's rows
   * in opposite orders and deadlock.
   */
  select s.id into owned
  from public.summaries s
  where s.work_id = p_work_id and s.author_id = author
  order by s.id
  limit 1
  for update;

  if owned is null then
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
  'Writes a generated summary on a work its requester owns and points the job at it, in one transaction, under a lock on the job AND on the reader''s existing summary for that work -- so a retry adopts, and two generations of one book take two versions rather than colliding. Draft, never version 1, and the worker''s alone.';

revoke all on function
  public.attach_generated_summary(uuid, uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function
  public.attach_generated_summary(uuid, uuid, text, text, text, jsonb, text)
  to service_role;
