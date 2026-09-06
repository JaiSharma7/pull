-- And the question the product asks.
--
-- The second half of `20260905120000`, and a separate file for one reason: a transaction
-- holding ACCESS EXCLUSIVE on BOTH question tables deadlocks with something whichever
-- order it takes them in. Readers take `user_questions` first; referential cascades from
-- `pulls` take `quiz_questions` first, because that foreign key is older and its trigger
-- name sorts earlier. There is no safe order, so the answer is to hold one lock at a
-- time. The full account is in the sibling file.
--
-- A migration file is one transaction and a migration run is not -- two probe files, the
-- first committing while the second failed, settled that -- so splitting is what actually
-- separates the locks rather than merely describing them apart.
--
-- WHAT IS HERE. `quiz_questions` gains `explanation`, `cloze` and `rationale`, a `kind`
-- check over the six values `QUESTION_KINDS` declares, and the size bounds that table has
-- never carried. Then `get_due_reviews` is re-stated to return `questions` -- an array,
-- the reader's own first -- plus the pull's `example` and `explanation`, the scheduler's
-- `difficulty` and `lapses`, and the summary's `version` as `contentVersion`. It reads
-- columns BOTH files add, which is why it is in the later one; file order is timestamp
-- order, so the sibling has already run.
--
-- The top level stays an ARRAY, which `scripts/smoke-read-path.sql:65` asserts with
-- `jsonb_array_length(due)`.
--
-- Law 2 is untouched: nothing here calls a model. Law 5: no new table, and the table
-- altered keeps the policies it has.

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
-- Checking it here is not defensive tidiness: `mcqOptions` in `activities.ts` iterates
-- this array and shuffles what it finds, so a non-array is a client crash on the screen
-- 3d will render it on. (`gradeMcq` does not touch it -- it takes `answer` alone. An
-- earlier draft of this paragraph said it indexed into the array, which it never did.)
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
  --
  -- IT COUNTS ELEMENTS, NOT OPTIONS, and the difference is not academic. Like the shape
  -- check above it says nothing about what is IN the array, so `[1, 2]` satisfies it --
  -- and `mcqOptions` drops both as non-strings, leaving the answer alone on screen.
  -- Tapping the only thing there is scored `correct` with `confidentlyWrong: false` --
  -- `good`, or `easy` if they were quick and sure, since `gradeFrom` wants both. Either
  -- way it is a PASS recorded for a question that could not be got wrong, which is the
  -- failure this whole migration exists to make representable. Expressing the real floor here
  -- would take a jsonpath filter over the members inside a CHECK; the cheaper and more
  -- reliable place is the renderer, so `mcqOptions` returns `[]` when fewer than two
  -- options survive its filter, and `activities.test.ts` covers it. This check remains
  -- the cheap guard against a model returning one distractor or none.
  add constraint quiz_questions_mcq_has_distractors
    check (kind <> 'mcq' or jsonb_array_length(distractors) >= 2),
  -- And a cloze needs its blank. Without one `gradeCloze` has nothing to render and the
  -- reader is shown a prompt with no gap to fill.
  -- `!~ '^\s*$'` for the reason given on the reader's answer bound below: one-argument
  -- `btrim` strips spaces only, so a cloze of a single newline passed as "has its blank".
  add constraint quiz_questions_cloze_has_text
    check (kind <> 'cloze' or (cloze is not null and cloze !~ '^\s*$'));

-- THE FOUR/SIX SPLIT IS NOT MIRRORED IN TYPESCRIPT, and an attempt to do it here was
-- removed rather than kept. `activities.ts` briefly gained a `USER_QUESTION_KINDS`
-- constant for it, with a comment claiming `satisfies readonly QuestionKind[]` stopped a
-- writer typechecking `remember_pull({ kind: 'ordering' })`. Both halves were wrong:
-- `satisfies` accepts `'ordering'` precisely because it IS a `QuestionKind`, and the
-- generated `remember_pull` signature takes `p_kind?: string`, so nothing narrows a
-- direct `supabase.rpc` call anyway. It was also imported by nothing -- a dead export
-- argued for with a false fact, which is the shape `CLAUDE.md` records commit 4507a7f
-- for. The constant belongs in 2d, beside the writer that would use it and a test that
-- pins it against this constraint.

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
       -- `pull_id` after it, because retrievability alone is not a total order and ties
      -- are the normal case rather than a corner: rows written in one transaction share
      -- `last_seen_at` and the default stability, so `commit_import` (up to 20,000 items)
      -- and `remember_pull` both produce them. Measured on this seed: 34 due rows, ONE
      -- distinct retrievability, and `get_due_reviews(20)` keeping an arbitrary twenty.
      -- This clause decides which cards are on the page at all, and the questions
      -- ordering three hundred lines down was given an `id` term for exactly this reason.
      order by public.retrievability(ks.stability, ks.last_seen_at) asc, ks.pull_id
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
    -- them. Measured with 5,000 of a reader's own questions on one due pull: 129.72 ms
    -- trimming the finished array, 24.26 ms bounding each branch, against 6.56 and
    -- 5.50 ms at five questions. The first grows with what the reader chooses to write.
    --
    -- THE LIMIT IS ONLY HALF OF IT, AND THE OTHER HALF IS AN INDEX. An earlier revision
    -- of this comment said "`jsonb_build_object` is in the target list, so it is
    -- evaluated before the sort; only a limit on each branch stops the payloads being
    -- built", and the second clause is false: a `LIMIT` bounds the AGGREGATE, and does
    -- nothing to stop a projection being evaluated for every row the sort consumes.
    -- Measured on the plan the old indexes gave: `Result (rows=5000)` feeding a top-N
    -- heapsort, with all but 0.7 ms of a 16.394 ms branch happening at or below the
    -- node that builds one document per row. Phrased the way the index comment above
    -- phrases it, and for the reason it gives: an `actual time` is inclusive of its
    -- input, so the number does not say "15.7 ms of jsonb construction" -- and this
    -- paragraph said exactly that while the one two hundred lines up explained why it
    -- could not.
    --
    -- `user_questions_due_idx` is what makes the sentence true -- it returns the rows
    -- already in this order, so the limit terminates the SCAN and three payloads are
    -- built rather than five thousand. Same measurement after: three rows out of the
    -- index, 0.121 ms. See the index's own comment above.
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

/*
 * The privilege posture 20260829124835 gives every function beside this one.
 *
 * Not a regression -- `create or replace` preserves the ACL, and `get_due_reviews` has
 * carried PUBLIC execute since it was created -- and not exploitable today, because it is
 * `security invoker` with a pinned `search_path`, so `anon` calling it gets an empty
 * array and no timing signal. It is aligned here because this is the file that re-states
 * the function, and because the thing making PUBLIC execute harmless is a property
 * nothing asserts: a rewrite to `security definer` would make this ACL load-bearing
 * silently, exactly as section 7 of the test file says such a rewrite would make the
 * redundant `uq.user_id = uid` predicate load-bearing.
 */
revoke all on function public.get_due_reviews(int) from public, anon;
grant execute on function public.get_due_reviews(int) to authenticated;

comment on function public.get_due_reviews is
  'The reader''s due ideas, each with up to three questions -- their own first, then the canonical ones -- and the pull''s own example and explanation.';
