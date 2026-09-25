-- Study validation and correction (roadmap PR 5).
--
-- 20260925010000 persisted a course as `draft` and `rejected` rows: well-formed or not,
-- and shown to nobody. This decides which drafts a learner may be shown, and gives the
-- reader a way to say one is wrong that suspends it at once, keeps its history, and
-- leads to a corrected version that has to pass the same checks.
--
-- 1. A LIFECYCLE for claims, lessons and questions:
--
--        draft --validate--> validated --report--> suspended --dismiss--> validated
--          \                    \                      \
--           `--> quarantined     `------retire / revise-`--> retired
--
--    `rejected` is unchanged (malformed at generation, kept for audit). Only `validated`
--    is ever shown to a learner. A question also becomes `suspended` when a claim it
--    rests on is reported, and `validated` again when that report is dismissed.
--
-- 2. VERSIONED IDENTITIES. A correction never edits a question or lesson in place: it
--    mints a new row -- a new id, the same lineage, version + 1 -- and retires the old
--    one, and at most one version of a lineage is ever live. An answer names the exact
--    version it answered, so it can never vouch for another.
--
-- 3. A STATUS LOG, written by trigger, so no transition can happen off the record and
--    "what was this question when it was answered" has an answer.
--
-- 4. DETERMINISTIC VALIDATION, in SQL rather than in the worker, so the worker's
--    `study_validate` step and a reader's revision run the same checks, in the same
--    transaction as the status they decide, and neither can skip them.
--
-- 5. REPORTS, and a reader's three ways to resolve one: dismiss, retire, revise.
--
-- 6. ANSWER EVENTS AND THE PROOF RULE. The table the practice screens will record
--    into, with no reader write path at all -- `recall_events` accepts rows straight
--    from the browser, and that is exactly what generated material must not -- and
--    `study_answer_proves_recall`, the one definition of what may count as recall.

-- ------------------------------------------------------------------ 1. lifecycle

alter table public.study_claims drop constraint study_claims_status_check;
alter table public.study_lessons drop constraint study_lessons_status_check;
alter table public.study_items drop constraint study_items_status_check;

alter table public.study_claims
  add constraint study_claims_status_check check (status in
    ('draft', 'rejected', 'quarantined', 'validated', 'suspended', 'retired')),
  add column validation_failures text[] not null default '{}',
  add column retired_at timestamptz,
  add constraint study_claims_quarantined_has_failure
    check ((status = 'quarantined') = (cardinality(validation_failures) > 0)),
  add constraint study_claims_retired_when check ((status = 'retired') = (retired_at is not null));

/*
 * Lessons and questions are the two things a reader can correct, so they are the two
 * that carry a lineage. `version` 1 is what the model wrote; every later version is the
 * reader's, and says so -- a revision has no prompt, schema or model behind it, and
 * pretending otherwise would put a model's name on the reader's words.
 */
alter table public.study_lessons
  add constraint study_lessons_status_check check (status in
    ('draft', 'rejected', 'quarantined', 'validated', 'suspended', 'retired')),
  add column validation_failures text[] not null default '{}',
  add column retired_at timestamptz,
  add column lineage_id uuid not null default extensions.gen_random_uuid(),
  add column version smallint not null default 1 check (version between 1 and 50),
  add column supersedes_id uuid,
  add column authored_by text not null default 'model' check (authored_by in ('model', 'reader')),
  alter column prompt_hash drop not null,
  alter column schema_hash drop not null,
  alter column model drop not null,
  add constraint study_lessons_quarantined_has_failure
    check ((status = 'quarantined') = (cardinality(validation_failures) > 0)),
  add constraint study_lessons_retired_when check ((status = 'retired') = (retired_at is not null)),
  add constraint study_lessons_first_version check ((version = 1) = (supersedes_id is null)),
  add constraint study_lessons_provenance check (
    (authored_by = 'model')
    = (prompt_hash is not null and schema_hash is not null and model is not null)),
  add constraint study_lessons_supersedes_fk foreign key (supersedes_id, owner_id)
    references public.study_lessons (id, owner_id) on delete cascade;

alter table public.study_items
  add constraint study_items_status_check check (status in
    ('draft', 'rejected', 'quarantined', 'validated', 'suspended', 'retired')),
  add column validation_failures text[] not null default '{}',
  add column retired_at timestamptz,
  add column lineage_id uuid not null default extensions.gen_random_uuid(),
  add column version smallint not null default 1 check (version between 1 and 50),
  add column supersedes_id uuid,
  add column authored_by text not null default 'model' check (authored_by in ('model', 'reader')),
  alter column prompt_hash drop not null,
  alter column schema_hash drop not null,
  alter column model drop not null,
  add constraint study_items_quarantined_has_failure
    check ((status = 'quarantined') = (cardinality(validation_failures) > 0)),
  add constraint study_items_retired_when check ((status = 'retired') = (retired_at is not null)),
  add constraint study_items_first_version check ((version = 1) = (supersedes_id is null)),
  add constraint study_items_provenance check (
    (authored_by = 'model')
    = (prompt_hash is not null and schema_hash is not null and model is not null)),
  add constraint study_items_supersedes_fk foreign key (supersedes_id, owner_id)
    references public.study_items (id, owner_id) on delete cascade;

/*
 * A key names a lesson or question within its course, across its versions; a
 * position names a live lesson. Each was unique per course, which a second version
 * would break, so each is now unique per version -- and one version per lineage is
 * live at a time, which is the invariant the rest of this file leans on.
 */
alter table public.study_lessons
  drop constraint study_lessons_generation_id_lesson_key_key,
  drop constraint study_lessons_generation_id_position_key,
  add constraint study_lessons_key_version_key unique (generation_id, lesson_key, version);
alter table public.study_items
  drop constraint study_items_generation_id_item_key_key,
  add constraint study_items_key_version_key unique (generation_id, item_key, version);

create unique index study_lessons_lineage_version on public.study_lessons (lineage_id, version);
create unique index study_lessons_one_live on public.study_lessons (lineage_id)
  where status <> 'retired';
create unique index study_lessons_live_position on public.study_lessons (generation_id, position)
  where status <> 'retired';
create index study_lessons_supersedes_idx on public.study_lessons (supersedes_id, owner_id);

create unique index study_items_lineage_version on public.study_items (lineage_id, version);
create unique index study_items_one_live on public.study_items (lineage_id)
  where status <> 'retired';
create index study_items_supersedes_idx on public.study_items (supersedes_id, owner_id);

-- ---------------------------------------------------------------- 3. status log

/*
 * One row per status a claim, lesson or question has ever had, including its first.
 *
 * Written by trigger, so no path -- the worker, a reader's correction, a future
 * operator script -- can change a status without leaving the row behind. The reason is
 * whatever the writing function put in `study.status_reason` for its transaction.
 * `at` is clock time, not transaction time, so two changes in one transaction still
 * order, and the proof rule can ask what a question was at the instant it was answered.
 */
create table public.study_status_log (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null,
  claim_id    uuid,
  lesson_id   uuid,
  item_id     uuid,
  from_status text,
  to_status   text not null,
  reason      text not null check (char_length(reason) between 1 and 40),
  at          timestamptz not null default clock_timestamp(),
  constraint study_status_log_one_target check (num_nonnulls(claim_id, lesson_id, item_id) = 1),
  foreign key (claim_id, owner_id)
    references public.study_claims (id, owner_id) on delete cascade,
  foreign key (lesson_id, owner_id)
    references public.study_lessons (id, owner_id) on delete cascade,
  foreign key (item_id, owner_id)
    references public.study_items (id, owner_id) on delete cascade
);

create index study_status_log_claim_idx on public.study_status_log (claim_id, owner_id);
create index study_status_log_lesson_idx on public.study_status_log (lesson_id, owner_id);
create index study_status_log_item_idx on public.study_status_log (item_id, owner_id, at);
create index study_status_log_owner_idx on public.study_status_log (owner_id);

create function public.study_log_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  why text := coalesce(nullif(current_setting('study.status_reason', true), ''),
                       case when tg_op = 'INSERT' then 'generated' else 'updated' end);
begin
  insert into public.study_status_log
    (owner_id, claim_id, lesson_id, item_id, from_status, to_status, reason)
  values
    (new.owner_id,
     case when tg_table_name = 'study_claims' then new.id end,
     case when tg_table_name = 'study_lessons' then new.id end,
     case when tg_table_name = 'study_items' then new.id end,
     case when tg_op = 'UPDATE' then old.status end,
     new.status,
     left(why, 40));
  return null;
end
$fn$;

revoke all on function public.study_log_status() from public, anon, authenticated;

create trigger study_claims_log_insert after insert on public.study_claims
  for each row execute function public.study_log_status();
create trigger study_claims_log_update after update of status on public.study_claims
  for each row when (old.status is distinct from new.status)
  execute function public.study_log_status();
create trigger study_lessons_log_insert after insert on public.study_lessons
  for each row execute function public.study_log_status();
create trigger study_lessons_log_update after update of status on public.study_lessons
  for each row when (old.status is distinct from new.status)
  execute function public.study_log_status();
create trigger study_items_log_insert after insert on public.study_items
  for each row execute function public.study_log_status();
create trigger study_items_log_update after update of status on public.study_items
  for each row when (old.status is distinct from new.status)
  execute function public.study_log_status();

-- Rows written before the log existed start it at their current status.
insert into public.study_status_log (owner_id, claim_id, to_status, reason, at)
select owner_id, id, status, 'generated', created_at from public.study_claims;
insert into public.study_status_log (owner_id, lesson_id, to_status, reason, at)
select owner_id, id, status, 'generated', created_at from public.study_lessons;
insert into public.study_status_log (owner_id, item_id, to_status, reason, at)
select owner_id, id, status, 'generated', created_at from public.study_items;

-- ------------------------------------------------------------- 4. the checks

/*
 * Answers compared the way a reader sees them: `answerKey` in
 * `supabase/functions/_shared/study.ts`, in SQL. NFKC, lower case, an apostrophe
 * separates words, the same explicit punctuation is removed -- not POSIX `[:punct:]`,
 * which would make "C" and "C++" the same option -- and whitespace collapsed.
 */
create function public.study_fold(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(lower(normalize(coalesce(p_text, ''), nfkc)), '[''‘’`]', ' ', 'g'),
             '[]“”".,;:!?()[{}。、「」『』【】〈〉《》・]', '', 'g'),
           '\s+', ' ', 'g'))
$fn$;

/*
 * Scripts where a word does not end at a space (Han, kana, Hangul, Thai and its
 * neighbours), and the combining marks that continue a word in a spaced script --
 * `UNSPACED_SCRIPT` and `continuesWord` in study.ts.
 */
create function public.study_unspaced_class()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select '[㐀-䶿一-鿿豈-﫿぀-ヿㇰ-ㇿ'
         'ᄀ-ᇿ㄰-㆏가-힯฀-໿ក-៿က-႟]'
$fn$;

/*
 * Whether `p_phrase` occurs in `p_text` as a whole word or words, after folding --
 * `containsPhrase` in study.ts. A phrase in a script written without spaces is a plain
 * substring; otherwise neither edge may continue a word, where a letter, digit or
 * combining mark continues one unless it belongs to a script written without spaces.
 */
create function public.study_contains_phrase(p_text text, p_phrase text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $fn$
declare
  t        text := public.study_fold(p_text);
  p        text := public.study_fold(p_phrase);
  unspaced text := public.study_unspaced_class();
  edge     text;
begin
  if p = '' then
    return false;
  end if;
  if p ~ unspaced then
    return strpos(t, p) > 0;
  end if;
  edge := '[^[:alnum:]̀-ͯ҃-҉֑-ֽؐ-ًؚ-ٟ'
          'ऀ-෿᪰-᫿᷀-᷿⃐-⃿︠-︯]|' || unspaced;
  return t ~ ('(^|' || edge || ')'
              || regexp_replace(p, '([][(){}.*+?^$|\\-])', '\\\1', 'g')
              || '($|' || edge || ')');
end
$fn$;

/* A printed answer is a give-away once it is two characters of CJK, or three of anything else. */
create function public.study_gives_away(p_answer text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case
           when public.study_fold(p_answer) ~ public.study_unspaced_class()
             then char_length(public.study_fold(p_answer)) >= 2
           else char_length(public.study_fold(p_answer)) >= 3
         end
$fn$;

/*
 * What generated or revised text must not contain, whatever it is about.
 *
 *   instruction_like  text addressed to a model rather than to a reader -- "ignore the
 *                     previous instructions", a system prompt, a chat-template token, a
 *                     script tag. A document that says it may be about prompt injection;
 *                     then its questions wait in quarantine for a person, which is where
 *                     an adversarial item belongs either way.
 *   unsourced_link    a link that appears in none of the course's sources. The model has
 *                     no business inventing one, and a link is what an injected passage
 *                     would most want a learner to follow.
 */
create function public.study_text_problems(p_texts text[], p_sources text[])
returns text[]
language plpgsql
stable
set search_path = ''
as $fn$
declare
  found     text[] := '{}'::text[];
  t         text;
  link      text;
  in_source boolean;
  src       text;
begin
  foreach t in array coalesce(p_texts, '{}') loop
    continue when t is null or t = '';
    if not 'instruction_like' = any (found)
       and lower(normalize(t, nfkc)) ~ (
         'ignore\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding)\s+'
         '(instructions?|prompts?|directions?|rules|messages?)'
         '|disregard\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding)'
         '|\m(system|developer)\s+(prompt|message|instructions?)\M'
         '|\m(you are|act as|pretend to be|roleplay as)\s+(now\s+)?(an?\s+)?'
         '(ai|assistant|chatbot|language model|llm)\M'
         '|\mas an ai\M|\mas a (large )?language model\M'
         '|<\s*/?\s*(script|iframe|object|embed|svg|img)\M'
         '|javascript\s*:|data\s*:\s*text/html'
         '|<\|\s*(im_start|im_end|system|endoftext)\s*\|>')
    then
      found := found || 'instruction_like'::text;
    end if;

    if not 'unsourced_link' = any (found) and t ~* '(https?://|\mwww\.)' then
      for link in
        select regexp_replace(m[1], '[.,;:!?]+$', '')
        from regexp_matches(t, '((https?://|\mwww\.)[^\s<>"''()\]\[]+)', 'gi') as m
      loop
        in_source := false;
        foreach src in array coalesce(p_sources, '{}') loop
          if strpos(lower(src), lower(link)) > 0 then
            in_source := true;
            exit;
          end if;
        end loop;
        if not in_source then
          found := found || 'unsourced_link'::text;
          exit;
        end if;
      end loop;
    end if;
  end loop;
  return found;
end
$fn$;

/* Whether every claim named is validated, and at least one is named. */
create function public.study_claims_problems(p_claim_ids uuid[])
returns text[]
language sql
stable
set search_path = ''
as $fn$
  select case
           when cardinality(coalesce(p_claim_ids, '{}')) = 0 then array['no_known_claims']
           when exists (
             select 1 from unnest(p_claim_ids) as cited(id)
             left join public.study_claims c on c.id = cited.id
             where c.status is distinct from 'validated'
           ) then array['cites_unvalidated_claim']
           else '{}'::text[]
         end
$fn$;

/*
 * A claim: evidence that still resolves to the stored text, and nothing addressed to a
 * model in the claim or the passage it quotes. `persist_study_course` already refused a
 * span that was not the stored text; checking again costs a `substr` and means this
 * does not depend on every writer having done so.
 */
create function public.study_claim_problems(p_claim_id uuid, p_sources text[])
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

  return problems || public.study_text_problems(
    array[c.statement, c.attribution] || c.qualifications
      || array(select e.span_text from public.study_claim_evidence e where e.claim_id = c.id),
    p_sources);
end
$fn$;

/* A lesson: validated claims under it, and clean text. */
create function public.study_lesson_problems(
  p_texts text[],
  p_claim_ids uuid[],
  p_sources text[]
)
returns text[]
language sql
stable
set search_path = ''
as $fn$
  select public.study_claims_problems(p_claim_ids) || public.study_text_problems(p_texts, p_sources)
$fn$;

/*
 * A question, by the rules a machine can decide without judging meaning. The shape
 * rules mirror `normalizeStudyCourse` in study.ts, so a model's question that passed
 * there passes the shape rules here; what this adds is what only the whole course can
 * answer, and the rules a reader's revision must meet as well:
 *
 *   cites_unvalidated_claim / no_known_claims   every claim it rests on is validated
 *   lesson_unavailable                          the lesson it belongs to, if any, is live
 *   distractor_matches_answer                   more than one correct choice
 *   accepted_answer_invalid                     an accepted variant that folds to nothing
 *   answer_in_prompt                            a typed answer printed in its own prompt
 *   answer_not_in_evidence                      a cloze whose blank is not in the claims'
 *                                               text or evidence: nothing the learner was
 *                                               taught can fill it
 *   instruction_like / unsourced_link           as for any text
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
  p_sources text[]
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
  correct   text[];
  steps     text[];
  lefts     text[];
  rights    text[];
  evidence  text;
  texts     text[];
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
  if exists (select 1 from unnest(coalesce(p_accepted, '{}')) a where public.study_fold(a) = '') then
    problems := problems || 'accepted_answer_invalid'::text;
  end if;

  if p_kind in ('multiple_choice', 'comparison', 'application') then
    if jsonb_typeof(p_distractors) is distinct from 'array'
       or jsonb_array_length(p_distractors) not between 2 and 4 then
      problems := problems || 'too_few_distractors'::text;
    else
      correct := array[public.study_fold(p_answer)]
                 || array(select public.study_fold(a) from unnest(coalesce(p_accepted, '{}')) a);
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
    elsif public.study_gives_away(p_answer) and public.study_contains_phrase(p_cloze, p_answer) then
      problems := problems || 'answer_in_prompt'::text;
    end if;
    select string_agg(concat_ws(' ', c.statement,
                                (select string_agg(e.span_text, ' ')
                                 from public.study_claim_evidence e where e.claim_id = c.id)), ' ')
      into evidence
    from public.study_claims c
    where c.id = any (coalesce(p_claim_ids, '{}'));
    if not public.study_contains_phrase(evidence, p_answer) then
      problems := problems || 'answer_not_in_evidence'::text;
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

  if p_kind in ('cloze', 'short_recall')
     and public.study_gives_away(p_answer)
     and public.study_contains_phrase(p_prompt, p_answer)
     and not 'answer_in_prompt' = any (problems) then
    problems := problems || 'answer_in_prompt'::text;
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
  return problems || public.study_text_problems(texts, p_sources);
end
$fn$;

/* The text of every source a course was built from, for the link check. */
create function public.study_course_sources(p_generation_id uuid)
returns text[]
language sql
stable
set search_path = ''
as $fn$
  select coalesce(array_agg(v.extracted_text order by s.position), '{}')
  from public.study_generation_sources s
  join public.study_source_versions v on v.id = s.source_version_id
  where s.generation_id = p_generation_id
$fn$;

revoke all on function
  public.study_fold(text),
  public.study_unspaced_class(),
  public.study_contains_phrase(text, text),
  public.study_gives_away(text),
  public.study_text_problems(text[], text[]),
  public.study_claims_problems(uuid[]),
  public.study_claim_problems(uuid, text[]),
  public.study_lesson_problems(text[], uuid[], text[]),
  public.study_item_problems(text, text, text, text[], jsonb, text, text[], jsonb, text, uuid[],
                             uuid, text[]),
  public.study_course_sources(uuid)
from public, anon, authenticated;

/*
 * The worker's `study_validate` step: every draft claim, then lesson, then question of
 * one course becomes validated or quarantined, in that order because each level asks
 * about the one before. Only drafts move, so a retry -- or a second delivery of the
 * step -- changes nothing.
 *
 * Locks as `persist_study_course` does: the course, then its versions NOWAIT, so a
 * source deletion in flight refuses this at once instead of queueing behind it.
 */
create function public.validate_study_course(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  gen      public.study_generations%rowtype;
  sources  text[];
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

  sources := public.study_course_sources(gen.id);
  perform set_config('study.status_reason', 'validation', true);

  for row_id in
    select c.id from public.study_claims c
    where c.generation_id = gen.id and c.status = 'draft' order by c.claim_key
  loop
    problems := public.study_claim_problems(row_id, sources);
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
             array[l.unit_title, l.title, l.objective, l.explanation, l.example, l.recap],
             array(select lc.claim_id from public.study_lesson_claims lc where lc.lesson_id = l.id),
             sources)
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
             i.lesson_id, sources)
      into problems
    from public.study_items i where i.id = row_id;
    update public.study_items
       set status = case when cardinality(problems) = 0 then 'validated' else 'quarantined' end,
           validation_failures = problems
     where id = row_id;
  end loop;

  return jsonb_build_object(
    'generationId', gen.id,
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

revoke all on function public.validate_study_course(uuid) from public, anon, authenticated;
grant execute on function public.validate_study_course(uuid) to service_role;

-- ------------------------------------------------------------------ 5. reports

/*
 * A reader's report that something they were shown is wrong.
 *
 * Kept after it is resolved, and never editable by the reader: it is the audit trail
 * for a suspension, and the record of which version replaced the one reported. Deleted
 * only with the course -- which a source deletion or the account's deletion takes.
 */
create table public.study_reports (
  id                    uuid primary key default extensions.gen_random_uuid(),
  owner_id              uuid not null references auth.users (id) on delete cascade,
  generation_id         uuid not null,
  claim_id              uuid,
  lesson_id             uuid,
  item_id               uuid,
  reason                text not null
                          check (reason in ('incorrect', 'unsupported', 'ambiguous',
                                            'unanswerable', 'other')),
  note                  text check (note is null or char_length(note) between 1 and 1000),
  status                text not null default 'open'
                          check (status in ('open', 'dismissed', 'retired', 'revised')),
  replacement_lesson_id uuid,
  replacement_item_id   uuid,
  created_at            timestamptz not null default now(),
  resolved_at           timestamptz,
  constraint study_reports_one_target check (num_nonnulls(claim_id, lesson_id, item_id) = 1),
  constraint study_reports_resolved_when check ((status = 'open') = (resolved_at is null)),
  constraint study_reports_replacement check (
    (status = 'revised') = (num_nonnulls(replacement_lesson_id, replacement_item_id) = 1)),
  foreign key (generation_id, owner_id)
    references public.study_generations (id, owner_id) on delete cascade,
  foreign key (claim_id, owner_id)
    references public.study_claims (id, owner_id) on delete cascade,
  foreign key (lesson_id, owner_id)
    references public.study_lessons (id, owner_id) on delete cascade,
  foreign key (item_id, owner_id)
    references public.study_items (id, owner_id) on delete cascade,
  foreign key (replacement_lesson_id, owner_id)
    references public.study_lessons (id, owner_id) on delete cascade,
  foreign key (replacement_item_id, owner_id)
    references public.study_items (id, owner_id) on delete cascade
);

create index study_reports_owner_idx on public.study_reports (owner_id, created_at);
create index study_reports_generation_idx on public.study_reports (generation_id, owner_id);
create index study_reports_claim_idx on public.study_reports (claim_id, owner_id);
create index study_reports_lesson_idx on public.study_reports (lesson_id, owner_id);
create index study_reports_item_idx on public.study_reports (item_id, owner_id);
create index study_reports_replacement_lesson_idx
  on public.study_reports (replacement_lesson_id, owner_id);
create index study_reports_replacement_item_idx
  on public.study_reports (replacement_item_id, owner_id);

/*
 * What a claim, lesson or question should be now that something changed around it.
 *
 * Only the two visible states move: `validated` <-> `suspended`. A question is
 * suspended while it is reported or while any claim it rests on is not validated; a
 * lesson likewise; a claim while it is reported. Everything else -- draft, quarantined,
 * rejected, retired -- is final for that version and left alone.
 */
create function public.study_refresh_claim(p_claim_id uuid)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  update public.study_claims c
     set status = case
           when exists (select 1 from public.study_reports r
                        where r.claim_id = c.id and r.status = 'open') then 'suspended'
           else 'validated' end
   where c.id = p_claim_id and c.status in ('validated', 'suspended');
end
$fn$;

create function public.study_refresh_lesson(p_lesson_id uuid)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  update public.study_lessons l
     set status = case
           when exists (select 1 from public.study_reports r
                        where r.lesson_id = l.id and r.status = 'open')
             or exists (select 1 from public.study_lesson_claims lc
                        join public.study_claims c on c.id = lc.claim_id
                        where lc.lesson_id = l.id and c.status <> 'validated') then 'suspended'
           else 'validated' end
   where l.id = p_lesson_id and l.status in ('validated', 'suspended');
end
$fn$;

create function public.study_refresh_item(p_item_id uuid)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  update public.study_items i
     set status = case
           when exists (select 1 from public.study_reports r
                        where r.item_id = i.id and r.status = 'open')
             or exists (select 1 from public.study_item_claims ic
                        join public.study_claims c on c.id = ic.claim_id
                        where ic.item_id = i.id and c.status <> 'validated') then 'suspended'
           else 'validated' end
   where i.id = p_item_id and i.status in ('validated', 'suspended');
end
$fn$;

/* A claim's standing changed: so may every live lesson and question resting on it. */
create function public.study_refresh_claim_dependents(p_claim_id uuid)
returns void
language plpgsql
set search_path = ''
as $fn$
declare
  dependent uuid;
begin
  for dependent in
    select lc.lesson_id from public.study_lesson_claims lc
    join public.study_lessons l on l.id = lc.lesson_id
    where lc.claim_id = p_claim_id and l.status in ('validated', 'suspended')
    order by lc.lesson_id
  loop
    perform public.study_refresh_lesson(dependent);
  end loop;
  for dependent in
    select ic.item_id from public.study_item_claims ic
    join public.study_items i on i.id = ic.item_id
    where ic.claim_id = p_claim_id and i.status in ('validated', 'suspended')
    order by ic.item_id
  loop
    perform public.study_refresh_item(dependent);
  end loop;
end
$fn$;

revoke all on function
  public.study_refresh_claim(uuid), public.study_refresh_lesson(uuid),
  public.study_refresh_item(uuid), public.study_refresh_claim_dependents(uuid)
from public, anon, authenticated;

/*
 * Every correction starts the same way: the reader is signed in and owns the thing,
 * one correction at a time per reader, then the course and its versions are locked in
 * the order `persist_study_course` takes them -- course, then versions NOWAIT -- so a
 * correction can neither deadlock with a source deletion nor with account deletion.
 * Returns the course the target belongs to.
 */
create function public.study_lock_for_correction(p_kind text, p_id uuid)
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
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended('what-a-pull:study-correction:' || uid::text, 0));

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
  perform 1
  from public.study_source_versions v
  join public.study_generation_sources s on s.source_version_id = v.id
  where s.generation_id = gen_id
  for key share of v nowait;
  return gen_id;
end
$fn$;

revoke all on function public.study_lock_for_correction(text, uuid)
  from public, anon, authenticated;

/*
 * Report a claim, lesson or question as wrong. It is suspended at once -- and a claim
 * takes every lesson and question resting on it with it -- so it stops being shown and
 * stops counting as recall before anyone has decided whether the report is right.
 *
 * Only what a learner can see can be reported: validated, or already suspended by
 * another report. Fifty a day per reader, which no honest reader will meet.
 */
create function public.report_study_content(
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
  gen_id := public.study_lock_for_correction(p_kind, p_id);

  if p_reason is null or p_reason not in
     ('incorrect', 'unsupported', 'ambiguous', 'unanswerable', 'other') then
    raise exception 'unknown report reason' using errcode = '22023';
  end if;
  if char_length(v_note) > 1000 then
    raise exception 'a report note is at most 1000 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.study_reports r
      where r.owner_id = uid
        and r.created_at >= date_trunc('day', (now() at time zone 'utc')) at time zone 'utc')
     >= 50 then
    raise exception 'daily report limit reached' using errcode = '54000';
  end if;

  if p_kind = 'claim' then
    select c.status into st from public.study_claims c where c.id = p_id for update;
  elsif p_kind = 'lesson' then
    select l.status into st from public.study_lessons l where l.id = p_id for update;
  else
    select i.status into st from public.study_items i where i.id = p_id for update;
  end if;
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
 * The report was mistaken. The target is shown again unless something else still holds
 * it -- another open report, or a claim under it that is not validated.
 */
create function public.dismiss_study_report(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  uid uuid := auth.uid();
  r   public.study_reports%rowtype;
begin
  if uid is null then
    raise exception 'correcting a course requires a signed-in reader' using errcode = '28000';
  end if;
  select * into r from public.study_reports where id = p_report_id and owner_id = uid;
  if not found then
    raise exception 'no such report' using errcode = 'P0002';
  end if;
  perform public.study_lock_for_correction(
    case when r.claim_id is not null then 'claim'
         when r.lesson_id is not null then 'lesson' else 'item' end,
    coalesce(r.claim_id, r.lesson_id, r.item_id));

  update public.study_reports
     set status = 'dismissed', resolved_at = now()
   where id = p_report_id and status = 'open';
  if not found then
    raise exception 'that report is already resolved' using errcode = '55000';
  end if;

  perform set_config('study.status_reason', 'report_dismissed', true);
  if r.claim_id is not null then
    perform public.study_refresh_claim(r.claim_id);
    perform public.study_refresh_claim_dependents(r.claim_id);
  elsif r.lesson_id is not null then
    perform public.study_refresh_lesson(r.lesson_id);
  else
    perform public.study_refresh_item(r.item_id);
  end if;
end
$fn$;

/*
 * Withdraw a claim, lesson or question for good. Its open reports are resolved as
 * `retired`. A retired claim leaves everything resting on it suspended until each is
 * revised onto other claims or retired too; a retired lesson's live questions stay, as
 * course-level review with no lesson.
 */
create function public.retire_study_content(p_kind text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  st text;
begin
  perform public.study_lock_for_correction(p_kind, p_id);

  if p_kind = 'claim' then
    select c.status into st from public.study_claims c where c.id = p_id for update;
  elsif p_kind = 'lesson' then
    select l.status into st from public.study_lessons l where l.id = p_id for update;
  else
    select i.status into st from public.study_items i where i.id = p_id for update;
  end if;
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

/* The claims a revision may rest on: this course's, as uuids, or null for "unchanged". */
create function public.study_revision_claims(p_revision jsonb, p_generation_id uuid)
returns uuid[]
language plpgsql
stable
set search_path = ''
as $fn$
declare
  ids uuid[];
begin
  if not p_revision ? 'claimIds' then
    return null;
  end if;
  if jsonb_typeof(p_revision -> 'claimIds') <> 'array'
     or jsonb_array_length(p_revision -> 'claimIds') not between 1 and 6
     or exists (select 1 from jsonb_array_elements(p_revision -> 'claimIds') e
                where jsonb_typeof(e) <> 'string'
                   or e #>> '{}' !~ '^[0-9a-fA-F-]{36}$') then
    raise exception 'claimIds must be one to six claim ids' using errcode = '22023';
  end if;
  ids := array(select distinct (e #>> '{}')::uuid
               from jsonb_array_elements(p_revision -> 'claimIds') e);
  if exists (select 1 from unnest(ids) as cited(id)
             where not exists (select 1 from public.study_claims c
                               where c.id = cited.id and c.generation_id = p_generation_id)) then
    raise exception 'a revision can only cite claims of its own course' using errcode = '22023';
  end if;
  return ids;
end
$fn$;

/* A string field of a revision, or the old value when it is not given. */
create function public.study_revision_text(p_revision jsonb, p_key text, p_old text)
returns text
language plpgsql
stable
set search_path = ''
as $fn$
begin
  if not p_revision ? p_key then
    return p_old;
  end if;
  if jsonb_typeof(p_revision -> p_key) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_revision -> p_key) <> 'string' then
    raise exception '% must be a string', p_key using errcode = '22023';
  end if;
  return p_revision ->> p_key;
end
$fn$;

/* A string-array field of a revision, or the old value when it is not given. */
create function public.study_revision_texts(p_revision jsonb, p_key text, p_old text[])
returns text[]
language plpgsql
stable
set search_path = ''
as $fn$
begin
  if not p_revision ? p_key then
    return p_old;
  end if;
  if jsonb_typeof(p_revision -> p_key) <> 'array'
     or exists (select 1 from jsonb_array_elements(p_revision -> p_key) e
                where jsonb_typeof(e) <> 'string') then
    raise exception '% must be an array of strings', p_key using errcode = '22023';
  end if;
  return array(select jsonb_array_elements_text(p_revision -> p_key));
end
$fn$;

/* An array-of-objects field of a revision, keeping only the named string fields. */
create function public.study_revision_objects(
  p_revision jsonb, p_key text, p_fields text[], p_old jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  e jsonb;
  f text;
  out jsonb := '[]'::jsonb;
  kept jsonb;
begin
  if not p_revision ? p_key then
    return p_old;
  end if;
  if jsonb_typeof(p_revision -> p_key) <> 'array' then
    raise exception '% must be an array', p_key using errcode = '22023';
  end if;
  for e in select value from jsonb_array_elements(p_revision -> p_key) loop
    if jsonb_typeof(e) <> 'object' then
      raise exception '% must be an array of objects', p_key using errcode = '22023';
    end if;
    kept := '{}'::jsonb;
    foreach f in array p_fields loop
      if jsonb_typeof(e -> f) is distinct from 'string' then
        raise exception 'each of % needs a string %', p_key, f using errcode = '22023';
      end if;
      kept := kept || jsonb_build_object(f, e ->> f);
    end loop;
    out := out || jsonb_build_array(kept);
  end loop;
  return out;
end
$fn$;

/* One hundred corrections a day, and fifty versions of one thing. */
create function public.study_check_revision_quota(p_version smallint)
returns void
language plpgsql
set search_path = ''
as $fn$
declare
  uid uuid := auth.uid();
  day timestamptz := date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';
begin
  if p_version >= 50 then
    raise exception 'this has been revised fifty times; retire it instead' using errcode = '54000';
  end if;
  if (select count(*) from public.study_items i
      where i.owner_id = uid and i.authored_by = 'reader' and i.created_at >= day)
   + (select count(*) from public.study_lessons l
      where l.owner_id = uid and l.authored_by = 'reader' and l.created_at >= day) >= 100 then
    raise exception 'daily revision limit reached' using errcode = '54000';
  end if;
end
$fn$;

revoke all on function
  public.study_revision_claims(jsonb, uuid),
  public.study_revision_text(jsonb, text, text),
  public.study_revision_texts(jsonb, text, text[]),
  public.study_revision_objects(jsonb, text, text[], jsonb),
  public.study_check_revision_quota(smallint)
from public, anon, authenticated;

/*
 * Correct a question: a new version with the reader's changes, in place of the one
 * given, which is retired. The new version must pass every check a generated question
 * does -- a revision that does not is refused with the reasons, and nothing changes --
 * and it is the reader's, not the model's, so it carries no model provenance.
 *
 * Given fields replace the old ones; absent fields are kept. The kind, purpose,
 * difficulty and lesson are kept: a different kind of question is a different
 * question. Open reports on the old version are resolved as `revised`, naming the new.
 *
 * Revision keys: prompt, answer, acceptedAnswers, distractors [{text, why}], cloze,
 * sequence, pairs [{left, right}], explanation, claimIds.
 */
create function public.revise_study_item(p_item_id uuid, p_revision jsonb)
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
  v_gen := public.study_lock_for_correction('item', p_item_id);
  if jsonb_typeof(p_revision) is distinct from 'object' then
    raise exception 'a revision is an object' using errcode = '22023';
  end if;
  select k into v_unknown from jsonb_object_keys(p_revision) k
  where k not in ('prompt', 'answer', 'acceptedAnswers', 'distractors', 'cloze', 'sequence',
                  'pairs', 'explanation', 'claimIds')
  limit 1;
  if v_unknown is not null then
    raise exception 'a question revision has no field %', v_unknown using errcode = '22023';
  end if;

  select * into v_prev from public.study_items where id = p_item_id for update;
  if v_prev.status not in ('validated', 'suspended') then
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
    v_explain, v_claims, v_prev.lesson_id, public.study_course_sources(v_gen));
  if cardinality(v_problems) > 0 then
    raise exception 'this revision does not pass validation: %',
      array_to_string(v_problems, ', ') using errcode = '22023';
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

/*
 * Correct a lesson, the same way: a new version, the old one retired, the same checks.
 * Its live questions move to the new version -- they are about the same material, and
 * a question's own identity (and the answers recorded against it) is unchanged by the
 * lesson it is shown under.
 *
 * Revision keys: title, objective, explanation, example, recap, claimIds.
 */
create function public.revise_study_lesson(p_lesson_id uuid, p_revision jsonb)
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
  v_gen := public.study_lock_for_correction('lesson', p_lesson_id);
  if jsonb_typeof(p_revision) is distinct from 'object' then
    raise exception 'a revision is an object' using errcode = '22023';
  end if;
  select k into v_unknown from jsonb_object_keys(p_revision) k
  where k not in ('title', 'objective', 'explanation', 'example', 'recap', 'claimIds')
  limit 1;
  if v_unknown is not null then
    raise exception 'a lesson revision has no field %', v_unknown using errcode = '22023';
  end if;

  select * into v_prev from public.study_lessons where id = p_lesson_id for update;
  if v_prev.status not in ('validated', 'suspended') then
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
    array[v_prev.unit_title, v_title, v_objective, v_explain, v_example, v_recap], v_claims,
    public.study_course_sources(v_gen));
  if cardinality(v_problems) > 0 then
    raise exception 'this revision does not pass validation: %',
      array_to_string(v_problems, ', ') using errcode = '22023';
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

revoke all on function
  public.report_study_content(text, uuid, text, text),
  public.dismiss_study_report(uuid),
  public.retire_study_content(text, uuid),
  public.revise_study_item(uuid, jsonb),
  public.revise_study_lesson(uuid, jsonb)
from public, anon;
grant execute on function
  public.report_study_content(text, uuid, text, text),
  public.dismiss_study_report(uuid),
  public.retire_study_content(text, uuid),
  public.revise_study_item(uuid, jsonb),
  public.revise_study_lesson(uuid, jsonb)
to authenticated;

-- ----------------------------------------------------- 6. answers and recall proof

/*
 * One row per answer to a generated question -- the version answered, not its lineage.
 *
 * NO READER WRITE PATH. `recall_events` accepts rows straight from the browser, grade
 * and all, which is how the public feed has always worked; it is exactly what
 * generated material must not do, because this table is what "you know this" will be
 * decided from. The server-side recorder that grades an answer and writes here is the
 * practice change's; until then nothing but the database owner can insert.
 *
 * Append-only: no update, by grant or by trigger. Deleted only with the question --
 * which a source deletion or the account's deletion takes.
 */
create table public.study_answer_events (
  id              uuid primary key default extensions.gen_random_uuid(),
  owner_id        uuid not null,
  item_id         uuid not null,
  client_event_id uuid not null,
  answered_at     timestamptz not null default clock_timestamp(),
  correct         boolean not null,
  hinted          boolean not null,
  grading         text not null check (grading in ('deterministic', 'self')),
  response        text check (response is null or char_length(response) <= 1000),
  unique (owner_id, client_event_id),
  foreign key (item_id, owner_id)
    references public.study_items (id, owner_id) on delete cascade
);

create index study_answer_events_item_idx on public.study_answer_events (item_id, owner_id);

create function public.study_answer_events_are_final()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'a recorded answer cannot be changed' using errcode = '55000';
end
$fn$;

revoke all on function public.study_answer_events_are_final() from public, anon, authenticated;

create trigger study_answer_events_are_final before update on public.study_answer_events
  for each row execute function public.study_answer_events_are_final();

/* What a question was at an instant: the last status it was logged in at or before it. */
create function public.study_item_status_at(p_item_id uuid, p_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $fn$
  select l.to_status
  from public.study_status_log l
  where l.item_id = p_item_id and l.at <= p_at
  order by l.at desc, l.id desc
  limit 1
$fn$;

/*
 * THE PROOF RULE: whether one answer may count as recall of the claims its question
 * rests on. All of:
 *
 *   * correct, unhinted, and graded deterministically -- a self-graded answer is
 *     practice, and a hinted one is recognition, and neither is proof;
 *   * the question was validated at the instant it was answered -- not a draft, not
 *     quarantined, not suspended by a report;
 *   * it is validated now -- a retired version (superseded by a correction) or a
 *     suspended one (reported since) proves nothing, and an answer to one version never
 *     counts for another, since it names the version it answered;
 *   * every claim it rests on is validated now.
 *
 * Every recall proof of generated material is to be decided here and nowhere else.
 */
create function public.study_answer_proves_recall(p_event public.study_answer_events)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select p_event.correct
     and not p_event.hinted
     and p_event.grading = 'deterministic'
     and public.study_item_status_at(p_event.item_id, p_event.answered_at) = 'validated'
     and exists (select 1 from public.study_items i
                 where i.id = p_event.item_id and i.status = 'validated')
     and not exists (select 1 from public.study_item_claims ic
                     join public.study_claims c on c.id = ic.claim_id
                     where ic.item_id = p_event.item_id and c.status <> 'validated')
$fn$;

/*
 * The claims a reader has proven recall of, and when last. Invoker's rights, so a
 * reader sees their own and nothing else; the practice and scheduling changes build on
 * this rather than on their own reading of the table.
 */
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
  where public.study_answer_proves_recall(e)
  group by ic.claim_id
$fn$;

revoke all on function
  public.study_item_status_at(uuid, timestamptz),
  public.study_answer_proves_recall(public.study_answer_events),
  public.study_proven_claims()
from public, anon;
grant execute on function
  public.study_item_status_at(uuid, timestamptz),
  public.study_answer_proves_recall(public.study_answer_events),
  public.study_proven_claims()
to authenticated, service_role;

-- ------------------------------------------------------------------- privacy

alter table public.study_status_log enable row level security;
create policy study_status_log_read_own on public.study_status_log
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_reports enable row level security;
create policy study_reports_read_own on public.study_reports
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.study_answer_events enable row level security;
create policy study_answer_events_read_own on public.study_answer_events
  for select to authenticated using (owner_id = (select auth.uid()));

revoke all on public.study_status_log, public.study_reports, public.study_answer_events
  from public, anon, authenticated;
grant select on public.study_status_log, public.study_reports, public.study_answer_events
  to authenticated;
