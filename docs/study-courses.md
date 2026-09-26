# Study courses

[`study-generation.md`](./study-generation.md) turns a reader's sources into a generated
course, and [`study-validation.md`](./study-validation.md) decides which parts of it a
learner may be shown. This page covers the structure a reader studies from: the course
itself, the sources it follows, how it is prepared again when a source changes, and the
record of what the reader has been shown.

The schema is `supabase/migrations/20260925120000_study_course_structure.sql`, with
`20260925130000_study_course_review_fixes.sql`, `20260925140000_study_course_locks.sql`,
`20260925150000_study_course_review_round_two.sql`,
`20260925160000_study_course_lock_order.sql`,
`20260925170000_study_course_review_round_three.sql` and
`20260925180000_study_course_review_round_four.sql` superseding parts of it after review. The
behaviour is asserted in `supabase/tests/study_courses.sql`, as the `authenticated` role
under RLS.

The screens that read it are described under [The screens](#the-screens).

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
  a lesson that was ever validated -- by validation, or as the reader's own correction --
  else the newest with such a question, else the newest finished one. So a generation still
  being prepared, one that failed before it was persisted, and one whose lessons validation
  held back all leave the one before it current. The rule reads the status log, which
  nothing updates, so a report or a withdrawal never moves a course to another generation.
  A correction can: correcting a lesson validation held back in a newer generation gives
  that generation a lesson, so it becomes current, and the reader starts it at `not_seen`.

## Preparing a course again

`regenerate_study_course(course, mutation_id, processing_consent)` prepares the course
again from the newest version of each source in its bundle, for the course's own goal:

- It goes through the same door as the first preparation: the allowlist, consent, the size
  limit, the global and per-reader budget, and the shared job counts. The newest versions
  can together pass the size limit where the ones the course was made from did not; it is
  then refused with 22023 and DETAIL `too_large`, however often it is asked, until the
  reader saves a shorter version or deletes a source.
- It is refused with 55000 and DETAIL `preparing` while a generation of the course is still
  queued or running, or saved and awaiting its validation (`awaiting_validation`, below).
- It is refused with 55000 and DETAIL `unchanged` when a finished generation already used
  exactly these versions: while the prompt, schema and model are unchanged, the stage cache
  would return the same course and the reader would pay a job for it. That includes a
  generation whose lessons validation held back; a different outcome needs a changed
  source.
- A mutation id makes it idempotent, as for the first preparation. A mutation id already
  used for another course is refused with 22023 rather than answered with that course's job.
- **Nothing carries over.** The new generation's lessons and questions are new rows, so a
  regenerated course starts again at `not_seen`, and an answer to the old one proves
  nothing about the new one.

`study_course_overview.update_available` says when a bundle source has a newer version than
the newest generation finished or awaiting its validation used -- the newest, not the
current, so it never offers a regeneration that would be refused as unchanged. It does not
know whether one is queued or running, or whether the newest versions pass the size limit:
offer preparation only when `preparing` and `awaiting_validation` are both false, and say
`too_large` in words. It is also false when no
generation has finished -- the first failed before it was persisted, or a source deletion
took them all -- and a regeneration is then accepted, so offer preparation whenever
`generation_id` is null and nothing is preparing. `newer_generation_held_back` says when
the newest finished generation is not the current one, and `held_back` when validation
passed no lesson in the current one.

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
  occurredAt: an ISO-8601 string with an offset (one without is read as UTC, and other forms
              Postgres reads are accepted), or epoch milliseconds as a JSON number; the server's time
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
[`study-validation.md`](./study-validation.md#what-counts-as-recall)). Answers are recorded
and graded on the server by `record_study_answers` ([`study-practice.md`](./study-practice.md)).

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
| `newer_generation_held_back`                      | The newest finished generation is not current: validation passed no lesson in it          |
| `held_back`                                       | There is a current generation, and validation passed no lesson in it                      |
| `awaiting_validation`                             | The newest generation is saved and waits for the validation sweep, for up to a day        |
| `latest_settled`                                  | The newest generation is saved and validation settled it, whatever its job's status       |
| `update_available`                                | A bundle source has a newer version than the newest generation finished or awaiting used  |
| `lesson_count`, `lessons_read_count`              | Validated lessons of the current generation, and how many were read (skipped is not read) |
| `question_count`                                  | Validated questions of the current generation                                             |
| `claim_count`, `claims_demonstrated_count`        | Validated claims, and those whose recall the reader has demonstrated                      |

A current generation with no lesson to show is one of two things, and `held_back` says
which: validation passed no lesson in it (it may still have course-level questions), or the
reader's own reports and withdrawals took every lesson it passed. With no current
generation `held_back` is false; `preparing` and `latest_job_status` say what is happening.

`awaiting_validation` is the one thing `latest_job_status` cannot say. A job whose
validation step runs out of retries ends `failed` with its course already saved, and
`validate_stranded_study_courses` takes that course up once it is ten minutes old, five a
run. `study_generation_awaiting_validation` says which generations are coming that way --
the job has ended, the course is saved (`assembled_at`, as the sweep keys on), its text is
pending -- for a day from when it was saved, after which one validation keeps refusing stops
standing in the reader's way. The day is counted from saving rather than from queueing
because the worker lets a step wait on the budget a day at a time: a course can be saved more
than a day after it was asked for. A screen shows such a course as on its way rather than
failed; `update_available` is judged against it, so it is not offered again; and preparing
the course again is refused with `preparing` while it awaits, as while a job is queued or
running. The sweep takes courses within their day first and, among those, the least recently
tried (`validation_tried_at`, stamped where a refusal does not undo it), so courses
validation keeps refusing take turns with the rest rather than every run. `latest_settled`
says when a newest generation whose job failed was saved and settled after all, so a screen
says it was held back rather than that it failed
(`20260925190000_study_course_awaiting_validation.sql`,
`20260925195000_study_course_awaiting_from_saving.sql`).

**`study_course_outline(course)`**: the current generation's validated lessons in course
order -- unit, then position -- with the unit's number and title, the lesson's key, title,
objective, minutes and `question_count`, and its state: `read`, `skipped`, `shown` or
`not_seen`, with `first_shown_at` and `read_at`.

- A unit is its lessons' `unit_no`, not a row of its own: its number and title are
  generated with each lesson and validated with it.
- A unit's title is the one on the lesson whose unit title a correction changed most
  recently, or its first lesson's when none was corrected. A reader correcting one lesson's
  unit title retitles the unit.
- Read the unit's title from the outline, not from a lesson's own row in
  `study_visible_lessons`: each lesson keeps the title it was generated or corrected with,
  so after a correction made through another lesson the two differ. The outline's title
  follows the lessons it shows, so while the lesson that carried a retitle is reported, the
  unit reads as it did before.

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

In this list, a question's `lesson_id` names only a lesson the outline shows -- so group
questions by the list's `lesson_id`, not by the one on `study_visible_items`, which keeps the
lesson it was generated with. A question whose lesson is
held back -- reported, or quarantined -- reads as course-level until the lesson returns.

**Nullable columns.** The generated types mark every column a function returns as non-null;
these can be null, and a client must treat them so: `study_course_generation` (no current
generation); the outline's `first_shown_at` and `read_at`; the question list's `lesson_id`
(a course-level question, or one whose lesson is retired or held back), `first_shown_at`,
`last_answered_at` and `demonstrated_at`. The overview is a view, so its generated types
mark every column nullable; these never are: `course_id`, `goal`, `created_at`, every
count, `preparing`, `newer_generation_held_back`, `held_back`, `update_available`, and `objectives`,
`disagreements` and `withheld` (empty rather than null while the text is not validated).

## The screens

Signed in and not a guest, as Studio is; the two addresses answer a guest with the note the
other signed-in destinations give, and a visitor with sign-in.

- **Making a course** is in Studio, under the saved sources: choose one to five, say what
  the course is for, and confirm that the text goes to the model provider. It is offered
  only when `study_generation_available()` says the reader is in the beta, and it keeps one
  mutation id across retries of the same request, dropping it only once the server has
  answered with a refusal -- so a lost response is answered by the course already queued.
- **`/courses`** lists the reader's 200 newest courses from `study_course_overview`, saying so
  when there are more, each with where it
  stands: being prepared, could not be prepared, a source deleted, or lessons read. With no
  course yet, it sends the reader to Studio's study material (`/studio?view=study`), where
  the builder says to save a source first when there is none.
- **`/course/:id`** is one course: its overview and objectives, the outline by unit, and a
  way in. While a generation is on its way -- a job queued or running, or one saved and
  `awaiting_validation`, including a newer version of a course being read -- the course
  page looks again every fifteen seconds for five minutes, then every minute. A session does
  not: it walks the lessons it
  planned, with their titles and unit titles, so a newer version that arrives meanwhile
  changes nothing under it. An address that is not a course id reads as no such course.
- **A session** is about ten minutes: unfinished lessons in course order until their
  minutes reach ten, and it does not start a new unit once half the time is spent. Opening
  a lesson records `lesson_shown`; Done records `lesson_read`, Skip `lesson_skipped`. A
  lesson that would not open -- held back by a report on a claim it shares, withdrawn in
  another tab, unreachable offline -- was never shown, so going past it ("Go on") records
  nothing. It ends on a screen of its own that lists what was covered, each with its recap
  to say from memory, and offers to stop before it offers to go on. Skipping is not
  finishing: once every lesson is read or skipped, the course offers the skipped ones again,
  and says "every lesson read" only when that is so.
- **A lesson** shows where it comes from: each claim it teaches, read from
  `study_visible_claims`, with the passages of the reader's text it rests on
  (`study_claim_evidence`, for those claims only), and on request the passage in its
  surrounding text from `study_source_versions.extracted_text`. Offsets are code points,
  and a span that no longer matches the text is shown alone rather than in the wrong place.
- **Listening** hands the lesson to the app's player as a `localOnly` track, so one voice
  speaks at a time and the player's controls reach it. Such a track is spoken only by a
  voice installed on the device -- the reader's chosen voice when it is local, else the
  local one in their language -- and never stored with the queue; without a local voice the
  screen says so rather than offering to read it. It is an interlude, not a place in the
  queue: it plays ahead of the Pull it interrupts, and when it ends, or the reader leaves the
  lesson, it leaves the queue and the player stops on that Pull.
- **Progress is sent at once.** An event that cannot reach the server goes into the app's
  offline queue and is sent when the connection returns; one refused with `limit` is queued
  for the next day. Questions, placement and review are in
  [`study-practice.md`](./study-practice.md#the-screens).
- **Something wrong with a lesson** is answered beside it: report it (a reason, and a
  note if the reader wants), correct it, or withdraw it. A report holds the lesson back at
  once and the session moves on, with an undo; a correction is saved through
  `revise_study_lesson` as a new version that keeps the reader's place, and its failed
  checks are said in words; a withdrawal asks first. Each claim in "where this comes from"
  can be reported too, which holds back the lessons resting on it. The course page lists
  what the reader has reported and not settled, one entry per lesson, claim or question
  ([`study-practice.md`](./study-practice.md#the-screens)), each with a
  Restore that dismisses every open report on it (`dismiss_study_report`) -- a report sent
  twice, or from two tabs, would otherwise keep it held back. It reads the open reports and
  each one's title or statement from the tables, since reported content is what the visible
  views hide, and says after a Restore whether the lesson is back or still held by a claim.
  A correction being typed is kept while its form is closed, and leaving the lesson over one
  not saved -- Done, Skip or back to the course -- asks once. An answer that arrives after
  the reader moved on acts on its own lesson, not on the one shown.
- **Preparing again** is offered when `update_available`, or when there is no current
  generation and nothing is on its way; it asks for consent each time. **Deleting** calls
  `delete_study_course` and says the course is deleted, including when it had already
  gone.
- **Refusals** are read by SQLSTATE and DETAIL, as below: `unchanged`, `preparing`, `beta`
  and `unavailable` each have their own sentence, and anything else shows the server's
  message.

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

Four rules keep the writers here from deadlocking with each other and with deletion; every
order below was reproduced as a deadlock with real sessions before it was in place. In
short: the account row, then the reader's study lock, then their sources, then a course.

- **The account row first.** Saving a source locks the reader's `auth.users` row and then
  the source; deleting the account locks the row before anything it cascades to. So
  preparation -- a first one or a regeneration -- key-shares the account row before it locks
  anything, and `delete_my_account` takes its own row, FOR NO KEY UPDATE, before the reader's
  study lock, which serialises it with an administrator deleting the same account. It is
  NO KEY UPDATE because the worker locks a job row and then key-shares the account row as it
  writes (the stage cache, a generated summary): a FOR UPDATE held while the jobs are deleted
  deadlocked with it. Nothing holding the study lock ever waits on the account row: a
  progress batch, a reader's source deletion and `delete_study_course` never touch it.
- **One lock per reader, before their study rows.** `record_study_progress` holds the
  reader's `study_progress:<owner>` advisory lock for its whole call. Every path that deletes
  a reader's study rows takes the same lock before it locks any of them, so the two
  serialise rather than meeting in opposite orders -- a batch may hold events for two
  generations, which a deletion takes in whatever order its cascade reaches them:
  - a reader's own DELETE on `study_sources`, from a statement-level trigger that takes the
    lock of the reader making it (RLS confines the statement to their rows) -- so a
    deletion of several sources and one of a single source cannot take them in opposite
    orders;
  - `delete_study_course`, before it touches the course's sources;
  - `delete_my_account`, after its account row and before its first delete: it deletes the
    reader's jobs first, and those cascade to every generation, lesson and question;
  - a deletion of the `auth.users` row from outside the app -- the dashboard, the admin
    API -- from a trigger on that row, before any cascade, for an account with study
    sources.

  A row-level trigger on `study_sources` and `study_courses` takes it too, and finds it
  already held on every path above; it covers a deletion that reaches them some other way.

- **Sources before courses.** Foreign-key cascades run level by level: a source deletion
  takes the source, its versions and its bundle rows, and then -- through the trigger, when
  it was the last source -- the course. So everything else that locks a course takes its
  sources first: `delete_study_course` and a regeneration key-share the bundle's sources
  before the course, and `enqueue_study_generation` links a new course's sources before
  its versions. The last-source trigger takes the course row before it looks for the
  bundle's other rows, so two deletions of a course's last two sources cannot both leave it.

- **Questions in id order.** The answer recorder share-locks a batch's questions, in id
  order, before it records any -- every id in any form a uuid is written in, and never a
  draft, which validation takes in its own order; an id it did not lock, such as a draft
  validated since, it refuses unshown rather than locking late; a claim report
  (`study_refresh_claim_dependents`) locks the questions resting on the claim in id order;
  and a lesson's correction or withdrawal (`revise_study_lesson`, `retire_study_content`)
  locks the lesson's questions in id order before it moves them. Locked in a batch's order or
  the table's, a batch of two answers deadlocked with either (20260925200000).

**Deleting many accounts in one statement** takes one study lock for each account with study
sources, and every one of them is held in Postgres's shared lock table until the statement
commits. Purge accounts in batches of a few hundred, not in one statement.

## Errors

Branch on the SQLSTATE (`error.code` in supabase-js) and the DETAIL (`error.details`), not the
HTTP status: PostgREST answers P0002 and 55000 with a 500.

- **42501:** a signed-out caller, refused by the functions' grants before they run (HTTP
  401); preparation refused with DETAIL `beta` for a reader outside the beta, or DETAIL
  `unavailable` for a chosen source version that is not, or is no longer, theirs; or a
  direct write to any of these tables, which no reader holds a grant for (HTTP 403).
- **28000:** a guest session, refused by preparation -- or an account deleted while the
  request was on its way.
- **P0002:** no such course, including someone else's -- from a regeneration or
  `delete_study_course`.
- **22023:** preparation over the size limit, with DETAIL `too_large`; otherwise a malformed
  request, a batch of the wrong size, preparation without consent, or a mutation id already
  used for another request.
- **55000:** a regeneration refused, with DETAIL `preparing` or `unchanged`. (An update to
  recorded progress is 55000 too, but only the service role could attempt one.)
- **53400, 23514:** preparation's budget and daily job ceiling, as in
  [`study-generation.md`](./study-generation.md).
