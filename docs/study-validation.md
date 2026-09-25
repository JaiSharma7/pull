# Study validation and correction

[`study-generation.md`](./study-generation.md) turns a reader's material into a course made of
`draft` rows. This page covers what happens next:

- which drafts a learner may be shown;
- how a reader says one is wrong;
- how a corrected version replaces it;
- why no answer to a wrong, retired or suspended question can ever count as recall.

The schema is `supabase/migrations/20260925050000_study_validation_and_correction.sql`. The
behaviour is asserted under real RLS in `supabase/tests/study_validation.sql`.

Nothing here adds a screen. The report and correction controls belong beside each question
and lesson in the guided course, which is a later change. So does the server-side recorder
that grades an answer and writes it down. What this change settles is the rules those
screens must obey. The rules live in the database, so the screens cannot get them wrong.

## The lifecycle

Claims, lessons and questions share one lifecycle:

```
draft ──validate──► validated ──report──► suspended ──dismiss──► validated
  │                     │                     │
  └──► quarantined      └────── retire / revise ────────► retired
```

| Status        | Shown to a learner | Means                                                                  |
| ------------- | ------------------ | ---------------------------------------------------------------------- |
| `draft`       | no                 | Written by the worker and waiting for validation.                      |
| `rejected`    | no                 | Malformed when generated (`normalizeStudyCourse`). Kept for audit.     |
| `quarantined` | no                 | Well-formed but failed a check below. Kept for audit and human review. |
| `validated`   | **yes**            | Passed every check, and no report or unvalidated claim is holding it.  |
| `suspended`   | no                 | Reported, or rests on a claim that is reported or retired.             |
| `retired`     | no                 | Superseded by a corrected version, or withdrawn. Kept for its history. |

Only `validated` is ever shown to a learner. A question is `suspended` while any claim it
rests on is not `validated`, and a lesson likewise. So reporting a claim suspends every
lesson and question built on it in the same transaction, and dismissing the report restores
them.

## The checks

The checks are deterministic and run in SQL. The worker's last step, `study_validate`, calls
`validate_study_course`, which checks every draft claim, then every lesson, then every
question. That order matters because each level asks about the one before. Only drafts move,
so a retried step changes nothing.

The same functions check a reader's revision, so no path to a visible question skips them.

| Check                                                                                                    | Applies to                                   | Reason                                                                                           |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| a resolved evidence span                                                                                 | claim                                        | `evidence_missing`                                                                               |
| the span is still the stored text at its offsets                                                         | claim                                        | `evidence_mismatch`                                                                              |
| rests on at least one claim, all of them validated                                                       | lesson, question                             | `no_known_claims`, `cites_unvalidated_claim`                                                     |
| its lesson, if any, is live                                                                              | question                                     | `lesson_unavailable`                                                                             |
| one correct choice: no option folds to the answer or an accepted variant                                 | choice question                              | `distractor_matches_answer`                                                                      |
| two to four distinct options, each with a rationale                                                      | choice question                              | `too_few_distractors`, `duplicate_options`, `distractor_without_rationale`, `distractor_missing` |
| an accepted answer variant is not empty                                                                  | typed question                               | `accepted_answer_invalid`                                                                        |
| exactly one blank                                                                                        | cloze                                        | `cloze_malformed`                                                                                |
| a typed answer is not printed in its own prompt or cloze                                                 | cloze, short recall                          | `answer_in_prompt`                                                                               |
| the cloze answer occurs in the text or evidence of the claims it rests on                                | cloze                                        | `answer_not_in_evidence`                                                                         |
| three to six distinct steps; two to six pairs, no side repeated                                          | ordering, matching                           | `ordering_malformed`, `matching_malformed`                                                       |
| nothing addressed to a model (injected instructions, a system prompt, chat-template tokens, script tags) | all text, including a claim's quoted passage | `instruction_like`                                                                               |
| no link that appears in none of the course's sources                                                     | all text                                     | `unsourced_link`                                                                                 |

**Details**

- **How answers are compared.** Answers are folded the way `answerKey` in
  `supabase/functions/_shared/study.ts` folds them: NFKC, lower case, the same explicit
  punctuation removed, and an apostrophe treated as a word break. SQL has its own copy,
  `study_fold`.
- **How "printed in its prompt" is matched.** A phrase must match whole words. In a script
  written without spaces it matches as a substring instead.
- **What counts as a give-away.** An answer only counts as given away once it is at least
  two characters of such a script, or at least three otherwise. That catches "DNA", and
  stops a one-character answer from matching everywhere.
- **Quarantine is deliberately cautious.** A source that is genuinely about prompt injection
  will have its claims quarantined. That is where an adversarial item belongs either way,
  and the evaluation contract ([`eval/study-quality.md`](./eval/study-quality.md)) reviews
  quarantined items too.
- **What the checks cannot decide.** Groundedness beyond the evidence span, ambiguity, and
  whether more than one answer is defensible are still human judgements, made under that
  same contract.

## Reports and corrections

These are the reader's only write paths, and each one checks that the reader owns the
content it touches:

| Function                                       | Does                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `report_study_content(kind, id, reason, note)` | Files a report. The target is suspended at once, before anyone decides whether the report is right.               |
| `dismiss_study_report(report)`                 | The report was mistaken. The target is shown again, unless another report or an unvalidated claim still holds it. |
| `retire_study_content(kind, id)`               | Withdraws the target for good and resolves its reports as `retired`.                                              |
| `revise_study_item(item, revision)`            | Mints a corrected version of a question (below) and resolves its reports as `revised`, naming the new version.    |
| `revise_study_lesson(lesson, revision)`        | The same for a lesson. Its live questions move to the new version.                                                |

**What can be reported.** A report's reason is one of `incorrect`, `unsupported`,
`ambiguous`, `unanswerable` or `other`, which matches the questions the review rubric asks.
Only content a learner can see can be reported: `validated`, or already `suspended`.

**How reports are kept.** Reports stay after they are resolved and are never editable. They
are the audit trail for a suspension.

**How corrections are locked.** Corrections take a per-reader advisory lock, then the course,
then its source versions `NOWAIT`. That is the same order `persist_study_course` uses, so a
correction cannot deadlock with deleting a source or deleting the account.

**Limits**

- Fifty reports a day.
- One hundred revisions a day.
- Fifty versions of any one lesson or question.

A limit refusal is `54000`, the same code the URL-preview quota uses.

**Claims are reported or retired, never rewritten.** A claim is the source's own assertion,
tied to an exact passage. If the extraction got it wrong, the fix is to retire it. Everything
resting on it is then suspended until it is revised onto other claims (`claimIds`) or retired.

## Versioned identities

A correction never edits a question or lesson in place.

- **A new row every time.** `revise_study_item` and `revise_study_lesson` insert a new row:
  a new `id`, the same `lineage_id` and `item_key`/`lesson_key`, `version + 1`,
  `supersedes_id` pointing at the old row, and `authored_by = 'reader'`. The old row is
  retired in the same transaction.
- **One live version.** A partial unique index allows one version per lineage that is not
  retired.
- **No model provenance.** A reader's version carries no prompt hash, schema hash or model. A
  check constraint ties those fields to `authored_by = 'model'`, so a model's name is never
  put on the reader's words.
- **The revision must pass every check.** A revision that fails one is refused whole, with
  the reasons, and nothing changes.
- **Only the reader's fields change.** A revision may change the prompt, answer, accepted
  answers, options, cloze, sequence, pairs, explanation and the claims it rests on. The kind,
  purpose, difficulty and lesson are kept, because a different kind of question is a
  different question.

## The status log

`study_status_log` holds one row for every status any claim, lesson or question has had:

- **Rows start with the first status.** A row records the status the item was created in,
  then every change after it.
- **Each change says why.** The reason is one of `validation`, `reported`,
  `claim_reported`, `report_dismissed`, `retired`, `claim_retired` or `revised`.
- **Written by trigger.** No path can change a status without leaving the row.
- **Timestamped by clock time, not transaction time.** The proof rule can then ask what a
  question was at the instant it was answered.

## What counts as recall

`study_answer_events` records answers to generated questions. Each answer names the version
it answered, not its lineage. The table is append-only: a trigger refuses any update.

**There is no reader write path to it.** `recall_events`, the feed's table, accepts rows
straight from the browser, grade and all. Generated material must not work that way, because
this table is what "you know this" will be decided from. Until the practice change adds a
server-side recorder that grades the answer itself, only the database owner can insert.

`study_answer_proves_recall(event)` is the one definition of proof, and
`study_proven_claims()` lists the claims a reader has proven. An answer proves recall of the
claims its question rests on only when all of these hold:

- **It was a real retrieval.** It is correct, unhinted, and graded deterministically. A
  self-graded answer is practice and a hinted one is recognition; neither is proof.
- **The question was `validated` when it was answered.** A draft, a quarantined question, or
  one suspended by a report does not count, even after the report is dismissed.
- **The question is still `validated` now.** A retired version proves nothing, of itself or
  of anything else, and an answer to one version never counts for another. A version
  reported since the answer proves nothing while the report stands.
- **Every claim it rests on is `validated` now.**

The practice, scheduling and Delta changes must build on this function rather than on their
own reading of the table. The tests prove every clause above.

## Privacy

- **Owner-scoped.** Reports, the status log and answers are owner-scoped under RLS. A reader
  reads their own rows and cannot write any of them directly.
- **Exported.** All three are in the account export.
- **Deleted with the material.** They go with the course they belong to, which deleting any
  of its sources removes, and with the account.
