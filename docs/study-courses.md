# Study courses

[`study-generation.md`](./study-generation.md) turns a reader's sources into a generated
course, and [`study-validation.md`](./study-validation.md) decides which parts of it a
learner may be shown. This page covers the structure a reader studies from: the course
itself, the sources it follows, how it is prepared again when a source changes, and the
record of what the reader has been shown.

The schema is `supabase/migrations/20260925120000_study_course_structure.sql`. The behaviour
is asserted in `supabase/tests/study_courses.sql`, as the `authenticated` role under RLS.

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
  entry for it.
- **A generation** (`study_generations`) is one preparation of the course, from the exact
  versions it pinned in `study_generation_sources`. Every generation belongs to a course;
  `enqueue_study_generation` creates the course and its bundle with the first one.
- **The current generation** is the course's newest generation whose validation has
  finished: persisted, with its own text decided in the transaction that moved its drafts.
  A generation still being prepared, or one that failed before it was persisted, does not
  replace the one before it.

## Preparing a course again

`regenerate_study_course(course, mutation_id, processing_consent)` prepares the course
again from the newest version of each source in its bundle, for the course's own goal:

- It goes through the same door as the first preparation -- the allowlist, consent, the
  size limit, the global and per-reader budget, and the shared job counts.
- It is refused with 55000 while a generation of the course is still queued or running,
  and when nothing in the bundle has changed since a generation finished: the stage cache
  would return the same course, and the reader would pay a job for it.
- A mutation id makes it idempotent, as for the first preparation.
- **Nothing carries over.** The new generation's lessons and questions are new rows.
  Progress and proof belong to the rows they were recorded against, so a regenerated course
  starts again at `not_seen`, and an answer to the old one proves nothing about the new one.

`study_course_overview.update_available` says when a source in the bundle has a newer
version than the current generation used.

## Progress

`study_progress_events` records exposure: a lesson shown, read to the end, or skipped, and
a question shown. It is append-only (a trigger refuses any update), readable only by the
reader, and written only through `record_study_progress`:

```
record_study_progress([{ clientEventId, kind, lessonId | itemId, occurredAt? }, ...])
  kind: lesson_shown | lesson_read | lesson_skipped | item_shown
  -> { recorded, duplicates, refused: [{ index, clientEventId?, reason }] }
```

- **Idempotent.** An event with a client event id already recorded is a duplicate, never a
  second row, so an offline queue can replay a batch.
- **One to a hundred events a call; 2,000 a day.** A batch outside the size is refused with 22023. Past the daily limit an event is refused with `limit`, and the rest of the batch is
  still recorded.
- **Only the reader's own, and only what could have been shown.** An event on a lesson or
  question that is not the reader's, or does not exist, is refused as `not_found` -- the
  same answer either way. One on content that was never validated (quarantined or rejected)
  is refused as `not_shown`. A suspended or retired version was shown once, so it takes
  events; an offline copy may still be on screen.
- **The device's time, clamped.** `occurredAt` is kept within the last thirty days and never
  in the future. Exposure is never proof, so a device clock can buy nothing.
- **Refused for good.** A refused event will be refused again; a client can drop it.

**Exposure is not recall.** Being shown a lesson, reading it or seeing a question never
counts as remembering it. Whether a reader has demonstrated recall is decided only by
`study_answer_proves_recall` over `study_answer_events` (see
[`study-validation.md`](./study-validation.md#what-counts-as-recall)).

## The read path

All in SQL, under the reader's RLS (law 2); none of it calls a model.

**`study_course_overview`**, one row per course:

| Column                                      | Meaning                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `generation_id`                             | The current generation, or null before the first one finishes             |
| `title`, `overview`, `objectives`, `recap`  | The current generation's own text, only once it is validated              |
| `latest_generation_id`, `latest_job_status` | The newest generation and its job, current or not                         |
| `preparing`                                 | A generation of the course is queued or running                           |
| `update_available`                          | A bundle source has a newer version than the current generation used      |
| `lessons`, `lessons_read`                   | Validated lessons of the current generation, and how many the reader read |
| `questions`                                 | Validated questions of the current generation                             |
| `claims`, `claims_demonstrated`             | Validated claims, and those whose recall the reader has demonstrated      |

**`study_course_outline(course)`**: the current generation's validated lessons in course
order -- unit, then position -- with the unit's number and title, the lesson's title,
objective, minutes and number of validated questions, and its state: `not_seen`, `shown`,
`read` or `skipped`, with when it was first shown and read.

- A unit is its lessons' `unit_no`, and its title is the one its first lesson carries. A
  unit is not a row of its own: its number and title are generated with each lesson and
  validated with it.
- Progress belongs to the version it was recorded against, so a corrected lesson starts
  again at `not_seen`.

**`study_course_questions(course)`**: the current generation's validated questions, lesson
by lesson in course order and then the course-level ones, each with its state:

| State                 | When                                                           |
| --------------------- | -------------------------------------------------------------- |
| `recall_demonstrated` | An answer to it proves recall, by `study_answer_proves_recall` |
| `answered`            | Answered, but never in a way that proves recall                |
| `shown`               | Shown, not answered                                            |
| `not_seen`            | Neither                                                        |

`due` belongs to the scheduler, which is a later change: nothing here marks a question due.

## Deletion

- **Deleting a source** deletes every generation of every course built on one of its
  versions, with their claims, lessons, questions, reports, history, answers and progress,
  and cancels a job still preparing one. A course that keeps other sources stays, with no
  current generation, and can be prepared again from them. A course whose last source goes
  goes with it.
- **Deleting a course** (the reader may, directly) deletes all of its generations and
  cancels a job still preparing it. Its sources stay.
- **Deleting the account** deletes everything.
- All three new tables are in the account export.

## Lock order

A source deletion takes the source, then its versions, then -- through triggers -- the
generations built on them and, when it was the bundle's last source, the course. The writers
here take rows in the same order, so none can deadlock with a deletion:

- A progress event references the generation and then the lesson or question, and never the
  course.
- `enqueue_study_generation` links the bundle's sources before the generation's versions.
- A regeneration key-shares the bundle's sources before it touches the course.

## Errors

- **28000:** not signed in (or a guest session, for preparation).
- **P0002:** no such course, including someone else's.
- **22023:** a malformed request, a batch of the wrong size, or preparation without consent.
- **55000:** the course is already being prepared, or nothing in its sources has changed; or
  an update to recorded progress.
- **42501, 53400, 23514:** preparation's own refusals -- the beta allowlist, the budget, and
  the daily job ceiling -- as in [`study-generation.md`](./study-generation.md).
