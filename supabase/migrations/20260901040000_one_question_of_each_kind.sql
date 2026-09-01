-- `insertQuizQuestions` upserts on `pull_id`, and nothing enforced it.
--
-- `quiz_questions` has exactly two indexes: the primary key on `id`, and a
-- plain non-unique `quiz_questions_pull_idx` on `pull_id`. An `on conflict
-- (pull_id)` against that raises 42P10 — "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification" — at runtime, on the step
-- immediately after synthesis has been paid for.
--
-- Found by checking the schema rather than by running the pipeline, and it is
-- worth recording HOW it was missed: `pipeline.test.ts` exercises `cards` against
-- a fake `PipelineDb`, and a fake accepts any conflict target because it never
-- reaches Postgres. This is the same shape as the failure `docs/roadmap.md`
-- records from round 2 — four values TypeScript accepted and the database
-- refused, discovered only after the expensive call was paid for. A test that
-- mocks the database cannot catch a constraint that does not exist.
--
-- `(pull_id, kind)` rather than `(pull_id)`. The column exists so an idea can
-- carry more than one kind of question — a recall prompt and a say-it-back
-- prompt are different things about the same idea — and a unique constraint on
-- `pull_id` alone would forbid that permanently to make one upsert convenient.
-- One of each kind per idea is the actual rule.
--
-- The plain `quiz_questions_pull_idx` stays. CI check 4's third invariant wants
-- a NON-partial index whose leading column matches the foreign key, and while
-- this new one would satisfy that too, dropping the old one to save a few
-- kilobytes on a table with six rows is not a trade worth making in the same
-- migration that fixes a crash.

create unique index quiz_questions_pull_kind_key
  on public.quiz_questions (pull_id, kind);

comment on index public.quiz_questions_pull_kind_key is
  'One question of each kind per Pull. The conflict target `insertQuizQuestions` upserts on, so a partially-written cards step converges on retry instead of failing permanently.';
