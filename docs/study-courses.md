# Study courses

[`study-generation.md`](./study-generation.md) turns a reader's sources into a generated
course, and [`study-validation.md`](./study-validation.md) decides which parts of it a
learner may be shown. This page covers the structure a reader studies from: the course
itself, the sources it follows, how it is prepared again when a source changes, and the
record of what the reader has been shown.

The schema is `supabase/migrations/20260925120000_study_course_structure.sql`, with
`20260925130000_study_course_review_fixes.sql`, `20260925140000_study_course_locks.sql` and
`20260925150000_study_course_review_round_two.sql` superseding parts of it after review. The
behaviour is asserted in `supabase/tests/study_courses.sql`, as the `authenticated` role
under RLS.

Nothing here adds a screen: the guided course is a later change, and it reads what this
page describes.

## The shape

```
study_courses ─── study_course_sources      the course, and the sources it follows (1-5)
     └── study_generations ─── study_generation_sources   one preparation of it, from the
          │                                                 versions it pinned
          ├── claims, lessons, questions    (study-generation.md, study-validation.md)
          └── study_progress_events         what the reader was shown, read or skipped
```

- **A course** (`study_courses`) is the reader's goal and a bundle of their sources. It is
  owner-scoped under RLS, and separate from the public curated `paths`: no key links the
  two, and nothing of a course is readable by anyone else or by anon.
- **The bundle** (`study_course_sources`) names sources, not versions: one row per source,
  in the order the reader chose them. A course made from two versions of one source has one
  entry for it, and is prepared again from that source's newest version only.
- **A generation** (`study_generations`) is one preparation of the course, from the exact
  versions it pinned in `study_generation_sources`. Every generation belongs to a course;
  `enqueue_study_generation` creates the course and its bundle with the first one.
- **The current generation** is chosen among the course's finished generations (persisted,
  with their own text decided in the transaction that moved their drafts): the newest with
  a lesson that can be shown -- validated, or suspended and able to return once its report
  is resolved -- else the newest with such a question, else the newest finished one. So a
  generation still being prepared, one that failed before it was persisted, and one whose
  lessons validation held back all leave the one before it current.

## Preparing a course again

`regenerate_study_course(course, mutation_id, processing_consent)` prepares the course
again from the newest version of each source in its bundle, for the course's own goal:

- It goes through the same door as the first preparation: the allowlist, consent, the size
  limit, the global and per-reader budget, and the shared job counts.
- It is refused with 55000 and DETAIL `preparing` while a generation of the course is still
  queued or running.
- It is refused with 55000 and DETAIL `unchanged` when a finished generation already used
  exactly these versions: while the prompt, schema and model are unchanged, the stage cache
  would return the same course and the reader would pay a job for it. That includes a
  generation validation held back entirely; a different outcome needs a changed source.
- A mutation id makes it idempotent, as for the first preparation. A mutation id already
  used for another course is refused with 22023 rather than answered with that course's job.
- **Nothing carries over.** The new generation's lessons and questions are new rows, so a
  regenerated course starts again at `not_seen`, and an answer to the old one proves
  nothing about the new one.

`study_course_overview.update_available` says when a bundle source has a newer version than
the newest finished generation used -- the newest, not the current, so it never offers a
regeneration that would be refused as unchanged. It does not know whether one is already
being prepared: offer preparation only when `preparing` is false. It is also false when no
generation has finished -- the first failed before it was persisted, or a source deletion
took them all -- and a regeneration is then accepted, so offer preparation whenever
`generation_id` is null and nothing is preparing. `newer_generation_held_back` says when
the newest finished generation is not the current one.

**Responses.** `enqueue_study_generation` and `regenerate_study_course` return
`{ jobId, generationId, courseId, status, queue, delaySeconds, remainingToday, replayed }`.
A replay returns `{ jobId, generationId, courseId, status, replayed: true }`, with
`courseId` null when the generation has since been deleted.

## Progress

`study_progress_events` records exposure: a lesson shown, read to the end, or skipped, and a
question shown. It is append-only (a trigger refuses any update), readable only by the
reader, and written only through `record_study_progress`:

```
record_study_progress([{ clientEventId, kind, lessonId | itemId, occurredAt? }, ...])
  kind: lesson_shown | lesson_read | lesson_skipped | item_shown
  occurredAt: an ISO-8601 string, or epoch milliseconds as a JSON number; the server's time
              when absent or null; any other type is malformed
  -> { recorded, duplicates, refused: [{ index, clientEventId?, reason }] }
```

- **Idempotent.** An event with a client event id already recorded is a duplicate, never a
  second row, so an offline queue can replay a batch.
- **One to a hundred events a call.** A batch outside that size is refused whole with 22023.
  Within a batch each event is judged on its own; `index` is its 0-based position, and
  `clientEventId` is named whenever it parsed.
- **2,000 a day**, counted by the UTC day the server records them. Once a batch reaches the
  limit, every later event in it that would otherwise have been recorded is refused with
  `limit` (a duplicate is still a duplicate, and a bad event keeps its own reason); the
  earlier ones are recorded. `limit` is the one refusal that clears: the same event is accepted after 00:00
  UTC, so a client should keep it queued.
- **Only the reader's own, and only what could have been shown.** An event on a lesson or
  question that is not the reader's, or does not exist, is refused as `not_found` -- the
  same answer either way. One on content that was never validated is refused as
  `not_shown`: a quarantined or rejected version, including a quarantined one the reader
  retired. A suspended version, or one retired after it was validated, was shown once, so
  it takes events; an offline copy may still be on screen.
- **The device's time, clamped.** `occurredAt` is kept within the last thirty days and never
  in the future; the server's `recorded_at` is kept beside it. Exposure is never proof, so a
  device clock can buy nothing.
- **`malformed`, `not_found` and `not_shown` are for good.** The same event will be refused
  again; a client can drop it.

**Exposure follows the reader's corrections; answers do not.** Exposure is read across
every version of a lesson or question within its generation (its `lineage_id`): the reader
wrote the correction, so correcting a typo keeps the lesson `read`. Answers and proof stay
with the version answered: a reader's version is practice, and one question proves nothing
about another.

**Exposure is not recall.** Being shown a lesson, reading it or seeing a question never
counts as remembering it. Whether a reader has demonstrated recall is decided only by
`study_answer_proves_recall` over `study_answer_events` (see
[`study-validation.md`](./study-validation.md#what-counts-as-recall)). Nothing records an
answer yet -- the recorder that grades one on the server is a later change -- so `answered`
and `recall_demonstrated` below appear only once it exists.

## The read path

All in SQL, under the reader's RLS (law 2); none of it calls a model. The read functions
give structure and state; the lessons' and questions' own text is read from the
`study_visible_*` views by id.

**`study_course_overview`**, one row per course:

| Column                                            | Meaning                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `course_id`, `goal`, `created_at`, `source_count` | The course, and how many sources its bundle has                                           |
| `generation_id`                                   | The current generation; null before one finishes, or once a source deletion took them all |
| `title`, `overview`, `objectives`, `recap`        | The current generation's own text, only once it is validated                              |
| `disagreements`, `withheld`                       | Likewise: disagreements between sources, and questions the claims cannot answer           |
| `latest_generation_id`, `latest_job_status`       | The newest generation and its job, current or not                                         |
| `preparing`                                       | A generation of the course is queued or running                                           |
| `newer_generation_held_back`                      | The newest finished generation is not current: validation held all of it back             |
| `update_available`                                | A bundle source has a newer version than the newest finished generation used              |
| `lesson_count`, `lessons_read_count`              | Validated lessons of the current generation, and how many were read (skipped is not read) |
| `question_count`                                  | Validated questions of the current generation                                             |
| `claim_count`, `claims_demonstrated_count`        | Validated claims, and those whose recall the reader has demonstrated                      |

**`study_course_outline(course)`**: the current generation's validated lessons in course
order -- unit, then position -- with the unit's number and title, the lesson's key, title,
objective, minutes and `question_count`, and its state: `read`, `skipped`, `shown` or
`not_seen`, with `first_shown_at` and `read_at`.

- A unit is its lessons' `unit_no`, not a row of its own: its number and title are
  generated with each lesson and validated with it.
- A unit's title is the one on the lesson whose unit title a correction changed most
  recently, or its first lesson's when none was corrected. A reader correcting one lesson's
  unit title retitles the unit.

**`study_course_questions(course)`**: the current generation's validated questions, lesson
by lesson in course order and then the course-level ones, each with its key, purpose, kind,
difficulty, authorship and state, with `first_shown_at`, `last_answered_at` and
`demonstrated_at`:

| State                 | When                                                           |
| --------------------- | -------------------------------------------------------------- |
| `recall_demonstrated` | An answer to it proves recall, by `study_answer_proves_recall` |
| `answered`            | Answered, but never in a way that proves recall                |
| `shown`               | Shown, not answered                                            |
| `not_seen`            | Neither                                                        |

`due` belongs to the scheduler, which is a later change: nothing here marks a question due.
It is orthogonal to these states -- a question can be demonstrated and due -- so it will be a
column, not a fifth state.

A question's `lesson_id` names only a lesson the outline shows. A question whose lesson is
held back -- reported, or quarantined -- reads as course-level until the lesson returns.

**Nullable columns.** The generated types mark every column a function returns as non-null;
these can be null, and a client must treat them so: `study_course_generation` (no current
generation); the outline's `first_shown_at` and `read_at`; the question list's `lesson_id`
(a course-level question, or one whose lesson is retired or held back), `first_shown_at`,
`last_answered_at` and `demonstrated_at`. The overview is a view, so its generated types
mark every column nullable; these never are: `course_id`, `goal`, `created_at`, every
count, `preparing`, `newer_generation_held_back`, `update_available`, and `objectives`,
`disagreements` and `withheld` (empty rather than null while the text is not validated).

## Deletion

- **Deleting a source** deletes every generation of every course built on one of its
  versions, with their claims, lessons, questions, reports, history, answers and progress,
  and cancels a job still preparing one. A course that keeps other sources stays, with no
  current generation, and can be prepared again from them. A course whose last source goes
  goes with it.
- **Deleting a course** is `delete_study_course(course)` (P0002 when it is not the
  reader's): it deletes all of the course's generations and cancels a job still preparing
  one. Its sources stay -- and so does the model output cached from them
  (`study_stage_cache`), keyed by the source versions rather than the course, until those
  sources are deleted. There is no direct DELETE on the table: the function takes the
  course's sources before the course, the order a source deletion takes them.
- **Deleting the account** deletes everything.
- All three new tables are in the account export.

## Lock order

Two things keep the writers here from deadlocking with each other and with deletion; both
were reproduced as deadlocks with real sessions before they were in place.

- **One lock per reader for progress and deletion.** `record_study_progress` holds the
  reader's `study_progress:<owner>` advisory lock for its whole call, and deleting one of
  the reader's sources or courses takes the same lock before its cascade reaches any
  generation, lesson or question (a `before delete` trigger). A batch never touches sources
  or courses, so the two serialise rather than meeting in opposite orders -- a batch may
  hold events for two generations, which a deletion takes in whatever order its cascade
  reaches them. It also serialises two deletions of one reader's sources.
- **Sources before courses.** Foreign-key cascades run level by level: a source deletion
  takes the source, its versions and its bundle rows, and then -- through the trigger, when
  it was the last source -- the course. So everything else that locks a course takes its
  sources first: `delete_study_course` and a regeneration key-share the bundle's sources
  before the course, and `enqueue_study_generation` links a new course's sources before
  its versions. The last-source trigger takes the course row before it looks for the
  bundle's other rows, so two deletions of a course's last two sources cannot both leave it.

## Errors

Branch on the SQLSTATE (`error.code` in supabase-js) and the DETAIL (`error.details`), not the
HTTP status: PostgREST answers P0002 and 55000 with a 500.

- **42501:** a signed-out caller, refused by the functions' grants before they run (HTTP
  401); preparation refused with DETAIL `beta` for a reader outside the beta, or DETAIL
  `unavailable` for a chosen source version that is not, or is no longer, theirs.
- **28000:** a guest session, refused by preparation.
- **P0002:** no such course, including someone else's -- from a regeneration or
  `delete_study_course`.
- **22023:** a malformed request, a batch of the wrong size, preparation without consent, or
  a mutation id already used for another request.
- **55000:** a regeneration refused, with DETAIL `preparing` or `unchanged`; or an update to
  recorded progress.
- **53400, 23514:** preparation's budget and daily job ceiling, as in
  [`study-generation.md`](./study-generation.md).
