/*
 * The recall question comes first, until a screen exists that can render the others.
 *
 * 3g teaches generation to write THREE questions for an idea -- a recall, a multiple
 * choice and a cloze -- where it used to write one. `get_due_reviews` derives the
 * singular `question` the deployed Review screen renders from `questions -> 0`, and the
 * canonical branch was ordered `created_at desc, id`. All three rows are written by one
 * `insertQuizQuestions` statement, so they share `now()` to the microsecond and the
 * tiebreak is `gen_random_uuid()`.
 *
 * SO WHICH QUESTION A READER IS ASKED WAS A LOTTERY, and two of the three tickets are
 * unanswerable on the screen that exists. `Review.tsx` renders `card.question` and a
 * Reveal button; it has no kind awareness, because 3d is the PR that adds it and 3d has
 * not landed. An mcq drawn first shows "Which of these does X claim?" with nothing to
 * choose from. A cloze shows "Fill the blank." with no blank. Measured over 300 pulls
 * carrying one row of each kind: recall came first 87 times.
 *
 * There is a worse, deterministic variant. `insertQuizQuestions` upserts on
 * `(pull_id, kind)`, and `on conflict do update` KEEPS the existing `created_at` -- so a
 * pull that already carries a recall row (any re-run into an existing summary, or a
 * partial write of `cards` retried) gets a recall whose timestamp is older than the mcq
 * and cloze beside it, and it sorts last every single time.
 *
 * 20260905120001's own header is what this defends: "the three stay for one release ...
 * the deployed Review screen reads it; 3d is the PR that renders `questions` by kind.
 * Removing them here would break the screen between this merge and that one, and `main`
 * deploys on every merge." Leaving the order to a uuid breaks it just as effectively.
 *
 * The term is `(qq.kind <> 'recall')`, and it is deliberately not a ranking of all six
 * kinds: this is not a claim that recall is the best question, only that it is the one
 * the current screen can ask. 3d reads the array by kind and ignores the order entirely,
 * at which point this clause costs nothing and stops mattering.
 *
 * IT ORDERS, IT DOES NOT SELECT, and the difference is a rule this file must not break.
 * Two `limit 3`s decide which questions come back -- the canonical branch's and the
 * union's -- and both still cut by RECENCY, so a reader is asked the questions written
 * most recently for an idea. `questions.sql` asserts exactly that, and it caught two
 * drafts of this migration that broke it: the first put the kind term in the branch's
 * ORDER BY, the second in the union's, and each made an old recall survive a cap that a
 * newer question should have won.
 *
 * So `rank` is carried as a COLUMN through both branches and used in one place only: the
 * `jsonb_agg` that assembles the array, after every cut has been made. The cap is about
 * which questions exist; the rank is about which of the survivors is asked first.
 *
 * WHY THE WHOLE FUNCTION IS RESTATED. Migrations are append-only (law 6), so a change to
 * a `create or replace` function is a new file carrying the whole body. Everything below
 * is 20260905120001's function verbatim except the five lines this header describes;
 * diff the two before reviewing it.
 *
 * The ACL is restated for the same reason 20260905120001 restated it: `create or
 * replace` preserves it, so this changes nothing today, and it keeps the posture visible
 * in the file that defines the function rather than one file back.
 */

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
      select coalesce(jsonb_agg(q.j order by q.own desc, q.rank, q.written_at desc, q.qid),
                      '[]'::jsonb) as questions
        from (
          (
            select 0 as own, 0 as rank, uq.created_at as written_at, uq.id as qid,
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
            select -1, (qq.kind <> 'recall')::int, qq.created_at, qq.id,
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
          order by 1 desc, 3 desc, 4
          limit 3
        ) q
    ) asked on true
  ) x;

  return res;
end;
$$;

revoke all on function public.get_due_reviews(int) from public, anon;
grant execute on function public.get_due_reviews(int) to authenticated;

comment on function public.get_due_reviews is
  'The reader''s due ideas, each with up to three questions -- their own first, then the canonical ones, recall before the kinds the current screen cannot render.';
