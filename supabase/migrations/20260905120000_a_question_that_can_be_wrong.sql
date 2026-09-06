-- A question that can be wrong.
--
-- Every question this product asks today is free recall: the screen shows a prompt, the
-- reader thinks, the reader says how it went. That is a real mechanic and it stays -- but
-- it cannot be WRONG. A reader who is confidently mistaken grades themselves `good` and
-- the scheduler agrees with them, which is the one failure spaced repetition exists to
-- catch and the one this schema could not represent.
--
-- `lib/activities.ts` (3c, merged) already grades three kinds deterministically -- MCQ,
-- cloze and ordering -- and says so at the top of the file: it declares the shape "because
-- it is the shape the graders need; the migration that stores it mirrors this, not the
-- other way round." This is that migration. The set below is `QUESTION_KINDS` verbatim.
--
-- FOUR THINGS CHANGE and each is small on its own:
--
--   1. `quiz_questions.kind` gets a check. It has been plain `text not null default
--      'recall'` since 20260829124507, so the intended set has been documented in
--      TypeScript and unenforced in Postgres, and `activities.ts` says so in as many
--      words. That comment stops being true with this file, and it is corrected in the
--      same diff.
--   2. Both question tables gain `explanation` and `cloze`, and `quiz_questions` gains
--      `rationale` -- the per-distractor account of why a particular wrong answer is
--      wrong. `whyWrong` in `activities.ts` reads exactly this shape.
--   3. Everything reader-writable or model-written gets a SIZE bound, including the two
--      columns that already existed without one. See "bounds" below -- this is the same
--      hole 20260905110000 had to close on `user_questions.options` after review measured
--      a 3.77 MB row through the ordinary API.
--   4. `get_due_reviews` returns `questions` -- an array, the reader's own first -- plus
--      the pull's `example` and `explanation`, the scheduler's `difficulty` and `lapses`,
--      and the summary's `version` as `contentVersion`. The top level stays an ARRAY,
--      which `scripts/smoke-read-path.sql:65` asserts with `jsonb_array_length(due)`.
--
-- WHAT THIS FILE DOES NOT DO. It writes no questions: the round-one corpus gets MCQ and
-- cloze in 3b, and generation learns to produce several kinds in 3g. So after this
-- migration every `questions` array holds at most the one `recall` row the seed already
-- wrote, and `kind` is checked rather than varied. That is the intended order -- the
-- column has to exist and be bounded before anything fills it.
--
-- Law 2 is untouched: nothing here calls a model. Law 5: no new table, and the two tables
-- altered keep the policies they have.

-- --------------------------------------------------------------- quiz_questions
--
-- Canonical questions. Written only by the pipeline (`insertQuizQuestions`), and readable
-- by anyone who can read the pull -- `quiz_questions_read` from 20260829124730 asks
-- exactly that. There is no insert, update or delete policy, so none of the bounds below
-- are defending against a reader; they are defending against a MODEL, which is the other
-- source of unbounded text in this schema and the one that costs money by the token.
alter table public.quiz_questions
  add column explanation text,
  add column cloze       text,
  add column rationale   jsonb not null default '[]'::jsonb;

comment on column public.quiz_questions.explanation is
  'Why the answer is the answer. Shown after grading, whatever the reader picked.';
comment on column public.quiz_questions.cloze is
  'The sentence with a blank in it. Null for every kind but cloze.';
comment on column public.quiz_questions.rationale is
  'Array of {distractor, why}: why each wrong option is wrong. Gemini has no map type, so it is an array rather than an object.';

-- ------------------------------------------------------------------------ bounds
--
-- Every one of these is a number this schema already uses somewhere: 2,000 for a prompt or
-- an answer (`user_questions_prompt_length`), 20,000 for a body of prose (`notes.body`,
-- `highlights.text`, `recall_events.answer`), and a small integer for how many of a thing
-- a screen will render.
--
-- `distractors` HAS NEVER HAD ONE, and it is the older half of this. It has been `jsonb
-- not null default '[]'` with no shape check and no size check since 20260829124507 --
-- so a `cards` step that came back with a malformed or enormous array stored it, and the
-- failure surfaced later, in a renderer, on a row somebody had already paid to generate.
-- Checking it here is not defensive tidiness: `gradeMcq` in `activities.ts` indexes into
-- this array, and `mcqOptions` shuffles it, so a non-array is a client crash on a screen
-- the reader cannot get past.
--
-- The MCQ rule is the one with real content. An MCQ with fewer than two wrong options is
-- not a multiple-choice question -- with one distractor it is a coin flip, and with none
-- the answer is the only thing on screen. Two is the floor at which picking wrong is
-- possible, which is the whole point of the kind. It is expressed as a table check rather
-- than left to the generator because the generator is a model.
alter table public.quiz_questions
  add constraint quiz_questions_kind_known
    check (kind in ('recall', 'mcq', 'cloze', 'short_answer', 'ordering', 'scenario')),
  add constraint quiz_questions_prompt_length
    check (length(prompt) between 1 and 2000),
  add constraint quiz_questions_answer_length
    check (length(answer) between 1 and 2000),
  add constraint quiz_questions_explanation_length
    check (explanation is null or length(explanation) <= 2000),
  add constraint quiz_questions_cloze_length
    check (cloze is null or length(cloze) <= 1000),
  add constraint quiz_questions_distractors_shape
    check (
      jsonb_typeof(distractors) = 'array'
      and jsonb_array_length(distractors) <= 8
      and length(distractors::text) <= 20000
    ),
  add constraint quiz_questions_rationale_shape
    check (
      jsonb_typeof(rationale) = 'array'
      and jsonb_array_length(rationale) <= 8
      and length(rationale::text) <= 20000
    ),
  -- Two distractors is the floor at which an MCQ can be got wrong. Below it the kind is a
  -- lie about what the screen is asking.
  add constraint quiz_questions_mcq_has_distractors
    check (kind <> 'mcq' or jsonb_array_length(distractors) >= 2),
  -- And a cloze needs its blank. Without one `gradeCloze` has nothing to render and the
  -- reader is shown a prompt with no gap to fill.
  -- `!~ '^\s*$'` for the reason given on the reader's answer bound below: one-argument
  -- `btrim` strips spaces only, so a cloze of a single newline passed as "has its blank".
  add constraint quiz_questions_cloze_has_text
    check (kind <> 'cloze' or (cloze is not null and cloze !~ '^\s*$'));

-- ------------------------------------------------------------- user_questions
--
-- The reader's own. Two columns, not three: `rationale` is an account of why each
-- generated distractor is wrong, and a reader writing a question for themselves has no
-- distractors to account for -- `user_questions` carries `options`, which is the whole
-- list rather than the wrong ones. Adding a column no writer fills would be a column the
-- next reader of this schema has to work out the emptiness of.
--
-- `options` MEANS THE WRONG ONES, and this is the file that says so. 20260905110000 added
-- the column with a size bound and no definition, and nothing writes it yet --
-- `remember_pull` takes a prompt, an answer and a kind. So the meaning was still open,
-- and `get_due_reviews` is what closes it: it surfaces `options` under the canonical name
-- `distractors`, so one renderer serves both tables, and `mcqOptions` in `activities.ts`
-- builds what the reader sees from `answer` plus that list. Read the other way -- as every
-- choice including the right one -- the same renderer would show the answer twice.
--
-- No `mcq needs two options` rule on this table to match the canonical one, deliberately:
-- `remember_pull` has no way to write `options` at all, so the constraint would forbid a
-- kind that the only writer cannot satisfy. It belongs with 2d/2e, which is where the
-- screen that writes choices lands, and where a reader can actually meet it.
--
-- THE KIND SET STAYS AT FOUR here, and that is deliberate rather than an oversight of the
-- six above. `ordering` and `scenario` are generated forms: an ordering question needs its
-- steps in a canonical sequence and a scenario needs a situation composed around the idea,
-- and neither is something the "Remember this" box -- a prompt and an answer -- can
-- express. A reader who wants either can write a `short_answer`.
alter table public.user_questions
  add column explanation text,
  add column cloze       text;

comment on column public.user_questions.explanation is
  'The reader''s own note on why their answer is the answer. Shown after grading.';
comment on column public.user_questions.cloze is
  'The sentence with a blank in it, when the reader wrote a cloze.';

alter table public.user_questions
  /*
   * A DETERMINISTICALLY GRADED KIND NEEDS AN ANSWER, and `answer` is nullable.
   *
   * Review finding. `remember_pull(p_pull_id, p_prompt, p_answer default null, p_kind
   * default 'recall', ...)` takes the answer as optional, and nothing refused
   * `remember_pull(pull, 'An mcq?', null, 'mcq', id)` -- measured, accepted. That row
   * is then returned in the same shape as a canonical question, and `mcqOptions` in
   * `activities.ts` calls `answer.trim()` on it: a valid row the reader wrote, which
   * throws in the renderer rather than displaying.
   *
   * `recall` and `short_answer` are self-graded -- the reader reveals and marks
   * themselves, so a question with no stored answer is a perfectly good prompt. `mcq`
   * and `cloze` are graded by comparison against the answer, so for those it is not
   * optional at all. `quiz_questions.answer` has been `not null` since
   * 20260829124507 for the same reason.
   */
  /*
   * `!~ '^\s*$'` rather than `length(btrim(answer)) > 0`. One-argument `btrim` strips
   * SPACES ONLY, so an answer of a single tab or newline satisfied "non-blank" and the
   * reader got an option-less question rather than a graded one. `\s` covers space,
   * tab, newline, carriage return, form feed and vertical tab.
   */
  add constraint user_questions_graded_kinds_need_an_answer
    check (
      kind in ('recall', 'short_answer')
      or (answer is not null and answer !~ '^\s*$')
    ),
  add constraint user_questions_explanation_length
    check (explanation is null or length(explanation) <= 2000),
  add constraint user_questions_cloze_length
    check (cloze is null or length(cloze) <= 1000);

/*
 * AND NO "a reader's cloze needs its blank" RULE, for exactly the reason this file gives
 * for declining the matching MCQ rule -- which it gave, and then contradicted two
 * constraints later.
 *
 * `remember_pull` writes `(user_id, pull_id, kind, prompt, answer, client_mutation_id)`
 * and has no way to write `cloze`. `user_questions_kind_known` has permitted `cloze`
 * since 20260905110000, so `remember_pull(pull, 'The obstacle is the ___', 'way',
 * 'cloze', id)` succeeded before this migration; with a `cloze is not null` rule it
 * raises 23514 and PostgREST answers 400, for every input, permanently -- a granted RPC
 * made unusable for one of the four kinds it accepts.
 *
 * The `quiz_questions` twin stays, because there the rule is satisfiable: the pipeline
 * writes `cloze` in the same insert as `kind`.
 *
 * So this waits for 2d/2e, alongside a writer that can satisfy it. Review caught it and
 * the suite did not, because the suite asserts the refusal through a direct
 * `insert into public.user_questions`, which can supply the column, and never through
 * `remember_pull`, which cannot. There is now a test for the call that was broken.
 */

-- --------------------------------------------------------------- get_due_reviews
--
-- Restated, same signature, so `create or replace` is enough and every caller keeps
-- working: the client calls it by name and `scripts/smoke-read-path.sql` calls it with
-- `p_limit := 5` by named argument.
--
-- `questions` IS THE ARRAY, and the three singular fields are derived from its first
-- element rather than computed beside it. That ordering is the whole lesson of the version
-- this replaces: 20260905110000 had `question`, `questionId` and `questionSource` computed
-- separately until a review mutant made them describe different questions, and the fix was
-- to make one decision and read all three off it. The same reasoning applies one level up
-- -- an array and a scalar computed independently can disagree in exactly the same way --
-- so `chosen` is now `questions -> 0` and nothing else.
--
-- The three stay for one release. `lib/types.ts` `DueReview` declares `question` and the
-- deployed Review screen reads it; 3d is the PR that renders `questions` by kind and drops
-- them, and 12a is where they leave this function. Removing them here would break the
-- screen between this merge and that one, and `main` deploys on every merge.
--
-- `p_limit` IS BOUNDED, which it was not. It is passed straight to `limit`, so
-- `get_due_reviews(2000000000)` asked Postgres for every due row a reader has and built
-- one JSON document out of it -- under an 8 s `statement_timeout`, on a function any
-- signed-in caller can invoke through PostgREST. 100 is five times the default page and
-- more than any screen renders; the floor of 1 turns a zero or a negative into the
-- smallest useful answer rather than an empty array that looks like "nothing is due".
create or replace function public.get_due_reviews(p_limit int default 20)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  lim   int  := greatest(1, least(100, coalesce(p_limit, 20)));
  res   jsonb;
begin
  if uid is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(t order by t ->> 'retrievability'), '[]'::jsonb) into res
  from (
    select jsonb_build_object(
      'pullId', due.pull_id,
      'headline', due.headline,
      'body', due.body,
      -- The three the card already had, plus the two it did not. `example` and
      -- `explanation` are the pull's own -- a worked instance and the reasoning behind
      -- the idea -- and Review has been re-deriving neither and showing the body alone.
      'whyItMatters', due.why_it_matters,
      'example', due.example,
      'explanation', due.explanation,
      'workTitle', due.work_title,
      'workSlug', due.work_slug,
      -- Which revision of the summary the reader was asked about. A pull's body can be
      -- rewritten by a later generation, and a grade against the old wording is evidence
      -- about the old wording; without this nothing downstream can tell.
      'contentVersion', due.content_version,
      'retrievability', round(public.retrievability(due.stability, due.last_seen_at)::numeric, 3),
      'stability', round(due.stability::numeric, 2),
      -- Both off `knowledge_states`, both already stored, neither previously returned.
      -- `lapses` is how many times this idea has been forgotten, which is what makes a
      -- "you keep losing this one" line possible without a second query per card.
      'difficulty', round(due.difficulty::numeric, 2),
      'lapses', due.lapses,
      'reps', due.reps,
      'dueAt', due.next_due_at,
      'questions', asked.questions,
      -- Derived from the array, never computed beside it. See the header.
      'question', asked.questions -> 0 ->> 'prompt',
      'questionId', (asked.questions -> 0 ->> 'id')::uuid,
      'questionSource', asked.questions -> 0 ->> 'source'
    ) as t
    -- THE DUE SET IS CHOSEN AND TRIMMED FIRST, and the joins that decide whether a
    -- card is VISIBLE are part of choosing it.
    --
    -- Both halves matter and the first version had only one. Selecting from
    -- `knowledge_states` alone and joining `pulls`/`summaries`/`works` outside the
    -- limit puts three RLS-filtered inner joins after the row has already taken a
    -- slot -- so a due row whose pull the reader can no longer see (a summary
    -- retired, an import undone, a work withdrawn) consumes one of the `lim` and is
    -- then dropped. Measured: a reader with 30 readable cards due and 30 unreadable
    -- ones sorting ahead of them got 0 back from `get_due_reviews(20)`. Review would
    -- have told them nothing was due while thirty ideas waited.
    --
    -- The questions lateral joins THIS SET rather than the outer query, so it is
    -- evaluated at most `lim` times.
    --
    -- AS AN OUTER LIMIT IT WOULD NOT BE, and that is the shape this replaces: the
    -- lateral becomes an inner-row expression, evaluated for every due idea the reader
    -- has and only then sorted and cut to a hundred, each evaluation two index lookups
    -- and two aggregations building a document that is then thrown away. Measured, one
    -- canonical question per pull, `get_due_reviews(100)`: 588.9 ms that way against
    -- 47.6 ms this way at 5,000 due ideas, and 1,898.8 ms against 127.3 ms at 20,000 --
    -- exactly the import ceiling `commit_import` allows, so it is a backlog a reader can
    -- have.
    --
    -- Written as a counterfactual because an earlier revision of this paragraph put it
    -- in the present tense, which read as a description of the code below it and so
    -- credited the speedup to the arrangement it condemns.
    --
    -- The same shape as the sequential scan 20260905110000 had to fix in
    -- `commit_import`: correct, and linear in the one direction the product grows.
    from (
      select ks.stability, ks.difficulty, ks.reps, ks.lapses, ks.last_seen_at,
             ks.next_due_at,
             p.id as pull_id, p.headline, p.body, p.why_it_matters, p.example,
             p.explanation,
             w.title as work_title, w.slug as work_slug,
             s.version as content_version
        from public.knowledge_states ks
        join public.pulls p on p.id = ks.pull_id
        join public.summaries s on s.id = p.summary_id
        join public.works w on w.id = s.work_id
       where ks.user_id = uid and ks.next_due_at <= now()
       order by public.retrievability(ks.stability, ks.last_seen_at) asc
       limit lim
    ) due
    -- The reader's own first, then the canonical ones. `union all` rather than two
    -- lateral joins and a coalesce: the screen asks one question at a time and takes
    -- the first, so "whose question wins" is expressed once, as an ORDER BY, instead
    -- of as a precedence rule three fields have to agree about.
    --
    -- BOUNDED ON EACH BRANCH, not by trimming the finished array. Review finding, and
    -- the branch that needed it is the reader's: `user_questions_insert_own` lets a
    -- signed-in caller write as many questions about one pull as they like, and
    -- aggregating them all into one JSON document before keeping three made `p_limit`
    -- no bound on the work at all -- `get_due_reviews(1)` would build every one of
    -- them. `jsonb_build_object` is in the target list, so it is evaluated before the
    -- sort; only a limit on each branch stops the payloads being built. Measured with
    -- 5,000 of a reader's own questions on one due pull: 129.72 ms trimming the
    -- finished array, 24.26 ms bounding each branch, against 6.56 and 5.50 ms at five
    -- questions. The first grows with what the reader chooses to write.
    --
    -- Three per branch and three overall is the same answer as three overall alone,
    -- because a reader's own question always outranks a canonical one: whatever the
    -- overall top three are, each is within its own branch's top three.
    --
    -- `id` is the last term, which makes the ordering TOTAL. A pull's canonical
    -- questions are written by one statement and share `created_at` to the
    -- microsecond, so without it the order among them is unspecified. Said as a
    -- hazard rather than an observed one: removing it changes nothing this suite can
    -- see, because within one session Postgres returns tied rows consistently. It is
    -- here because unspecified is not the same as stable.
    --
    -- Positional ORDER BY because the branches of a UNION have no shared column names.
    left join lateral (
      select coalesce(jsonb_agg(q.j order by q.own desc, q.written_at desc, q.qid),
                      '[]'::jsonb) as questions
        from (
          (
            select 0 as own, uq.created_at as written_at, uq.id as qid,
                   jsonb_build_object(
                     'id', uq.id,
                     'source', 'user',
                     'kind', uq.kind,
                     'prompt', uq.prompt,
                     'answer', uq.answer,
                     -- SURFACED AS `distractors`, WHICH IS THE POINT OF THE KEY.
                     --
                     -- `user_questions.options` and `quiz_questions.distractors` are
                     -- the same list named for the side that writes it: the wrong
                     -- choices, not including the answer. `mcqOptions` in
                     -- `activities.ts` builds the rendered options from `answer` PLUS
                     -- `distractors`, so a screen reading this array must not have to
                     -- know which table a question came from -- and returning `'[]'`
                     -- here, as the first draft of this function did, silently dropped
                     -- every choice a reader had written and turned their own MCQ into
                     -- a one-option question.
                     'distractors', uq.options,
                     'cloze', uq.cloze,
                     'explanation', uq.explanation,
                     'rationale', '[]'::jsonb
                   ) as j
              from public.user_questions uq
             where uq.user_id = uid and uq.pull_id = due.pull_id
               and uq.retired_at is null
             order by uq.created_at desc, uq.id
             limit 3
          )
          union all
          (
            select -1, qq.created_at, qq.id,
                   jsonb_build_object(
                     'id', qq.id,
                     'source', 'canonical',
                     'kind', qq.kind,
                     'prompt', qq.prompt,
                     'answer', qq.answer,
                     'distractors', qq.distractors,
                     'cloze', qq.cloze,
                     'explanation', qq.explanation,
                     'rationale', qq.rationale
                   )
              from public.quiz_questions qq
             where qq.pull_id = due.pull_id
             order by qq.created_at desc, qq.id
             limit 3
          )
          order by 1 desc, 2 desc, 3
          limit 3
        ) q
    ) asked on true
  ) x;

  return res;
end;
$$;

comment on function public.get_due_reviews is
  'The reader''s due ideas, each with up to three questions -- their own first, then the canonical ones -- and the pull''s own example and explanation.';
