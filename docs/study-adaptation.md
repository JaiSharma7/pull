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

- the reader's last answer on it was a success -- a later wrong answer takes the knowledge
  away at once, and so does their own "not had" on a short answer, or a wrong answer to
  their own version of a question: neither is evidence to schedule by, but both are word
  that they do not have it now;
- that success still proves recall (`study_answer_proves_recall`), re-read every time, so a
  report or a withdrawal of the question or a claim since takes it away;
- its retrievability now is above 0.7, the feed's floor (`known_retrievability_floor()`,
  compared as the feed compares it) -- an old success expires;
- the claim is validated now.

Nothing else counts: being shown a lesson, reading it, a self-graded answer, a hinted one --
and an answer is hinted by a wrong or self-graded one in the half hour before to any question
on the same claim, so a second question on an idea just got wrong cannot clear the lapse --
an answer to the reader's own version of a question, an answer to a question held back, or an
answer in another reader's course. The suite asserts each of these as a case that must not
make a lesson known, under the reader's RLS. A lesson is known by every claim any version of
it cited: a reader's revision can add to what it must be known by, never take away from it.
A claim held back counts as not known there, rather than dropping out and leaving the rest to
call the lesson known; a claim withdrawn for good is no longer part of it.

What this protects against is the honest reader's false suppression, not a reader set on
fooling themselves: a question's answer and options are readable by its reader, on purpose,
so grading works offline. Nothing any reader does reaches another reader's course.

## The memory

`study_claim_memory` holds one row per reader per claim: stability, difficulty, repetitions,
lapses, the last outcome, and the answer that last proved it. It is written only by the
answer recorder, in the transaction that records the answer (`study_remember`); no API role
writes it, and the reader reads their own.

| The answer                                                                                 | What it does to the memory                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proves recall                                                                              | A success. Stability grows as the feed's `grade_recall` good does, by 2 + (1 - difficulty), on the first success, or on a success following a success once the claim was due -- a stability after the last. Before then, answering again is repetition, not spacing, and stability stays: a reader who always reviews early does not grow it. A proof after a lapse -- scored or the reader's own "not had" -- is relearning: knowledge comes back, stability stays as the lapse left it |
| Wrong, where a right answer would have proved                                              | A lapse. Stability falls to 0.35 of itself (at least half a day), difficulty rises by 0.15. Graded deterministically, to a question the model wrote, validated when answered and now, on validated claims -- hinted or not                                                                                                                                                                                                                                                               |
| Any other wrong answer: the reader's own "not had", their own version, a key they reported | Not known now: the last outcome is a lapse, and the claim is due half an hour on. Stability, difficulty and the lapse count are left as they were, and it does not prime the next success to grow stability -- a "not had" at every due review, then a proof, would compound a claim the reader keeps missing into years                                                                                                                                                                 |
| Anything else                                                                              | Nothing. A hinted right answer does not clear a lapse                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Retrievability is 0.9 ^ (days since the last success / stability), computed and never
stored, as for the feed. Stability a proof added stays if the proof is later withdrawn: the
claim is not known while the proof no longer stands, and the next proof grows from there.

## What the reader sees

- **Known lessons** are left out of sittings, without asking: that is the Delta. One not yet
  read -- known from a placement check or from review -- reads "You know this" in the
  outline ("Skipped · you know this" if skipped); one already read still reads "Read". The
  course page says how many are left out and that each opens from the outline, the end of a
  sitting counts them, and a placement check's result lists them as what the reader already
  knows -- from this rule, read again once the check's answers are in, never a second rule
  of the screen's own.
- **Faded lessons** -- known once, not now -- say "You knew this · time to refresh" (or
  "Read · time to refresh") rather than returning to the course silently. One unread comes
  back into sittings in its turn; one read is left to the review, where its questions come
  due. A proof withdrawn since -- its question reported or corrected -- also reads as faded,
  though nothing wore off: the proof no longer stands.
- **Lessons to revisit** -- read, and a claim this version teaches lapsed since it was last
  read -- read "Worth rereading", come first in the next sitting, open on a line saying why,
  and turn the course page's button into "Reread what you got wrong". Only a lesson read:
  one never read comes in its turn, so a wrong answer in a placement check does not move
  where the course starts. Reading it again answers it -- by the server's clock, as the
  lapse is timed -- so a sitting does not bring it back over and over; the claim stays due.
  Only while a question the model wrote can still clear the lapse: the reader's own
  versions never prove, and with only those left it could never go.
- **Due questions.** A question is due once answered, when the first claim it tests is due:
  half an hour after a lapse -- before then every answer to it is hinted and could not clear
  it -- otherwise one stability after the last success, when its recall has fallen to 0.9.
  Due is judged by the server's clock, and a reader's own version is never due. Practice
  after a lesson asks its due questions first, so a lapse can be cleared in the sitting; a
  review asks what is due, soonest first, and when nothing is due the course's review
  questions.
- **A right answer that counts for nothing** says so: when the server records a right answer
  as hinted by an answer on the same idea in the half hour before, the screen's "Right" is
  followed by "practice, not proof".

## The read path

- `study_claim_knowledge(course, at default null)` -- each validated claim of the current
  generation: `known`, `retrievability`, `due_at`, `lapsed`, `lapsed_at`. The `at` is for
  asking about another moment ("known a month from now?"), which the suite uses to test
  expiry; asked about the past, nothing proven since counts. Days are counted to at most a
  thousand stabilities, so no moment is out of range.
- `study_course_outline(course)` gains `known`, `revisit` and `faded`.
- `study_course_questions(course)` gains `due_at` and `due`, the columns
  [`study-courses.md`](./study-courses.md) promised rather than a fifth state.

The offline queue keeps a course's study answers in one order (`writeScope`): an answer is
hinted by a wrong one to any question on the same idea, and the memory moves in the order
answers arrive, so one held back holds back that course's answers after it -- not every
course's. An answer given live, while earlier ones wait in the queue, reaches the server
first; the order holds among queued answers, and the hint's half hour, measured as answers
arrive, covers the rest.

A regeneration starts a new memory: its claims are new rows, and nothing carries over, as for
progress and answers.

## Locks

`study_remember` writes the memory inside the recorder, whose foreign key to the claim
key-shares it. A claim report or withdrawal locks the claim before its questions, so the
recorder key-shares a batch's claims, in id order, before it share-locks the batch's
questions: taken after them, a batch and a claim report deadlocked every time. See
[Lock order](./study-courses.md#lock-order).
