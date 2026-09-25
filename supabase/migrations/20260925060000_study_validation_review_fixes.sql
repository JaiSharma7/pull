-- Study validation and correction, after the first review round.
--
-- 20260925050000 is pushed, so it is superseded here (law 6).
--
-- 1. VALIDATION FITS ITS TIME. At the size limits -- 300 claims with three spans each,
--    one 200,000-character source full of links -- `validate_study_course` took 102 s
--    against PostgREST's 8 s statement timeout: each link lower-cased every source again
--    and scanned it. A paid-for course would never have left draft. Links are now read
--    out of the course's sources ONCE per call into a set, and each link found in
--    generated text is a lookup in it; a claim's quoted passage is not link-checked at
--    all, since the evidence check has already proven it is source text.
--
-- 2. BOUNDED REVISIONS. A revision's arrays had a count and no size: one accepted
--    revision stored 12.5 MB, and a refused one burned seconds of CPU before the table
--    refused it -- uncounted, since only inserted rows count. A revision is now measured
--    before anything else runs, every field against the limit the table and
--    `normalizeStudyCourse` hold it to, and the element limits are CHECKs on the table
--    so they hold for any writer. A second correction while one is running fails at once
--    (55P03) rather than queueing a connection behind it.
--
-- 3. HEURISTICS, TIGHTER BOTH WAYS. The instruction check quarantined ordinary prose
--    ("act as an assistant to the surgeon", "the kernel writes a system message", "the
--    <img> element") and let the canonical attack through ("ignore all the previous
--    instructions", or the same with a zero-width space). Both checks now read text
--    after NFKC, with invisible and bidi characters removed and common Cyrillic and Greek
--    look-alikes folded to Latin; the link check also finds bare domains, `hxxps`,
--    `https:host`, `//host`, `mailto:` and `data:` links. They are heuristics and the
--    docs now say so. A reader's revision may not contain invisible characters at all.
--
-- 4. THE COURSE'S OWN TEXT. Title, overview, objectives, recap, disagreements and the
--    withheld list were shown with no check. They are now validated too, as one unit
--    with a status of its own.
--
-- 5. A READER'S VERSION CANNOT MAKE PROOF TRIVIAL. A revision with the accepted answer
--    "x", or its answer in the prompt behind a look-alike letter, passed; once answers are
--    graded, typing "x" would have been proof. A reader's typed answers must now occur in
--    the claims the question rests on, every accepted variant gets the give-away check,
--    and choice, ordering and matching questions carry no accepted variants.
--
-- 6. PROOF THAT CANNOT BE BACK-DATED OR FORGED. An answer's time is the database's, and
--    recording one waits for any status change in flight on its question -- a dismissal
--    that had logged `validated` but not committed let an answer given while suspended
--    count. `service_role` loses the write grants the schema's defaults gave it on the
--    three new tables, and the status log refuses updates. The proof rule takes an event
--    id and reads the row, instead of trusting whatever row it is handed.
--
-- 7. SMALLER THINGS. Retiring a quarantined item failed on the quarantine-reason check;
--    quarantined content can now also be revised, which is the reader's way to correct a
--    false positive. A report's redundant key to `auth.users` could deadlock with an
--    administrator's user deletion; the course key already owns and cascades it. A
--    correction on content deleted mid-flight says so instead of succeeding. A refusal's
--    reasons are in the error's DETAIL. Views return only what a learner may be shown.

-- ------------------------------------------------------------------ constraints

alter table public.study_claims
  drop constraint study_claims_quarantined_has_failure,
  add constraint study_claims_quarantined_has_failure
    check (status <> 'quarantined' or cardinality(validation_failures) > 0);
alter table public.study_lessons
  drop constraint study_lessons_quarantined_has_failure,
  add constraint study_lessons_quarantined_has_failure
    check (status <> 'quarantined' or cardinality(validation_failures) > 0);
alter table public.study_items
  drop constraint study_items_quarantined_has_failure,
  add constraint study_items_quarantined_has_failure
    check (status <> 'quarantined' or cardinality(validation_failures) > 0);

/* Whether every string in an array, or every string field of every object in one, fits. */
create function public.study_texts_fit(p_texts text[], p_max integer)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select coalesce(bool_and(char_length(t) <= p_max), true) from unnest(p_texts) as t
$fn$;

create function public.study_objects_fit(p_objects jsonb, p_max integer)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select coalesce(bool_and(char_length(v #>> '{}') <= p_max), true)
  from jsonb_path_query(p_objects, 'lax $[*].*') as v
$fn$;

alter table public.study_items
  add constraint study_items_accepted_answers_fit
    check (public.study_texts_fit(accepted_answers, 1000)),
  add constraint study_items_sequence_fit check (public.study_texts_fit(sequence, 500)),
  add constraint study_items_distractors_fit check (public.study_objects_fit(distractors, 1000)),
  add constraint study_items_pairs_fit check (public.study_objects_fit(pairs, 300));

-- The course's key to its owner already cascades from `auth.users`; this second one only
-- added a lock an administrator's user deletion takes in the other order.
alter table public.study_reports drop constraint study_reports_owner_id_fkey;

alter table public.study_generations
  add column text_status text not null default 'pending'
    check (text_status in ('pending', 'validated', 'quarantined')),
  add column text_failures text[] not null default '{}',
  add constraint study_generations_text_quarantined_has_failure
    check (text_status <> 'quarantined' or cardinality(text_failures) > 0);

-- ------------------------------------------------------------------ text

/* The characters a reader cannot see: format, invisible separators, bidi controls. */
create function public.study_hidden_class()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select '[­͏؜ᅟᅠ឴឵᠋-᠏​-‏'
         '‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]'
$fn$;

/*
 * Text as the checks read it: NFKC, lower case, invisible characters removed, and the
 * Cyrillic and Greek letters that look like Latin ones folded to them. Not how anything
 * is stored -- only how it is compared, so "rеstudying" with a Cyrillic е is found in a
 * prompt that says "restudying", and "ign​ore" is "ignore".
 */
create function public.study_normalized(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select translate(
           regexp_replace(lower(normalize(coalesce(p_text, ''), nfkc)),
                          public.study_hidden_class(), '', 'g'),
           'аеорсухіјѕԁԛԝһӏαειкνορτυχ',
           'aeopcyxijsdqwhlaeikvoptux')
$fn$;

/*
 * `answerKey` in study.ts, strengthened: the same NFKC, lower case, apostrophe and
 * punctuation handling, over `study_normalized` -- so SQL is stricter than TypeScript
 * about invisible and look-alike characters, and never looser.
 */
create or replace function public.study_fold(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(public.study_normalized(p_text), '[''‘’`]', ' ', 'g'),
             '[]“”".,;:!?()[{}。、「」『』【】〈〉《》・]', '', 'g'),
           '\s+', ' ', 'g'))
$fn$;

/*
 * Text addressed to a model rather than to a reader. A heuristic: phrases an injected
 * passage uses, chosen so ordinary prose about systems, assistants or HTML does not
 * match. What it misses, a person reviewing the course has to catch.
 */
create function public.study_instruction_like(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select public.study_normalized(p_text) ~ (
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

/*
 * The links in a text, normalised: schemes (including `hxxps`, `https:host`, `mailto:`,
 * `javascript:`), `data:` URIs, `//host`, `www.` and bare domains under common and
 * abused top-level domains, with trailing punctuation removed.
 */
create function public.study_links(p_text text)
returns setof text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select distinct regexp_replace(m[1], '[.,;:!?]+$', '')
  from regexp_matches(
         public.study_normalized(p_text),
         '((?:h[tx]{2}ps?|ftp|mailto|javascript|vbscript)\s*:\s*[/\\]*[^\s<>"''()\[\]]+'
         '|data:[a-z]+/[a-z0-9.+-]+[;,][^\s<>"''()\[\]]*'
         '|(?:^|(?<=[\s(<\["'']))//[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"''()\[\]]*'
         '|\mwww\.[^\s<>"''()\[\]]+'
         '|\m[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|dev|xyz|info|biz|ru|cn|tk'
         '|top|site|online|link|click|me|ly|gg|us|uk|de|fr|ai|example)\M'
         '(?:/[^\s<>"''()\[\]]*)?)',
         'g') as m
$fn$;

/*
 * Every link the course's sources contain, and the host of each, as a set: read once per
 * call, so a link in generated text costs a lookup rather than a scan of the sources.
 */
create function public.study_source_link_set(p_generation_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select coalesce(jsonb_object_agg(k, true), '{}'::jsonb)
  from (
    select l as k
    from public.study_generation_sources s
    join public.study_source_versions v on v.id = s.source_version_id,
         public.study_links(v.extracted_text) as l
    where s.generation_id = p_generation_id
    union
    select split_part(regexp_replace(l, '^([a-z]+\s*:\s*[/\\]*|//)', ''), '/', 1)
    from public.study_generation_sources s
    join public.study_source_versions v on v.id = s.source_version_id,
         public.study_links(v.extracted_text) as l
    where s.generation_id = p_generation_id
  ) as found
$fn$;

/* `instruction_like` and `unsourced_link` over some texts, against a course's link set. */
drop function public.study_text_problems(text[], text[]);
create function public.study_text_problems(p_texts text[], p_links jsonb)
returns text[]
language sql
stable
set search_path = ''
as $fn$
  select array_remove(array[
    case when exists (select 1 from unnest(p_texts) t where public.study_instruction_like(t))
         then 'instruction_like' end,
    case when exists (select 1 from unnest(p_texts) t, public.study_links(t) l
                      where not (p_links ? l or p_links ? rtrim(l, '/')))
         then 'unsourced_link' end
  ], null)
$fn$;

/* A reader's text may not hide anything: an invisible character in a revision is refused. */
create function public.study_hidden_problems(p_texts text[])
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select case when exists (select 1 from unnest(p_texts) t where t ~ public.study_hidden_class())
              then array['hidden_characters'] else '{}'::text[] end
$fn$;

-- ------------------------------------------------------------------ the checks

drop function public.study_claim_problems(uuid, text[]);
/*
 * A claim, as 20260925050000 checked it, except that its quoted passages get only the
 * instruction check: `evidence_mismatch` already proves each is the source's own text,
 * so every link in one is in the source.
 */
create function public.study_claim_problems(p_claim_id uuid, p_links jsonb)
returns text[]
language plpgsql
stable
set search_path = ''
as $fn$
declare
  c        public.study_claims%rowtype;
  problems text[] := '{}'::text[];
begin
  select * into c from public.study_claims where id = p_claim_id;
  if not found then
    return array['missing'];
  end if;

  if not exists (
    select 1 from public.study_claim_evidence e
    where e.claim_id = c.id and e.match in ('exact', 'normalized')
  ) then
    problems := problems || 'evidence_missing'::text;
  end if;
  if exists (
    select 1
    from public.study_claim_evidence e
    join public.study_source_versions v on v.id = c.source_version_id
    where e.claim_id = c.id
      and e.start_offset is not null
      and substr(v.extracted_text, e.start_offset + 1, e.end_offset - e.start_offset)
          is distinct from e.span_text
  ) then
    problems := problems || 'evidence_mismatch'::text;
  end if;

  problems := problems
    || public.study_text_problems(array[c.statement, c.attribution] || c.qualifications, p_links);
  if not 'instruction_like' = any (problems) and exists (
    select 1 from public.study_claim_evidence e
    where e.claim_id = c.id and public.study_instruction_like(e.span_text)
  ) then
    problems := problems || 'instruction_like'::text;
  end if;
  return problems;
end
$fn$;

drop function public.study_lesson_problems(text[], uuid[], text[]);
/*
 * A lesson: validated claims under it, and clean text. A reader's version must also have
 * every required field and no invisible character. Texts are title, objective,
 * explanation, example, recap, then any others; the first four but example are required.
 */
create function public.study_lesson_problems(
  p_texts text[],
  p_claim_ids uuid[],
  p_links jsonb,
  p_reader boolean default false
)
returns text[]
language sql
stable
set search_path = ''
as $fn$
  select public.study_claims_problems(p_claim_ids)
      || public.study_text_problems(p_texts, p_links)
      || case when p_reader then public.study_hidden_problems(p_texts) else '{}'::text[] end
      || case when exists (select 1 from unnest(array[p_texts[1], p_texts[2], p_texts[3],
                                                      p_texts[5]]) t
                           where btrim(coalesce(t, '')) = '')
              then array['text_missing'] else '{}'::text[] end
$fn$;

drop function public.study_item_problems(text, text, text, text[], jsonb, text, text[], jsonb,
                                         text, uuid[], uuid, text[]);
/*
 * A question, as 20260925050000 checked it, and further:
 *
 *   accepted_answer_invalid   choice, ordering and matching questions carry no accepted
 *                             variants -- only a typed answer is compared to them
 *   answer_in_prompt          every accepted variant of a typed answer, too
 *   answer_not_in_evidence    for a reader's typed question, the answer and every variant
 *                             must occur in the claims it rests on, so a correction cannot
 *                             make a question anyone passes by typing "x"
 *   hidden_characters         a reader's version, anywhere
 *   text_missing              a prompt, answer or explanation of only whitespace
 */
create function public.study_item_problems(
  p_kind text,
  p_prompt text,
  p_answer text,
  p_accepted text[],
  p_distractors jsonb,
  p_cloze text,
  p_sequence text[],
  p_pairs jsonb,
  p_explanation text,
  p_claim_ids uuid[],
  p_lesson_id uuid,
  p_links jsonb,
  p_reader boolean default false
)
returns text[]
language plpgsql
stable
set search_path = ''
as $fn$
declare
  problems  text[] := public.study_claims_problems(p_claim_ids);
  d         jsonb;
  keys      text[] := '{}'::text[];
  k         text;
  a         text;
  correct   text[];
  steps     text[];
  lefts     text[];
  rights    text[];
  evidence  text;
  texts     text[];
  typed     boolean := p_kind in ('cloze', 'short_recall');
begin
  -- Validated or suspended: at generation every lesson is one or quarantined, and a
  -- reader may correct a question while its lesson is itself under a report.
  if p_lesson_id is not null and not exists (
    select 1 from public.study_lessons l
    where l.id = p_lesson_id and l.status in ('validated', 'suspended')
  ) then
    problems := problems || 'lesson_unavailable'::text;
  end if;

  if public.study_fold(p_answer) = '' then
    problems := problems || 'answer_missing'::text;
  end if;
  if btrim(coalesce(p_prompt, '')) = '' or btrim(coalesce(p_explanation, '')) = '' then
    problems := problems || 'text_missing'::text;
  end if;
  if exists (select 1 from unnest(coalesce(p_accepted, '{}')) x where public.study_fold(x) = '')
     or (not typed and cardinality(coalesce(p_accepted, '{}')) > 0) then
    problems := problems || 'accepted_answer_invalid'::text;
  end if;

  if p_kind in ('multiple_choice', 'comparison', 'application') then
    if jsonb_typeof(p_distractors) is distinct from 'array'
       or jsonb_array_length(p_distractors) not between 2 and 4 then
      problems := problems || 'too_few_distractors'::text;
    else
      correct := array[public.study_fold(p_answer)]
                 || array(select public.study_fold(x) from unnest(coalesce(p_accepted, '{}')) x);
      for d in select value from jsonb_array_elements(p_distractors) loop
        k := public.study_fold(d ->> 'text');
        if k = '' then
          problems := problems || 'distractor_missing'::text;
        elsif k = any (correct) then
          problems := problems || 'distractor_matches_answer'::text;
        elsif k = any (keys) then
          problems := problems || 'duplicate_options'::text;
        end if;
        keys := keys || k;
        if public.study_fold(d ->> 'why') = '' then
          problems := problems || 'distractor_without_rationale'::text;
        end if;
      end loop;
    end if;
  elsif p_kind = 'cloze' then
    if p_cloze is null
       or (char_length(p_cloze) - char_length(replace(p_cloze, '____', ''))) / 4 <> 1 then
      problems := problems || 'cloze_malformed'::text;
    end if;
  elsif p_kind = 'ordering' then
    steps := array(select public.study_fold(s) from unnest(coalesce(p_sequence, '{}')) s);
    if cardinality(steps) not between 3 and 6
       or '' = any (steps)
       or (select count(distinct s) from unnest(steps) s) <> cardinality(steps) then
      problems := problems || 'ordering_malformed'::text;
    end if;
  elsif p_kind = 'matching' then
    if jsonb_typeof(p_pairs) is distinct from 'array'
       or jsonb_array_length(p_pairs) not between 2 and 6 then
      problems := problems || 'matching_malformed'::text;
    else
      lefts := array(select public.study_fold(value ->> 'left') from jsonb_array_elements(p_pairs));
      rights := array(select public.study_fold(value ->> 'right') from jsonb_array_elements(p_pairs));
      if '' = any (lefts) or '' = any (rights)
         or (select count(distinct x) from unnest(lefts) x) <> cardinality(lefts)
         or (select count(distinct x) from unnest(rights) x) <> cardinality(rights) then
        problems := problems || 'matching_malformed'::text;
      end if;
    end if;
  end if;

  if typed then
    -- A give-away, for the answer and for every accepted variant.
    foreach a in array array[p_answer] || coalesce(p_accepted, '{}') loop
      if public.study_gives_away(a)
         and (public.study_contains_phrase(p_prompt, a)
              or (p_kind = 'cloze' and public.study_contains_phrase(p_cloze, a))) then
        problems := problems || 'answer_in_prompt'::text;
        exit;
      end if;
    end loop;

    -- A cloze's blank, and all of a reader's typed answers, must be in the claims.
    if p_kind = 'cloze' or p_reader then
      select string_agg(concat_ws(' ', c.statement,
                                  (select string_agg(e.span_text, ' ')
                                   from public.study_claim_evidence e where e.claim_id = c.id)),
                        ' ')
        into evidence
      from public.study_claims c
      where c.id = any (coalesce(p_claim_ids, '{}'));
      foreach a in array
        case when p_reader then array[p_answer] || coalesce(p_accepted, '{}')
             else array[p_answer] end
      loop
        if not public.study_contains_phrase(evidence, a) then
          problems := problems || 'answer_not_in_evidence'::text;
          exit;
        end if;
      end loop;
    end if;
  end if;

  texts := array[p_prompt, p_answer, p_cloze, p_explanation]
           || coalesce(p_accepted, '{}') || coalesce(p_sequence, '{}');
  if jsonb_typeof(p_distractors) = 'array' then
    texts := texts || array(select concat_ws(' ', value ->> 'text', value ->> 'why')
                            from jsonb_array_elements(p_distractors));
  end if;
  if jsonb_typeof(p_pairs) = 'array' then
    texts := texts || array(select concat_ws(' ', value ->> 'left', value ->> 'right')
                            from jsonb_array_elements(p_pairs));
  end if;
  return problems
      || public.study_text_problems(texts, p_links)
      || case when p_reader then public.study_hidden_problems(texts) else '{}'::text[] end;
end
$fn$;

drop function public.study_course_sources(uuid);

/* Every string the course-level fields hold: title, overview, objectives, recap, and the text in disagreements and withheld. */
create function public.study_course_texts(p_generation_id uuid)
returns text[]
language sql
stable
set search_path = ''
as $fn$
  select array[g.title, g.overview, g.recap] || g.objectives
      || array(select v #>> '{}'
               from jsonb_path_query(g.disagreements || g.withheld,
                                     'lax $.** ? (@.type() == "string")') as v)
  from public.study_generations g
  where g.id = p_generation_id
$fn$;

revoke all on function
  public.study_texts_fit(text[], integer),
  public.study_objects_fit(jsonb, integer),
  public.study_hidden_class(),
  public.study_normalized(text),
  public.study_instruction_like(text),
  public.study_links(text),
  public.study_source_link_set(uuid),
  public.study_text_problems(text[], jsonb),
  public.study_hidden_problems(text[]),
  public.study_claim_problems(uuid, jsonb),
  public.study_lesson_problems(text[], uuid[], jsonb, boolean),
  public.study_item_problems(text, text, text, text[], jsonb, text, text[], jsonb, text, uuid[],
                             uuid, jsonb, boolean),
  public.study_course_texts(uuid)
from public, anon, authenticated;

/*
 * As 20260925050000, with the links read once per call, and the course's own text
 * validated as one unit with a status of its own.
 */
create or replace function public.validate_study_course(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  gen      public.study_generations%rowtype;
  links    jsonb;
  row_id   uuid;
  problems text[];
begin
  select g.* into gen from public.study_generations g where g.job_id = p_job_id for update;
  if not found then
    raise exception 'validate_study_course: the study material for % was deleted', p_job_id
      using errcode = '23503';
  end if;
  perform 1
  from public.study_source_versions v
  join public.study_generation_sources s on s.source_version_id = v.id
  where s.generation_id = gen.id
  for key share of v nowait;

  links := public.study_source_link_set(gen.id);
  perform set_config('study.status_reason', 'validation', true);

  for row_id in
    select c.id from public.study_claims c
    where c.generation_id = gen.id and c.status = 'draft' order by c.claim_key
  loop
    problems := public.study_claim_problems(row_id, links);
    update public.study_claims
       set status = case when cardinality(problems) = 0 then 'validated' else 'quarantined' end,
           validation_failures = problems
     where id = row_id;
  end loop;

  for row_id in
    select l.id from public.study_lessons l
    where l.generation_id = gen.id and l.status = 'draft' order by l.position
  loop
    select public.study_lesson_problems(
             array[l.title, l.objective, l.explanation, l.example, l.recap, l.unit_title],
             array(select lc.claim_id from public.study_lesson_claims lc where lc.lesson_id = l.id),
             links)
      into problems
    from public.study_lessons l where l.id = row_id;
    update public.study_lessons
       set status = case when cardinality(problems) = 0 then 'validated' else 'quarantined' end,
           validation_failures = problems
     where id = row_id;
  end loop;

  for row_id in
    select i.id from public.study_items i
    where i.generation_id = gen.id and i.status = 'draft' order by i.item_key
  loop
    select public.study_item_problems(
             i.kind, i.prompt, i.answer, i.accepted_answers, i.distractors, i.cloze, i.sequence,
             i.pairs, i.explanation,
             array(select ic.claim_id from public.study_item_claims ic where ic.item_id = i.id),
             i.lesson_id, links)
      into problems
    from public.study_items i where i.id = row_id;
    update public.study_items
       set status = case when cardinality(problems) = 0 then 'validated' else 'quarantined' end,
           validation_failures = problems
     where id = row_id;
  end loop;

  if gen.text_status = 'pending' then
    problems := public.study_text_problems(public.study_course_texts(gen.id), links);
    update public.study_generations
       set text_status = case when cardinality(problems) = 0 then 'validated' else 'quarantined' end,
           text_failures = problems
     where id = gen.id;
  end if;

  return jsonb_build_object(
    'generationId', gen.id,
    'courseText', (select g.text_status from public.study_generations g where g.id = gen.id),
    'claims', (select jsonb_object_agg(s, n) from (
                 select c.status as s, count(*) as n from public.study_claims c
                 where c.generation_id = gen.id group by c.status) t),
    'lessons', (select jsonb_object_agg(s, n) from (
                  select l.status as s, count(*) as n from public.study_lessons l
                  where l.generation_id = gen.id group by l.status) t),
    'items', (select jsonb_object_agg(s, n) from (
                select i.status as s, count(*) as n from public.study_items i
                where i.generation_id = gen.id group by i.status) t)
  );
end
$fn$;

-- ------------------------------------------------------------------ corrections

/*
 * As 20260925050000, except: a second correction while one runs fails at once (55P03)
 * instead of holding a connection in a queue, and a course deleted while this waited is
 * reported as gone rather than carried on with.
 */
create or replace function public.study_lock_for_correction(p_kind text, p_id uuid)
returns uuid
language plpgsql
set search_path = ''
as $fn$
declare
  uid    uuid := auth.uid();
  gen_id uuid;
begin
  if uid is null then
    raise exception 'correcting a course requires a signed-in reader' using errcode = '28000';
  end if;
  if not pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('what-a-pull:study-correction:' || uid::text, 0)) then
    raise exception 'another correction of yours is still running' using errcode = '55P03';
  end if;

  if p_kind = 'claim' then
    select c.generation_id into gen_id from public.study_claims c
    where c.id = p_id and c.owner_id = uid;
  elsif p_kind = 'lesson' then
    select l.generation_id into gen_id from public.study_lessons l
    where l.id = p_id and l.owner_id = uid;
  elsif p_kind = 'item' then
    select i.generation_id into gen_id from public.study_items i
    where i.id = p_id and i.owner_id = uid;
  else
    raise exception 'unknown kind of course content: %', p_kind using errcode = '22023';
  end if;
  if gen_id is null then
    raise exception 'no such % in your courses', p_kind using errcode = 'P0002';
  end if;

  perform 1 from public.study_generations g where g.id = gen_id for update;
  if not found then
    raise exception 'no such % in your courses', p_kind using errcode = 'P0002';
  end if;
  perform 1
  from public.study_source_versions v
  join public.study_generation_sources s on s.source_version_id = v.id
  where s.generation_id = gen_id
  for key share of v nowait;
  return gen_id;
end
$fn$;

/* The target's status under lock, or a P0002 if it went while this waited. */
create function public.study_lock_target(p_kind text, p_id uuid)
returns text
language plpgsql
set search_path = ''
as $fn$
declare
  st text;
begin
  if p_kind = 'claim' then
    select c.status into st from public.study_claims c where c.id = p_id for update;
  elsif p_kind = 'lesson' then
    select l.status into st from public.study_lessons l where l.id = p_id for update;
  else
    select i.status into st from public.study_items i where i.id = p_id for update;
  end if;
  if st is null then
    raise exception 'no such % in your courses', p_kind using errcode = 'P0002';
  end if;
  return st;
end
$fn$;

/*
 * A revision's size, measured before anything else runs: the whole payload, then every
 * field against the limit the table (and `normalizeStudyCourse`) hold it to.
 */
create function public.study_check_revision_size(p_revision jsonb, p_limits jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $fn$
declare
  lim  record;
  v    jsonb;
  e    jsonb;
begin
  if jsonb_typeof(p_revision) is distinct from 'object' then
    raise exception 'a revision is an object' using errcode = '22023';
  end if;
  if octet_length(p_revision::text) > 32768 then
    raise exception 'a revision is at most 32 KB' using errcode = '22023';
  end if;
  for lim in select key, (value ->> 'chars')::int as chars, (value ->> 'items')::int as items
             from jsonb_each(p_limits) loop
    v := p_revision -> lim.key;
    continue when v is null or jsonb_typeof(v) = 'null';
    if jsonb_typeof(v) = 'string' then
      if char_length(v #>> '{}') > lim.chars then
        raise exception '% is longer than % characters', lim.key, lim.chars using errcode = '22023';
      end if;
    elsif jsonb_typeof(v) = 'array' then
      if lim.items is not null and jsonb_array_length(v) > lim.items then
        raise exception '% has more than % entries', lim.key, lim.items using errcode = '22023';
      end if;
      for e in select value from jsonb_array_elements(v) loop
        if (jsonb_typeof(e) = 'string' and char_length(e #>> '{}') > lim.chars)
           or (jsonb_typeof(e) = 'object' and not public.study_objects_fit(jsonb_build_array(e),
                                                                          lim.chars)) then
          raise exception 'an entry of % is longer than % characters', lim.key, lim.chars
            using errcode = '22023';
        end if;
      end loop;
    end if;
  end loop;
end
$fn$;

revoke all on function
  public.study_lock_target(text, uuid),
  public.study_check_revision_size(jsonb, jsonb)
from public, anon, authenticated;

create or replace function public.report_study_content(
  p_kind text,
  p_id uuid,
  p_reason text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  uid       uuid := auth.uid();
  gen_id    uuid;
  st        text;
  report_id uuid;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_reason is null or p_reason not in
     ('incorrect', 'unsupported', 'ambiguous', 'unanswerable', 'other') then
    raise exception 'unknown report reason' using errcode = '22023';
  end if;
  if char_length(v_note) > 1000 then
    raise exception 'a report note is at most 1000 characters' using errcode = '22023';
  end if;
  gen_id := public.study_lock_for_correction(p_kind, p_id);

  if (select count(*) from public.study_reports r
      where r.owner_id = uid
        and r.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc')
     >= 50 then
    raise exception 'daily report limit reached' using errcode = '54000';
  end if;

  st := public.study_lock_target(p_kind, p_id);
  if st not in ('validated', 'suspended') then
    raise exception 'only a claim, lesson or question you can see can be reported'
      using errcode = '55000';
  end if;

  insert into public.study_reports (owner_id, generation_id, claim_id, lesson_id, item_id,
                                    reason, note)
  values (uid, gen_id,
          case when p_kind = 'claim' then p_id end,
          case when p_kind = 'lesson' then p_id end,
          case when p_kind = 'item' then p_id end,
          p_reason, v_note)
  returning id into report_id;

  perform set_config('study.status_reason', 'reported', true);
  if p_kind = 'claim' then
    perform public.study_refresh_claim(p_id);
    perform set_config('study.status_reason', 'claim_reported', true);
    perform public.study_refresh_claim_dependents(p_id);
  elsif p_kind = 'lesson' then
    perform public.study_refresh_lesson(p_id);
  else
    perform public.study_refresh_item(p_id);
  end if;
  return report_id;
end
$fn$;

/*
 * As 20260925050000, except that quarantined content can be retired -- the check on its
 * reasons no longer refuses a retired row that keeps them -- and content deleted while
 * this waited is reported as gone.
 */
create or replace function public.retire_study_content(p_kind text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  st text;
begin
  perform public.study_lock_for_correction(p_kind, p_id);
  st := public.study_lock_target(p_kind, p_id);
  if st not in ('validated', 'suspended', 'quarantined') then
    raise exception 'only a live claim, lesson or question can be retired'
      using errcode = '55000';
  end if;

  perform set_config('study.status_reason', 'retired', true);
  if p_kind = 'claim' then
    update public.study_claims set status = 'retired', retired_at = now() where id = p_id;
    update public.study_reports set status = 'retired', resolved_at = now()
     where claim_id = p_id and status = 'open';
    perform set_config('study.status_reason', 'claim_retired', true);
    perform public.study_refresh_claim_dependents(p_id);
  elsif p_kind = 'lesson' then
    update public.study_lessons set status = 'retired', retired_at = now() where id = p_id;
    update public.study_reports set status = 'retired', resolved_at = now()
     where lesson_id = p_id and status = 'open';
    update public.study_items set lesson_id = null
     where lesson_id = p_id and status <> 'retired';
  else
    update public.study_items set status = 'retired', retired_at = now() where id = p_id;
    update public.study_reports set status = 'retired', resolved_at = now()
     where item_id = p_id and status = 'open';
  end if;
end
$fn$;

/*
 * As 20260925050000, measured first, and with three differences: a quarantined question
 * can be revised (the reader's way to correct a false positive), the reader's version is
 * checked as the reader's (`p_reader`), and a refusal's reasons are in its DETAIL.
 */
create or replace function public.revise_study_item(p_item_id uuid, p_revision jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_gen      uuid;
  v_prev     public.study_items%rowtype;
  v_claims   uuid[];
  v_prompt   text;
  v_answer   text;
  v_accepted text[];
  v_distract jsonb;
  v_cloze    text;
  v_sequence text[];
  v_pairs    jsonb;
  v_explain  text;
  v_problems text[];
  v_new      uuid;
  v_unknown  text;
begin
  if auth.uid() is null then
    raise exception 'correcting a course requires a signed-in reader' using errcode = '28000';
  end if;
  perform public.study_check_revision_size(p_revision, jsonb_build_object(
    'prompt', jsonb_build_object('chars', 1000),
    'answer', jsonb_build_object('chars', 1000),
    'cloze', jsonb_build_object('chars', 1000),
    'explanation', jsonb_build_object('chars', 2000),
    'acceptedAnswers', jsonb_build_object('chars', 1000, 'items', 6),
    'sequence', jsonb_build_object('chars', 500, 'items', 6),
    'distractors', jsonb_build_object('chars', 1000, 'items', 4),
    'pairs', jsonb_build_object('chars', 300, 'items', 6),
    'claimIds', jsonb_build_object('chars', 36, 'items', 6)));
  select k into v_unknown from jsonb_object_keys(p_revision) k
  where k not in ('prompt', 'answer', 'acceptedAnswers', 'distractors', 'cloze', 'sequence',
                  'pairs', 'explanation', 'claimIds')
  limit 1;
  if v_unknown is not null then
    raise exception 'a question revision has no field %', v_unknown using errcode = '22023';
  end if;

  v_gen := public.study_lock_for_correction('item', p_item_id);
  perform public.study_lock_target('item', p_item_id);
  select * into v_prev from public.study_items where id = p_item_id;
  if v_prev.status not in ('validated', 'suspended', 'quarantined') then
    raise exception 'only a live question can be revised' using errcode = '55000';
  end if;
  perform public.study_check_revision_quota(v_prev.version);

  v_claims := coalesce(public.study_revision_claims(p_revision, v_gen),
                       array(select ic.claim_id from public.study_item_claims ic
                             where ic.item_id = v_prev.id));
  v_prompt := public.study_revision_text(p_revision, 'prompt', v_prev.prompt);
  v_answer := public.study_revision_text(p_revision, 'answer', v_prev.answer);
  v_accepted := public.study_revision_texts(p_revision, 'acceptedAnswers',
                                            v_prev.accepted_answers);
  v_distract := public.study_revision_objects(p_revision, 'distractors', array['text', 'why'],
                                              v_prev.distractors);
  v_cloze := public.study_revision_text(p_revision, 'cloze', v_prev.cloze);
  v_sequence := public.study_revision_texts(p_revision, 'sequence', v_prev.sequence);
  v_pairs := public.study_revision_objects(p_revision, 'pairs', array['left', 'right'],
                                           v_prev.pairs);
  v_explain := public.study_revision_text(p_revision, 'explanation', v_prev.explanation);

  v_problems := public.study_item_problems(
    v_prev.kind, v_prompt, v_answer, v_accepted, v_distract, v_cloze, v_sequence, v_pairs,
    v_explain, v_claims, v_prev.lesson_id, public.study_source_link_set(v_gen), true);
  if cardinality(v_problems) > 0 then
    raise exception 'this revision does not pass validation: %',
      array_to_string(v_problems, ', ')
      using errcode = '22023', detail = array_to_string(v_problems, ',');
  end if;

  perform set_config('study.status_reason', 'revised', true);
  update public.study_items set status = 'retired', retired_at = now() where id = v_prev.id;

  insert into public.study_items
    (owner_id, generation_id, lesson_id, item_key, purpose, kind, prompt, answer,
     accepted_answers, distractors, cloze, sequence, pairs, explanation, difficulty, status,
     lineage_id, version, supersedes_id, authored_by)
  values
    (v_prev.owner_id, v_prev.generation_id, v_prev.lesson_id, v_prev.item_key, v_prev.purpose,
     v_prev.kind, v_prompt, v_answer, coalesce(v_accepted, '{}'),
     coalesce(v_distract, '[]'::jsonb), v_cloze, coalesce(v_sequence, '{}'),
     coalesce(v_pairs, '[]'::jsonb), v_explain, v_prev.difficulty, 'validated',
     v_prev.lineage_id, v_prev.version + 1, v_prev.id, 'reader')
  returning id into v_new;

  insert into public.study_item_claims (item_id, claim_id, owner_id)
  select v_new, cited, v_prev.owner_id from unnest(v_claims) as cited;

  update public.study_reports
     set status = 'revised', resolved_at = now(), replacement_item_id = v_new
   where item_id = v_prev.id and status = 'open';
  return v_new;
end
$fn$;

/* The same for a lesson. */
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
    'title', jsonb_build_object('chars', 200),
    'objective', jsonb_build_object('chars', 500),
    'explanation', jsonb_build_object('chars', 6000),
    'example', jsonb_build_object('chars', 2000),
    'recap', jsonb_build_object('chars', 1000),
    'claimIds', jsonb_build_object('chars', 36, 'items', 6)));
  select k into v_unknown from jsonb_object_keys(p_revision) k
  where k not in ('title', 'objective', 'explanation', 'example', 'recap', 'claimIds')
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
  v_title := public.study_revision_text(p_revision, 'title', v_prev.title);
  v_objective := public.study_revision_text(p_revision, 'objective', v_prev.objective);
  v_explain := public.study_revision_text(p_revision, 'explanation', v_prev.explanation);
  v_example := public.study_revision_text(p_revision, 'example', v_prev.example);
  v_recap := public.study_revision_text(p_revision, 'recap', v_prev.recap);

  v_problems := public.study_lesson_problems(
    array[v_title, v_objective, v_explain, v_example, v_recap, v_prev.unit_title], v_claims,
    public.study_source_link_set(v_gen), true);
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
     v_prev.unit_title, v_title, v_objective, v_explain, v_example, v_recap, v_prev.minutes,
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

-- ------------------------------------------------------------------ proof

/*
 * An answer's time is the database's, taken once the question's row can be read without
 * a status change in flight on it. The caller's `answered_at` is ignored: an offline sync
 * or a buggy recorder could otherwise back-date an answer given while the question was
 * suspended into a window where it was validated, and a dismissal that had logged
 * `validated` but not committed let an answer recorded in that gap count.
 */
create function public.study_answer_events_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform 1 from public.study_items i where i.id = new.item_id for share;
  new.answered_at := clock_timestamp();
  return new;
end
$fn$;

revoke all on function public.study_answer_events_stamp() from public, anon, authenticated;

create trigger study_answer_events_stamp before insert on public.study_answer_events
  for each row execute function public.study_answer_events_stamp();

/* The status log is what the proof rule reads, so it is append-only too. */
create function public.study_status_log_is_final()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'the status log cannot be changed' using errcode = '55000';
end
$fn$;

revoke all on function public.study_status_log_is_final() from public, anon, authenticated;

create trigger study_status_log_is_final before update on public.study_status_log
  for each row execute function public.study_status_log_is_final();

-- The schema's default privileges gave the service role every write on these three.
-- Nothing needs one: every writer is a definer function or the owner's trigger.
revoke insert, update, delete, truncate, references, trigger
  on public.study_status_log, public.study_reports, public.study_answer_events
  from service_role;

/*
 * The proof rule of 20260925050000, by event id: it reads the row itself, under the
 * caller's rights, instead of trusting a row it is handed -- a reader passing a
 * fabricated row got `true`. An id the caller cannot read is not proof.
 */
drop function public.study_proven_claims();
drop function public.study_answer_proves_recall(public.study_answer_events);

create function public.study_answer_proves_recall(p_event_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select coalesce((
    select e.correct
       and not e.hinted
       and e.grading = 'deterministic'
       and public.study_item_status_at(e.item_id, e.answered_at) = 'validated'
       and exists (select 1 from public.study_items i
                   where i.id = e.item_id and i.status = 'validated')
       and not exists (select 1 from public.study_item_claims ic
                       join public.study_claims c on c.id = ic.claim_id
                       where ic.item_id = e.item_id and c.status <> 'validated')
    from public.study_answer_events e
    where e.id = p_event_id), false)
$fn$;

create function public.study_proven_claims()
returns table (claim_id uuid, proven_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select ic.claim_id, max(e.answered_at)
  from public.study_answer_events e
  join public.study_item_claims ic on ic.item_id = e.item_id
  where public.study_answer_proves_recall(e.id)
  group by ic.claim_id
$fn$;

revoke all on function
  public.study_answer_proves_recall(uuid),
  public.study_proven_claims()
from public, anon;
grant execute on function
  public.study_answer_proves_recall(uuid),
  public.study_proven_claims()
to authenticated, service_role;

-- ------------------------------------------------------------------ what may be shown

/*
 * What a learner may be shown, and nothing else. The tables' read policies return every
 * status -- the account export needs them -- so a screen that reads a table must filter
 * on `status = 'validated'` itself; a screen that reads these views cannot forget to.
 * Invoker's rights, so each reader sees only their own.
 */
create view public.study_visible_claims with (security_invoker = true) as
  select * from public.study_claims where status = 'validated';
create view public.study_visible_lessons with (security_invoker = true) as
  select * from public.study_lessons where status = 'validated';
create view public.study_visible_items with (security_invoker = true) as
  select * from public.study_items where status = 'validated';
create view public.study_visible_courses with (security_invoker = true) as
  select * from public.study_generations where text_status = 'validated';

revoke all on public.study_visible_claims, public.study_visible_lessons,
  public.study_visible_items, public.study_visible_courses from public, anon;
grant select on public.study_visible_claims, public.study_visible_lessons,
  public.study_visible_items, public.study_visible_courses to authenticated;
