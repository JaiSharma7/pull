-- Study validation and correction, after the third review.
--
-- 20260925050000 to 20260925090000 are pushed, so they are superseded here (law 6).
--
-- 1. GENERATED ROWS START AS DRAFTS. `persist_study_course` writes each claim, lesson and
--    question with the status its payload names. Before 20260925050000 the status checks
--    allowed only `draft` and `rejected`; since then they also allow `validated`, and a
--    service-role caller that persisted a `validated` question skipped every check --
--    `validate_study_course` moves only drafts -- straight into `study_visible_items` and
--    into proof. A trigger now refuses any model-written row that does not start as a
--    draft or rejected, whichever definer function inserts it. A reader's version is
--    minted `validated` by `revise_study_*`, which has run the checks first.
--
-- 2. COURSE TEXT CHANGED IS COURSE TEXT PENDING. `validate_study_course` decides the
--    course's own text once, while `text_status` is `pending`. Run before the course was
--    persisted, it passed the empty text, and the text persisted afterwards was shown
--    unchecked. Any change to the course's text now puts it back to `pending`, so the
--    next validation -- the worker's step, or the sweep -- decides the text it will show.
--
-- 3. THE HEURISTICS STRIP EVERY INVISIBLE CHARACTER. They stripped \p{Cf}; the other
--    default-ignorable code points (the combining grapheme joiner, variation selectors,
--    Hangul fillers, Mongolian free variation selectors) still split a trigger phrase or a
--    domain, and a browser ignores most of them in a host name. The instruction check and
--    the link extraction now strip \p{Cf} and \p{Default_Ignorable_Code_Point}, generated.
--    Answer matching is unchanged: it mirrors `containsPhrase` code point for code point.
--
-- 4. A LINK IS COMPARED AS WRITTEN. Links were extracted after look-alike letters were
--    folded to Latin, so `https://раураl.com` in Cyrillic was read as the paypal.com a
--    source cited, and passed. Links are now extracted without that fold -- NFKC, lower
--    case, invisible characters removed -- so a look-alike domain is a different link.
--
-- 5. A LESSON'S UNIT TITLE CAN BE CORRECTED. It is checked with the lesson, and a lesson
--    quarantined by it could only be retired, because `unitTitle` was not a revision key.
--
-- 6. GRANTS. The service role kept MAINTAIN on the study tables, and could reschedule the
--    stranded sweep through `enable_generation_sweeper` though it may not run the sweep.
--
-- 7. A NUMBER IS ONE WORD WHEN ONE TEXT IS FOUND IN ANOTHER. Since 20260925080000 a full
--    stop between two digits is kept, and it read as a word boundary: "125" was found in
--    "0.125", so a question asking for 1000 × 0.125 printed its own answer, and "14" was
--    evidenced by "3.14". `containsPhrase` and `study_contains_phrase` now treat that full
--    stop as part of the number. And the look-alike fold no longer maps the ideographic
--    full stop to a full stop, which made "3。5" a decimal in SQL and "35" in TypeScript;
--    the link check, which needs that mapping, has its own text since item 4.
--
-- 8. PENDING MEANS PERSISTED AND NOT YET VALIDATED. A course's row exists from the
--    moment it is queued, so a job that failed before its course was persisted left a row
--    `pending` for ever: nothing to validate, but in the sweep's index and walked every run,
--    a cost growing with every failed job. The sweep now reads only persisted courses
--    (`assembled_at` is set), through an index on exactly those. And persisting a course
--    always puts its text back to `pending`, even text equal to what was there, so a
--    validation run before the persist -- which settled the empty text and left the drafts
--    that followed unswept -- is always followed by one that sees them.
--
-- 20260925090000's header says the proven-claims test compares "event by event"; it
-- compares claim by claim, and the proof rule's clauses are now asserted one by one.

-- ------------------------------------------------------------------ 1. drafts

create function public.study_generated_rows_start_as_drafts()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.status not in ('draft', 'rejected')
     and coalesce(to_jsonb(new) ->> 'authored_by', 'model') = 'model' then
    raise exception 'a generated % starts as a draft or rejected, not %',
      tg_argv[0], new.status using errcode = '22023';
  end if;
  return new;
end
$fn$;

revoke all on function public.study_generated_rows_start_as_drafts()
  from public, anon, authenticated, service_role;

create trigger study_claims_start_as_drafts before insert on public.study_claims
  for each row execute function public.study_generated_rows_start_as_drafts('claim');
create trigger study_lessons_start_as_drafts before insert on public.study_lessons
  for each row execute function public.study_generated_rows_start_as_drafts('lesson');
create trigger study_items_start_as_drafts before insert on public.study_items
  for each row execute function public.study_generated_rows_start_as_drafts('question');

-- ------------------------------------------------------------------ 2. course text

create function public.study_course_text_pending()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if (new.title, new.overview, new.objectives, new.recap, new.disagreements, new.withheld,
      new.assembled_at)
     is distinct from
     (old.title, old.overview, old.objectives, old.recap, old.disagreements, old.withheld,
      old.assembled_at) then
    new.text_status := 'pending';
    new.text_failures := '{}';
  end if;
  return new;
end
$fn$;

revoke all on function public.study_course_text_pending()
  from public, anon, authenticated, service_role;

create trigger study_course_text_pending
  before update of title, overview, objectives, recap, disagreements, withheld, assembled_at
  on public.study_generations
  for each row execute function public.study_course_text_pending();

-- ------------------------------------------------------------------ 3, 4. heuristics

/*
 * \p{Cf} and \p{Default_Ignorable_Code_Point}: what the heuristics strip. Generated by
 * `node scripts/study-unicode-classes.mjs` (`ignorable`).
 */
create function public.study_ignorable_class()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select
  '[\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u115f-\u1160\u17b4-\u17b5'
  '\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0'
  '\ufff0-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-'
  '\U0001d17a\U000e0000-\U000e0fff]'
$fn$;

/* NFKC, lower case, every invisible character removed, the ideographic full stop a full stop. */
create function public.study_link_text(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select replace(
           regexp_replace(public.study_lower(p_text), public.study_ignorable_class(), '', 'g'),
           '。', '.')
$fn$;

/* The same, with the Cyrillic and Greek look-alikes of Latin letters folded: for the instruction check. */
create function public.study_heuristic_text(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select translate(public.study_link_text(p_text),
                   'аеорсухіјѕԁԛԝһӏαειкνορτυχ',
                   'aeopcyxijsdqwhlaeikvoptux')
$fn$;

/* As 20260925060000, over `study_heuristic_text`. */
create or replace function public.study_instruction_like(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select public.study_heuristic_text(p_text) ~ (
    '(ignore|disregard)\s+(\S+\s+){0,3}(previous|prior|above|earlier|preceding)\s+'
    '(\S+\s+){0,2}(instructions?|prompts?)\M'
    '|\mforget\s+(everything|all)\s+(\S+\s+){0,2}(above|before|previous|prior)\M'
    '|\mnew\s+instructions\s*:'
    '|#{2,}\s*(instruction|system|response)\M'
    '|(^|\n)\s*(system|assistant)\s*:'
    '|\msystem\s+prompt\M|\mdeveloper\s+mode\M'
    '|\m(you are|act as|pretend to be|roleplay as)\s+(now\s+)?(an?\s+)?'
    '(ai|chatbot|language model|llm|ai assistant)\M'
    '|\mas an ai (language )?model\M|\mas a (large )?language model\M'
    '|<\|\s*(im_start|im_end|system|endoftext)\s*\|>|\[/?inst\]|<</?sys>>')
$fn$;

/* As 20260925080000, over `study_link_text`: a link is compared as it is written. */
create or replace function public.study_links(p_text text)
returns setof text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select distinct regexp_replace(m[1], '[.,;:!?]+$', '')
  from regexp_matches(
         public.study_link_text(p_text),
         '((?:h[tx]{2}ps?|ftp|mailto|javascript|vbscript)\s*:\s*[/\\]*[^\s<>"''()\[\]]+'
         '|data:[a-z]+/[a-z0-9.+-]+[;,][^\s<>"''()\[\]]*'
         '|(?:^|(?<=[\s(<\["'']))//[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"''()\[\]]*'
         '|\mwww\.[^\s<>"''()\[\]]+'
         '|(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]+)?/[^\s<>"''()\[\]]*'
         '|\m[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|dev|xyz|info|biz|ru|cn|tk'
         '|top|site|online|link|click|me|ly|gg|us|uk|de|fr|ai|example|shop|zip|mov|live|club'
         '|icu|buzz|cam|rest|work|fun|xn--[a-z0-9-]+)\M'
         '(?:/[^\s<>"''()\[\]]*)?)',
         'g') as m
$fn$;

revoke all on function
  public.study_ignorable_class(),
  public.study_link_text(text),
  public.study_heuristic_text(text)
from public, anon, authenticated;

-- ------------------------------------------------------------------ 5. unit title

/* As 20260925060000, with `unitTitle` a revision key. */
create or replace function public.revise_study_lesson(p_lesson_id uuid, p_revision jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_gen       uuid;
  v_prev      public.study_lessons%rowtype;
  v_claims    uuid[];
  v_unit      text;
  v_title     text;
  v_objective text;
  v_explain   text;
  v_example   text;
  v_recap     text;
  v_problems  text[];
  v_new       uuid;
  v_unknown   text;
begin
  if auth.uid() is null then
    raise exception 'correcting a course requires a signed-in reader' using errcode = '28000';
  end if;
  perform public.study_check_revision_size(p_revision, jsonb_build_object(
    'unitTitle', jsonb_build_object('chars', 200),
    'title', jsonb_build_object('chars', 200),
    'objective', jsonb_build_object('chars', 500),
    'explanation', jsonb_build_object('chars', 6000),
    'example', jsonb_build_object('chars', 2000),
    'recap', jsonb_build_object('chars', 1000),
    'claimIds', jsonb_build_object('chars', 36, 'items', 6)));
  select k into v_unknown from jsonb_object_keys(p_revision) k
  where k not in ('unitTitle', 'title', 'objective', 'explanation', 'example', 'recap',
                  'claimIds')
  limit 1;
  if v_unknown is not null then
    raise exception 'a lesson revision has no field %', v_unknown using errcode = '22023';
  end if;

  v_gen := public.study_lock_for_correction('lesson', p_lesson_id);
  perform public.study_lock_target('lesson', p_lesson_id);
  select * into v_prev from public.study_lessons where id = p_lesson_id;
  if v_prev.status not in ('validated', 'suspended', 'quarantined') then
    raise exception 'only a live lesson can be revised' using errcode = '55000';
  end if;
  perform public.study_check_revision_quota(v_prev.version);

  v_claims := coalesce(public.study_revision_claims(p_revision, v_gen),
                       array(select lc.claim_id from public.study_lesson_claims lc
                             where lc.lesson_id = v_prev.id));
  v_unit := public.study_revision_text(p_revision, 'unitTitle', v_prev.unit_title);
  v_title := public.study_revision_text(p_revision, 'title', v_prev.title);
  v_objective := public.study_revision_text(p_revision, 'objective', v_prev.objective);
  v_explain := public.study_revision_text(p_revision, 'explanation', v_prev.explanation);
  v_example := public.study_revision_text(p_revision, 'example', v_prev.example);
  v_recap := public.study_revision_text(p_revision, 'recap', v_prev.recap);

  v_problems := public.study_lesson_problems(
    array[v_title, v_objective, v_explain, v_example, v_recap, v_unit], v_claims,
    public.study_source_link_set(v_gen), true);
  if public.study_blank(v_unit) and not 'text_missing' = any(v_problems) then
    v_problems := v_problems || 'text_missing'::text;
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'this revision does not pass validation: %',
      array_to_string(v_problems, ', ')
      using errcode = '22023', detail = array_to_string(v_problems, ',');
  end if;

  perform set_config('study.status_reason', 'revised', true);
  update public.study_lessons set status = 'retired', retired_at = now() where id = v_prev.id;

  insert into public.study_lessons
    (owner_id, generation_id, lesson_key, position, unit_no, unit_title, title, objective,
     explanation, example, recap, minutes, status, lineage_id, version, supersedes_id,
     authored_by)
  values
    (v_prev.owner_id, v_prev.generation_id, v_prev.lesson_key, v_prev.position, v_prev.unit_no,
     v_unit, v_title, v_objective, v_explain, v_example, v_recap, v_prev.minutes,
     'validated', v_prev.lineage_id, v_prev.version + 1, v_prev.id, 'reader')
  returning id into v_new;

  insert into public.study_lesson_claims (lesson_id, claim_id, owner_id)
  select v_new, cited, v_prev.owner_id from unnest(v_claims) as cited;

  update public.study_items set lesson_id = v_new
   where lesson_id = v_prev.id and status <> 'retired';

  update public.study_reports
     set status = 'revised', resolved_at = now(), replacement_lesson_id = v_new
   where lesson_id = v_prev.id and status = 'open';
  return v_new;
end
$fn$;

-- ------------------------------------------------------------------ 6. grants

revoke maintain on
  public.study_generations, public.study_generation_sources,
  public.study_stage_cache, public.study_stage_cache_sources,
  public.study_claims, public.study_claim_evidence,
  public.study_lessons, public.study_lesson_claims,
  public.study_items, public.study_item_claims,
  public.study_status_log, public.study_reports, public.study_answer_events
from service_role;

revoke execute on function public.enable_generation_sweeper(text) from service_role;

-- ------------------------------------------------------------------ 7. numbers

/* As 20260925080000, without the ideographic full stop: `answerKey` removes it. */
create or replace function public.study_normalized(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select translate(
           regexp_replace(public.study_lower(p_text), public.study_hidden_class(), '', 'g'),
           'аеорсухіјѕԁԛԝһӏαειкνορτυχ',
           'aeopcyxijsdqwhlaeikvoptux')
$fn$;

/* As 20260925080000, and a full stop the fold kept -- one between two digits -- continues the number. */
create or replace function public.study_contains_phrase(p_text text, p_phrase text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $fn$
declare
  loose text := public.study_normalized(p_phrase);
  p     text;
begin
  if public.study_strip_punctuation(loose) = '' then
    p := public.study_collapse_spaces(loose);
    return p <> ''
       and strpos(public.study_collapse_spaces(public.study_normalized(p_text)), p) > 0;
  end if;

  p := public.study_fold_strict(p_phrase);
  if p = '' then
    return false;
  end if;
  if p ~ public.study_unspaced_class() then
    return strpos(public.study_fold_strict(p_text), p) > 0;
  end if;
  -- One pass: an occurrence neither preceded nor followed by a character that continues
  -- a word, or by a full stop inside a number. The phrase is escaped, so nothing in it is
  -- read as a pattern.
  return public.study_fold_strict(p_text) ~ (
    '(?<!' || public.study_boundary_class() || ')(?<!\.)'
    || regexp_replace(p, '([][(){}.*+?^$|\\-])', '\\\1', 'g')
    || '(?!' || public.study_boundary_class() || ')(?!\.)');
end
$fn$;

-- ------------------------------------------------------------------ 8. the sweep

drop index public.study_generations_pending_idx;
create index study_generations_pending_idx on public.study_generations (created_at)
  where text_status = 'pending' and assembled_at is not null;

/* As 20260925090000, over persisted courses only: one that never was has nothing to validate. */
create or replace function public.validate_stranded_study_courses(
  p_older_than interval default interval '10 minutes',
  p_limit integer default 5
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  stranded uuid;
  done     integer := 0;
begin
  for stranded in
    select g.job_id
    from public.study_generations g
    join public.generation_jobs j on j.id = g.job_id
    where g.text_status = 'pending'
      and g.assembled_at is not null
      and g.created_at < now() - p_older_than
      and j.status not in ('queued', 'running')
    order by g.created_at
    limit greatest(coalesce(p_limit, 5), 0)
  loop
    begin
      -- Taken without waiting: a course a deletion, a correction or the worker holds is
      -- left for the next run rather than waited on while this run holds the ones before.
      perform 1 from public.study_generations g where g.job_id = stranded for update nowait;
      perform public.validate_study_course(stranded);
      done := done + 1;
    exception when others then
      raise warning 'validate_stranded_study_courses: % skipped: %', stranded, sqlerrm;
    end;
  end loop;
  return done;
end
$fn$;
