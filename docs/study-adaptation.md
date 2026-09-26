# Study adaptation: the study Delta

[`study-practice.md`](./study-practice.md) records answers, and
[`study-validation.md`](./study-validation.md) decides which answers prove recall. This page
covers what a course does with them: remembering each claim, knowing which lessons a reader
no longer needs, sending them back to what they got wrong, and asking again when memory
fades.

The schema is `supabase/migrations/20260925210000_study_memory.sql`, asserted in
`supabase/tests/study_memory.sql`. Everything here is SQL and arithmetic (law 2).

## The rule, and the risk it controls

The feed's Delta takes an idea out of the feed only on strict evidence that the reader knows
it ([`eval/delta-reliability.md`](./eval/delta-reliability.md)): false suppression -- hiding
what the reader does not in fact know -- is the first risk. The study Delta has the same
rule. A lesson is left out of a session only when every claim it teaches is known now, and a
claim is known only when all of these hold:

- the reader's last deterministic answer on it was a success -- a later wrong answer takes
  the knowledge away at once;
- that success still proves recall (`study_answer_proves_recall`), re-read every time, so a
  report or a withdrawal of the question or a claim since takes it away;
- its retrievability now is at least 0.7, the feed's floor -- an old success expires;
- the claim is validated now.

Nothing else counts: being shown a lesson, reading it, a self-graded answer, a hinted one, an
answer to the reader's own version of a question, an answer to a question held back, or an
answer in another reader's course. The suite asserts each of these as a case that must not
make a lesson known, under the reader's RLS.

## The memory

`study_claim_memory` holds one row per reader per claim: stability, difficulty, repetitions,
lapses, the last outcome, and the answer that last proved it. It is written only by the
answer recorder, in the transaction that records the answer (`study_remember`); no API role
writes it, and the reader reads their own.

| The answer                                                   | What it does to the memory                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proves recall                                                | A success. Stability grows as the feed's `grade_recall` good does, by 2 + (1 - difficulty), unless the last success was under twelve hours ago: answering again the same day is repetition, not spacing |
| Wrong, graded deterministically, on a model-written question | A lapse. Stability falls to 0.35 of itself (at least half a day), difficulty rises by 0.15                                                                                                              |
| Anything else                                                | Nothing. A hinted right answer does not clear a lapse                                                                                                                                                   |

Retrievability is 0.9 ^ (days since the last success / stability), computed and never
stored, as for the feed.

## What the reader sees

- **Known lessons** are left out of sessions. One not yet read -- known from a placement check
  or from review -- reads "You know this" in the outline; one already read still reads
  "Read", which says as much. They stay in the outline, and opening one reads it like any
  other.
- **Lessons to revisit** -- one of their claims was last answered wrong -- read "Worth
  rereading" and come first in the next session.
- **Due questions.** A question is due once answered, when the first claim it tests is due:
  at once after a lapse, otherwise one stability after the last success, when its recall has
  fallen to 0.9. A review asks what is due, soonest first; when nothing is due it asks the
  course's review questions.

## The read path

- `study_claim_knowledge(course, at default now())` -- each validated claim of the current
  generation: `known`, `retrievability`, `due_at`, `lapsed`. The `at` is for asking about
  the future ("known a month from now?"), which the suite uses to test expiry.
- `study_course_outline(course)` gains `known` and `revisit`.
- `study_course_questions(course)` gains `due_at`, the column [`study-courses.md`](./study-courses.md)
  promised rather than a fifth state.

A regeneration starts a new memory: its claims are new rows, and nothing carries over, as for
progress and answers.
