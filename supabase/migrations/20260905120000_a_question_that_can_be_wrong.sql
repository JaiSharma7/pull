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
-- THE LAST TWO ARE IN `20260905120001`, which is a second file rather than a second
-- section, because a transaction holding ACCESS EXCLUSIVE on both question tables
-- deadlocks with a referential cascade whichever order it takes them in. The paragraph
-- below is the whole account. This file is the `user_questions` half.
--
-- WHAT NEITHER FILE DOES. They write no questions: the round-one corpus gets MCQ and
-- cloze in 3b, and generation learns to produce several kinds in 3g. So after this
-- migration every `questions` array holds at most the one `recall` row the seed already
-- wrote, and `kind` is checked rather than varied. That is the intended order -- the
-- column has to exist and be bounded before anything fills it.
--
-- Law 2 is untouched: nothing here calls a model. Law 5: no new table, and the two tables
-- altered keep the policies they have.

/*
 * THIS FILE TOUCHES ONE QUESTION TABLE. ITS SIBLING TOUCHES THE OTHER.
 *
 * Third statement of this paragraph, because the first two were wrong, and the second
 * was wrong in the direction that reads as "this is safe".
 *
 * WHAT IS SETTLED. A migration FILE is one transaction: a probe of
 * `create table zz; select 1/0;` leaves no table behind. A migration RUN is not: two
 * probe files, the first creating a table and the second dividing by zero, leaves the
 * first table committed with only its own version recorded. Locks are held across a
 * file and released between files. Both halves were run here rather than assumed.
 *
 * WHAT ROUND THREE CLAIMED -- that the runner does not wrap a file, so the two ACCESS
 * EXCLUSIVE locks were never held at once. False: `pg_locks` polled through a running
 * migration shows both.
 *
 * WHAT ROUND FOUR CLAIMED -- that taking `user_questions` before `quiz_questions`, the
 * order every READER takes them, was therefore the whole fix. Also false, and this is
 * the one that mattered, because it surveyed readers and no writers. A CASCADE DELETE
 * takes the pair the other way: `delete from public.pulls` fires its referential
 * triggers in trigger-name order, and those names embed the trigger's own oid as decimal
 * text -- `RI_ConstraintTrigger_a_18579` for `quiz_questions_pull_id_fkey`
 * (20260829124507) against `RI_ConstraintTrigger_a_19771` for its `user_questions` twin
 * (20260905110000), so the canonical table goes first. It is a LEXICOGRAPHIC comparison
 * rather than a numeric one, and "older constraint fires first" holds only while both
 * oids have the same digit count. They do, here and on hosted after ninety-one
 * migrations, and the cascade order was observed directly rather than inferred. Review reproduced the deadlock three times -- including on a pull
 * with no rows in either question table, because the cascade issues the delete anyway
 * and the statement still locks the table. The reachable callers are `undo_import` and
 * `delete_my_account`, both granted to `authenticated`: a reader deleting their account
 * takes the 40P01 and gets a 500 halfway through it.
 *
 * So there is no order to pick. Readers go user then quiz, cascades go quiz then user,
 * and a transaction taking ACCESS EXCLUSIVE on both deadlocks with one of them whichever
 * way it goes. Reordering chooses the victim; it does not remove the deadlock.
 *
 * THE FIX IS THAT NO TRANSACTION TAKES BOTH. This file alters `user_questions`.
 * `20260905120001` alters `quiz_questions` and re-states `get_due_reviews`, which reads
 * both tables and takes an exclusive lock on neither. Every counterparty now queues on
 * one table rather than deadlocking across two, and the ordering question stops existing
 * instead of being traded between victims.
 *
 * One correction for the record, since round four's paragraph asserted the opposite:
 * `lock table a, b in access exclusive mode` IS reachable here. Inside a `do $$ ... $$`
 * block `CheckTransactionBlock` returns early when `!isTopLevel`, and it succeeds. It
 * simply does not help -- it acquires sequentially and inherits the same inversion.
 */
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
-- kind THROUGH THE RPC the product writes these rows with. Not through every path -- a
-- reader can POST the column directly under `user_questions_insert_own`, which is why
-- the blank-prompt rule below exists -- but the RPC is what the screens call, so the
-- constraint would make the kind unreachable in practice. It belongs with 2d/2e, which
-- is where the screen that writes choices lands, and where a reader can actually meet it.
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
  /*
   * AND A PROMPT OF ONLY WHITESPACE IS NOT A PROMPT.
   *
   * Review finding, and the same mistake as the rule above rather than a new one.
   * `user_questions_prompt_length` (20260905110000:169) bounds LENGTH only, and
   * `remember_pull` writes `btrim(p_prompt)` -- the one-argument `btrim` whose
   * spaces-only behaviour the paragraph above exists because of. So
   * `remember_pull(pull, E'\t', 'the answer', 'mcq', id)` was accepted, and a direct
   * insert under `user_questions_insert_own` did not even have the `btrim` in the way:
   * a prompt of three spaces was a valid row for any signed-in reader through PostgREST.
   *
   * `prompt` is the column the Review card renders, and a reader's own question always
   * outranks the canonical one -- so one such row both empties the card AND displaces
   * the question that would have been asked, until the reader thinks to retire it.
   * Pre-existing on `main`; closed here because it is the same table, the same `alter
   * table` and the same reasoning as the answer rule two constraints up.
   *
   * `quiz_questions.prompt` has the same length-only shape and deliberately does NOT
   * get this rule: readers have no insert or update policy on that table, and
   * `questionsToWrite` in `pipeline.ts` trims and drops a question whose prompt is
   * empty before the pipeline ever writes one.
   */
  add constraint user_questions_prompt_not_blank
    check (prompt !~ '^\s*$'),
  add constraint user_questions_explanation_length
    check (explanation is null or length(explanation) <= 2000),
  add constraint user_questions_cloze_length
    check (cloze is null or length(cloze) <= 1000),
  /*
   * AND THE WRONG ANSWERS DO NOT GET TEN TIMES THE BUDGET OF THE RIGHT ONE.
   *
   * Review finding. `user_questions_options_size` (20260905110000:190) allows 20,000
   * characters of `options` beside a 2,000-character `answer`. That was harmless while
   * nothing read the column, and stops being harmless in `20260905120001`, which is the
   * first thing to put reader-written content into the review payload -- five
   * reader-writable fields, three questions a card, up to a hundred cards, with nothing
   * bounding the product.
   *
   * Measured on 34 due pulls carrying three maximal questions each: `get_due_reviews(20)`
   * returned 19,637 bytes before those rows existed and 1,682,524 after, and this bound
   * takes the second number to 602,524. The writes that arm it are free -- guests may
   * write their own questions, deliberately -- so the amplification is the problem rather
   * than the storage.
   *
   * IT DOES NOT CLOSE THE CEILING and is not claimed to. The residual is FIVE fields --
   * prompt, answer, explanation, cloze, and the 2,000 characters of `options` this bound
   * still admits, which is the one an earlier draft of this paragraph forgot. Measured at
   * 9.8 KB a question: 30,513 bytes a card, so about 3.05 MB at `p_limit := 100`, which
   * is the figure worth quoting because 100 is what the function permits.
   *
   * Shippable, and reviewed as such rather than assumed: a reader can only inflate their
   * OWN response -- cross-reader isolation was reproduced under RLS -- arming it costs
   * them 2.7 MB of uploads first, and the armed call still returns in 18.6 ms, so it is
   * bytes rather than time. Bounding it properly is a shape change, carrying the long
   * fields only on `questions -> 0` since the screen asks one question at a time, and
   * that belongs with 3d.
   */
  add constraint user_questions_options_budget
    check (length(options::text) <= 2000);

/*
 * THE INDEX THAT MAKES THE PER-BRANCH LIMIT MEAN WHAT IT SAYS.
 *
 * `get_due_reviews` asks each pull for `where user_id = ? and pull_id = ? and
 * retired_at is null order by created_at desc, id limit 3`. Neither existing index
 * serves both halves: `user_questions_live_idx (user_id, pull_id) where retired_at is
 * null` filters without ordering, and `user_questions_user_idx (user_id, created_at
 * desc)` orders without filtering by pull. So the planner filtered, built a jsonb
 * payload for EVERY matching row, and only then sorted and took three.
 *
 * Measured, 5,000 of one reader's own questions on one due pull: `Result (actual
 * time=0.039..15.681 rows=5000)` feeding the `top-N heapsort`, inside a branch that
 * totalled 16.394 ms. An `actual time` is inclusive of the node's input, so that is
 * not "15.681 ms of jsonb construction" -- what it says is that all but 0.7 ms of the
 * branch happens at or below the node that builds one document per row, five thousand
 * times, to keep three.
 *
 * An earlier revision of this paragraph also quoted "the same query with the payload
 * replaced by bare columns runs in 2.2 ms". That came from a different fixture and does
 * not belong beside these two -- 15.681 + 2.2 exceeds the 16.394 they would both have
 * to be parts of. Only the numbers off the one plan are kept.
 *
 * That is not what the per-branch limit was claimed to do, and this migration said so
 * in as many words -- "only a limit on each branch stops the payloads being built". A
 * `LIMIT` bounds the aggregate; it does not stop a projection in the target list being
 * evaluated for every row the sort consumes. Only an index that returns the rows
 * already in order lets the limit terminate the scan, and then only three payloads are
 * ever built.
 *
 * It replaces `user_questions_live_idx` rather than joining it: same leading columns,
 * same partial predicate, two more ordering columns. Keeping both would cost every
 * write an index for no read. The two non-partial indexes lint invariant 3 wants for
 * the foreign keys -- `user_questions_user_idx` and `user_questions_pull_idx` -- are
 * untouched.
 */
drop index public.user_questions_live_idx;

create index user_questions_due_idx
  on public.user_questions (user_id, pull_id, created_at desc, id)
  where retired_at is null;

comment on index public.user_questions_due_idx is
  'Serves get_due_reviews'' per-pull lookup in its own order, so the limit stops the scan rather than the sort.';

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
