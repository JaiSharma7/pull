# Study practice

[`study-courses.md`](./study-courses.md) is the course a reader studies from, and
[`study-validation.md`](./study-validation.md) decides what counts as recall. This page covers
answering a course's questions: how an answer is graded and recorded, what the screens ask
and when, and how practice survives losing the connection.

The schema is `supabase/migrations/20260925200000_study_answers.sql`, asserted in
`supabase/tests/study_answers.sql`. The browser's copy of the grading rule is
`apps/web/src/lib/study-grade.ts`, held to the SQL by `scripts/test-study-grade-parity.mjs`.
Nothing here calls a model (law 2).

## Recording an answer

`study_answer_events` is what "you know this" is decided from, so no API role writes it
directly. The one path is `record_study_answers`, a definer function that grades the answer
itself:

```
record_study_answers([{ clientEventId, itemId, response, selfGrade?, hinted? }, ...])
  -> { recorded, duplicates,
       refused: [{ index, clientEventId?, reason }],
       results: [{ index, clientEventId, itemId, correct, grading, hinted, provesRecall }] }
```

- **The server grades.** The browser grades too, so feedback is immediate and works offline,
  but it sends the reader's _response_, never its verdict. The server grades the response
  again, and its grade is the one kept and returned in `results`.
- **Idempotent.** A client event id already recorded is a duplicate: never a second row, and
  answered in `results` with what was recorded, so a replayed queue learns the grade.
- **One to fifty answers a call**, each judged on its own; a batch outside that size is
  refused whole with 22023.
- **1,000 a day**, by the UTC day the database stamps. `limit` is the one refusal that
  clears; a client keeps the answer queued.
- **Refusals.** `malformed`: not an object, a bad id, a response the kind cannot take (an
  option never offered, positions that are not a permutation, a self-grade missing where
  one is needed). `not_found`: not the reader's question, or gone -- the same answer either
  way. `not_shown`: a question validation never passed. These three are final.
- **The time is the database's.** `answered_at` is stamped when the answer reaches the
  server, so an answer given offline carries the time it was sent.
- **Serialised with deletion.** The recorder takes the reader's study lock first, as a
  progress batch does (see [Lock order](./study-courses.md#lock-order)).

## Grading

| Kind                                           | Response                                                                   | Graded                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `multiple_choice`, `comparison`, `application` | The option chosen, as text                                                 | Right when it folds to the answer; wrong when it folds to an offered wrong option; any other text is `malformed` |
| `cloze`                                        | What was typed                                                             | Right when it folds to the answer or an accepted variant; wrong otherwise                                        |
| `short_recall`                                 | What was typed, and a `selfGrade` when it does not match                   | Right when it folds to the answer or a variant (`deterministic`); otherwise the reader's own judgement (`self`)  |
| `ordering`                                     | The steps' positions in the question's own sequence, in the reader's order | Right when the positions are in order                                                                            |
| `matching`                                     | For each left side in order, the position of the right side chosen         | Right when every pair is kept                                                                                    |

Folding is `study_fold`, as everywhere else ([how answers are compared](./study-validation.md)).
Positions are stored as comma-separated numbers, and text as given, up to 1,000 characters.

**Self-grading is practice.** A short answer that does not match is shown beside the course's
answer, and the reader says whether they had it. That is recorded with `grading = 'self'`,
which the proof rule never counts: a reader's judgement of their own answer is not evidence
that the course can check.

**Hinted.** An answer is hinted when the reader says so -- the screen marks it when they
opened the passage behind the question before answering -- or when a wrong answer to the same
question, in any of its versions, was recorded in the half hour before: its feedback showed
the right one. A hinted answer is recorded and never proof. So a retry is practice.

**Proof** is `study_answer_proves_recall`, unchanged: right, unhinted, graded
deterministically, to a model-written question that was validated when it was answered and
still is, resting on claims that are all validated. `provesRecall` in the result is that
rule, read as the recorder wrote the row.

## The screens

- **After a lesson.** Done on a lesson opens its practice questions -- those the reader has
  not yet shown they remember -- before the session goes on. Leaving them goes on.
- **Checking what you know.** A course nobody has opened offers its placement questions
  first. A lesson whose every placement question was answered right the first time, graded
  by the rule and without looking, is suggested as known; the reader chooses whether to skip
  the suggested lessons, and a skip is an ordinary `lesson_skipped`. A retry never counts.
- **Review.** The course's review questions, not yet demonstrated first, from the course page
  or the end of a session.
- **Each question** says whether it was right in words, shows the right answer and why a
  chosen wrong option was wrong, then the question's explanation, and offers another try.
  It can show the passage it rests on (which makes the answer hinted), and it can be reported
  or withdrawn, as a lesson can.
- **Shown.** A question on screen is recorded as `item_shown` once, which is exposure and
  never proof.

## Offline

Answers and progress are sent at once. When a request cannot reach the server, the event goes
into the app's offline queue (`apps/web/src/lib/offline.ts`), and the shell sends it when the
connection returns (`replay.ts`), one event per call, in order per question and per lesson,
so a retry still follows the wrong answer it retried. The feedback the reader saw came from
the browser's grade; the server's is recorded. An event refused with `limit` stays queued;
one refused for good is dropped.

## Limits and errors

- 50 answers a call; 1,000 a day; 1,000 characters a response.
- **28000:** not signed in. **22023:** a batch of the wrong size. Everything else is a
  per-answer refusal in the result, not an error.
