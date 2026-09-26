# Study validation and correction

[`study-generation.md`](./study-generation.md) turns a reader's material into a course made of
`draft` rows. This page covers the rest of the lifecycle:

- which drafts a learner may be shown;
- how a reader reports one;
- how a corrected version replaces it;
- why no answer to a retired, suspended or unvalidated question can count as recall.

The schema lives in seven migrations, each later one superseding parts of the ones before
after a review round:

- `supabase/migrations/20260925050000_study_validation_and_correction.sql`
- `20260925060000_study_validation_review_fixes.sql`
- `20260925070000_study_validation_parity.sql`
- `20260925080000_study_validation_review_round_two.sql`
- `20260925090000_study_validation_sweep_and_proof.sql`
- `20260925100000_study_validation_review_round_three.sql`
- `20260925110000_study_validation_review_round_four.sql`

The behaviour is asserted in `supabase/tests/study_validation.sql`: the reader's paths as
the `authenticated` role under RLS, and the worker's as the service role. That includes a
course at the count limits (300 claims, 24 lessons, 48 questions over a 200,000-character
source full of links) validated under the worker's 8-second statement timeout.
`scripts/test-study-fold-parity.mjs` holds the SQL text functions to their TypeScript
counterparts; both run in `pnpm db:test`.

Nothing here adds a screen. The report, correction and withdrawal controls for lessons and
claims are in the guided course (see [`study-courses.md`](./study-courses.md#the-screens));
those for questions, and the server-side recorder that grades an answer and writes it down,
are the practice change's.

What this change settles is the rules those screens must obey. Status changes, the checks
and the proof rule live in the database, where no screen can skip them. What a learner is
_shown_ is a filter on status: the `study_visible_*` views apply it, and a screen that reads
the tables directly has to apply it itself.

## The lifecycle

Claims, lessons and questions share one lifecycle:

```
draft ──validate──► validated ──report──► suspended ──dismiss──► validated
  │                     │                     │
  └──► quarantined ─────┴─── retire / revise ─┴────────► retired
```

| Status        | Shown to a learner | Means                                                                                                                                                             |
| ------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft`       | no                 | Written by the worker and waiting for validation.                                                                                                                 |
| `rejected`    | no                 | Malformed when generated (`normalizeStudyCourse`). Kept for audit.                                                                                                |
| `quarantined` | no                 | Well-formed but failed a check below. Kept with its reasons for audit and human review; the reader can revise or retire a lesson or question, and retire a claim. |
| `validated`   | **yes**            | Passed every check, and nothing is holding it back.                                                                                                               |
| `suspended`   | no                 | Reported, or it rests on a claim that is reported or retired.                                                                                                     |
| `retired`     | no                 | Superseded by a corrected version, or withdrawn. Kept for its history.                                                                                            |

**Claims cannot be revised.** A claim can be reported, dismissed and retired, but not
revised; see [below](#reports-and-corrections). Only lessons and questions have versions.

**A report on a claim reaches everything built on it.** A lesson or question is suspended
while any claim it rests on is not `validated`. Reporting a claim therefore suspends every
lesson and question built on it in the same transaction. Dismissing the report restores
them. Retiring the claim leaves them suspended until each one is revised onto other claims
or retired.

**Course-level text is validated as one unit.** The course's own text is its title,
overview, objectives, recap, disagreements and withheld list. It has a status of its own,
`study_generations.text_status` (`pending`, `validated` or `quarantined`), and is shown
only when `validated`. The reader cannot revise it. When it is held back,
`study_visible_courses` still returns the course -- its goal, and through the other views its
lessons and questions -- with the title, overview, objectives, recap, disagreements and
withheld list reading as empty.

## The checks

The checks are deterministic and run in SQL. The worker's last step, `study_validate`,
calls `validate_study_course`. That function checks every draft claim, then every lesson,
then every question, then the course's own text. The order matters, because each level asks
about the one before. Only drafts move, so a retried step changes nothing.

A reader's revision runs the same functions, as the reader's (see below). Generated rows
can only start as `draft` or `rejected` -- a trigger refuses any other status, whichever
function inserts them -- and any change to a course's own text puts it back to `pending`.
So no path to a visible question, or to visible course text, skips them.

**A validation that fails is retried later.** If `study_validate` fails three times, or a job
finished under a worker older than that step, every row would stay a draft forever.
`validate_stranded_study_courses` validates any course whose job has finished, that was
persisted, and whose validation never finished, once it is ten minutes old. `text_status`
marks that last part: persisting a course puts it to `pending`, and the transaction that
moves the drafts settles it. It takes at most five a run, oldest first, and takes each
course's row without waiting: a course a deletion, a correction or the worker holds is left
for the next run, so the sweep never waits while holding another. A partial index on
persisted, pending courses keeps the candidates cheap to find; a course whose job failed
before anything was persisted is never one.
`enable_generation_sweeper()` schedules it
beside the stranded-job sweep, every five minutes by default. **Deploying this change
therefore requires re-running `select public.enable_generation_sweeper();`** after the
migrations, as `scripts/go-live.sh` lists.

| Check                                                                                                          | Applies to                                          | Reason                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A resolved evidence span.                                                                                      | Claim                                               | `evidence_missing`                                                                               |
| The span is still the stored text at its offsets.                                                              | Claim                                               | `evidence_mismatch`                                                                              |
| Rests on at least one claim, and all of them are validated.                                                    | Lesson, question                                    | `no_known_claims`, `cites_unvalidated_claim`                                                     |
| Its lesson, if it has one, is validated or suspended.                                                          | Question                                            | `lesson_unavailable`                                                                             |
| An answer, a prompt and an explanation, not only whitespace.                                                   | Question                                            | `answer_missing`, `text_missing`                                                                 |
| A title, objective, explanation and recap.                                                                     | Lesson                                              | `text_missing`                                                                                   |
| One correct choice: no wrong option folds to the answer or an accepted variant.                                | Choice question                                     | `distractor_matches_answer`                                                                      |
| Two to four distinct wrong options (so three to five choices), each with a rationale.                          | Choice question                                     | `too_few_distractors`, `duplicate_options`, `distractor_without_rationale`, `distractor_missing` |
| Accepted variants belong only to typed questions, and none folds to nothing.                                   | Question                                            | `accepted_answer_invalid`                                                                        |
| Exactly one blank.                                                                                             | Cloze                                               | `cloze_malformed`                                                                                |
| Neither the answer nor any accepted variant is printed in the prompt or cloze.                                 | Cloze, short recall                                 | `answer_in_prompt`                                                                               |
| The answer occurs in the text or evidence of the claims the question rests on.                                 | Cloze, and every typed answer of a reader's version | `answer_not_in_evidence`                                                                         |
| Three to six distinct steps; two to six pairs, with no side repeated.                                          | Ordering, matching                                  | `ordering_malformed`, `matching_malformed`                                                       |
| Nothing addressed to a model (a heuristic; see below).                                                         | All text, including a claim's quoted passage        | `instruction_like`                                                                               |
| No link that is absent from every one of the course's sources (a heuristic).                                   | All generated text except quoted passages           | `unsourced_link`                                                                                 |
| No bidi embeddings, overrides or isolates, byte-order mark, invisible operators, tag or annotation characters. | A reader's version                                  | `hidden_characters`                                                                              |

**How answers are compared.**

- **Folding.** Answers are folded the way `answerKey` in `supabase/functions/_shared/study.ts`
  folds them: NFKC, lower case, the same explicit punctuation removed, an apostrophe treated
  as a word break, and JavaScript's whitespace collapsed. A full stop between two digits is
  kept (1.5 is not 15), and any other full stop goes, so .5 is 5; a comma goes too (1,000
  is 1000). An answer that is only
  punctuation (`;` in a course on C) is kept as it is rather than folded to nothing. SQL's
  copy, `study_fold`, is an exact mirror. It lower-cases under the ICU root collation, so it
  folds final sigma and İ as JavaScript does whatever collation the database or the text
  carries. The parity test compares the two over every code point of the Basic Multilingual
  Plane that Postgres considers assigned, a sample of the astral planes, and curated cases.
  Every equality and distinctness check uses this fold, so ν and v, or ρ and p, stay
  different options.
- **Matching.** A phrase must match as whole words. A phrase containing any character of a
  script written without spaces (Han, kana, Hangul, Thai and its neighbours) matches as a
  substring instead, and a phrase that is only punctuation is looked for in the text with its
  punctuation kept. A decimal is one word: 125 is not found in 0.125, nor 14 in 3.14. So is
  any number written with full stops, which is a trade-off: 1989 is not found in 09.11.1989,
  so a dotted date does not give its year away, and a year whose evidence gives only the
  dotted date is not found in it. What counts as
  a word character (`\p{L}`, `\p{N}`, `\p{M}`) and which scripts are written without spaces
  are generated from the same Unicode properties study.ts uses
  (`scripts/study-unicode-classes.mjs`). So Hindi's danda ends a word in SQL as it does in
  TypeScript.
- **Containment reads more loosely in SQL, on purpose.** Finding one text inside another
  removes invisible format characters and folds Cyrillic and Greek look-alikes to Latin, so
  "rеstudying" with a Cyrillic е is still found in a prompt that says "restudying". For a
  give-away that makes the check stricter. For a reader's answer in the claims it makes the
  check more lenient -- "раris" in Cyrillic is found in "Paris" -- which is harmless: such
  an answer is still the claim's word, and a learner typing "paris" is not graded right
  against it.
- **Give-aways.** An answer counts as given away only once it is at least two characters in a
  script written without spaces, or at least three otherwise. That catches "DNA", but a
  two-letter answer in a spaced script ("pH") is never flagged.

**The two heuristics.** `instruction_like` and `unsourced_link` read text after NFKC and
lower-casing, with every invisible character removed -- `\p{Cf}` and
`\p{Default_Ignorable_Code_Point}`, tag characters, variation selectors and the combining
grapheme joiner included, generated by `scripts/study-unicode-classes.mjs` -- and the
ideographic full stop read as a full stop. `instruction_like` also folds the common Cyrillic
and Greek look-alikes of Latin letters, and reads the text a second time with each invisible
character as a space, so one standing between two words does not hide them either.
`unsourced_link` does not fold: a host may be written in any script, and a link is compared
as it is written, so `раураl.com` in Cyrillic -- bare, after `//` or after a scheme -- is a
different link from the `paypal.com` a source cites.

- **What `instruction_like` looks for.** Phrases an injected passage uses:
  - "ignore" or "disregard", then within a few words "previous", "prior", "above",
    "earlier" or "preceding", then within two more "instructions" or "prompts";
  - "forget everything above";
  - "new instructions:";
  - `### Instruction`;
  - a line starting "System:" or "Assistant:";
  - "system prompt" and "developer mode";
  - "act as an AI" and its variants;
  - "as an AI model";
  - chat-template tokens.

  Ordinary prose about systems, assistants or HTML is not flagged.

- **What `unsourced_link` finds.** Schemes, including `hxxps`, `https:host`, `mailto:` and
  `javascript:`; `data:` URIs; `//host`; `www.`; bare IP addresses with a path; and bare
  domains under common and abused top-level domains (`.zip`, `.shop`, `xn--` and others). A
  link counts as sourced if the same link appears in one of the course's sources, or if it
  is the bare host of a link that does. A different page on the same site is not sourced:
  a source citing one page does not vouch for the rest of the site.
- **What they miss.** A passage that brings its own link passes, because that link is in
  the source. So does text phrased in a way the patterns do not expect, and a trigger phrase
  spelled with look-alike letters outside the folded set -- a dotless ı, an Armenian օ, a
  Cherokee letter -- that NFKC leaves alone.
- **How cautious they are.** Deliberately. A source genuinely about prompt injection will
  have claims quarantined, which is where an adversarial item belongs. A false positive on a
  lesson or question is corrected by revising it (a lesson's unit title included); one on a
  claim, by retiring the claim. The evaluation contract
  ([`eval/study-quality.md`](./eval/study-quality.md)) reviews quarantined items too.
- **A quarantined lesson holds back its questions, for good.** Its questions are quarantined
  with it (`lesson_unavailable`), and revising or retiring the lesson does not bring them
  back: validation moves only drafts. Each must be revised -- which makes it the reader's,
  and practice only -- or retired. A unit title is copied onto every lesson in its unit, so
  one flagged unit title does this to the whole unit. Re-checking those questions when their
  lesson is corrected is left to the guided-course change that adds the correction screens.

**What the checks cannot decide.** Groundedness beyond the evidence span. Answerability,
except that a cloze's blank and a reader's typed answers must occur in the claims. Ambiguity,
and whether more than one answer is defensible. These remain human judgements under that
same contract.

## Reports and corrections

These are the reader's only write paths, and each one checks that the reader owns the
content it touches.

| Function                                       | Does                                                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report_study_content(kind, id, reason, note)` | Files a report. The target is suspended at once, before anyone decides whether the report is right.                                                                                             |
| `dismiss_study_report(report)`                 | The report was mistaken. The target is `validated` again, unless another report or an unvalidated claim still holds it.                                                                         |
| `retire_study_content(kind, id)`               | Withdraws a validated, suspended or quarantined target for good, and resolves its open reports as `retired`. Retiring a lesson keeps its live questions as course-level review, with no lesson. |
| `revise_study_item(item, revision)`            | Mints a corrected version of a validated, suspended or quarantined question (below). Resolves its open reports as `revised`, naming the new version.                                            |
| `revise_study_lesson(lesson, revision)`        | The same for a lesson. Its live questions move to the new version.                                                                                                                              |

**What can be reported.** A report's reason is one of `incorrect`, `unsupported`,
`ambiguous`, `unanswerable` or `other`, matching the questions the review rubric asks. A
report may carry a note of up to 1,000 characters. A report can be filed on a `validated`
target, or on one already `suspended` -- by an earlier report, or through a claim under it --
so a reader can add their own reason to one already held back.

**How reports are kept.** Reports stay after they are resolved, and the reader can never
edit or withdraw one. They are the audit trail for a suspension.

**Claims are reported or retired, never rewritten.** A claim is the source's own assertion,
tied to an exact passage. If the extraction got it wrong, the fix is to retire it.

**Locks.** A correction takes a per-reader advisory lock with `pg_try_advisory_xact_lock`, so
a second correction while one is running fails at once with 55P03 rather than queueing.
Then it locks the course, then the course's source versions `NOWAIT`. The course-then-versions
part is the order `persist_study_course` uses, so a correction deadlocks neither with deleting
a source nor with deleting the account.

**Limits,** per UTC day unless stated:

- 50 reports.
- 100 revisions, counting the reader's versions that still exist.
- 50 versions of any one lesson or question, in total.

**Size.** A revision is measured before anything else runs: at most 32 KB in total, and every
field within the limit the table holds it to.

- A question's prompt, answer and cloze: 1,000 characters each.
- Its explanation: 2,000 characters.
- Up to 6 accepted answers of 1,000 characters each.
- Up to 6 steps of 500 characters each.
- Up to 4 wrong options, with 1,000 characters for the option and 1,000 for its rationale.
- Up to 6 pairs of 300 characters a side.
- A lesson's unit title and title: 200 characters each. Its objective: 500. Its
  explanation: 6,000. Its example: 2,000. Its recap: 1,000.

**Revision keys.**

- Questions: `prompt`, `answer`, `acceptedAnswers`, `distractors` (`[{text, why}]`), `cloze`,
  `sequence`, `pairs` (`[{left, right}]`), `explanation` and `claimIds`.
- Lessons: `unitTitle`, `title`, `objective`, `explanation`, `example`, `recap` and
  `claimIds`. A unit title is stored on each lesson, so correcting it on one lesson leaves the
  unit's other lessons as they are.
- Given fields replace the old ones and absent fields are kept.
- A question's kind, purpose, difficulty and lesson are kept, because a different kind of
  question is a different question.
- An unknown key is refused.

**Errors:**

- **28000:** not signed in.
- **P0002:** no such content in your courses. It is also returned when the content is someone
  else's, so it reveals nothing, and when the content was deleted mid-call.
- **22023:** malformed or oversized input, or a revision that fails a check. For a failed
  check the reasons are listed in the error's DETAIL.
- **55000:** the target is in a status the call cannot act on.
- **54000:** a limit.
- **55P03:** another correction is running, or a source deletion is in flight.
- **23503:** from the worker's `validate_study_course`, when the course was deleted before
  it ran.

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
- **Refused whole.** A revision that fails a check is refused, and nothing changes.
- **Checked as the reader's.** A reader's version may not contain characters that make text
  read differently from how it is stored: bidi embeddings, overrides and isolates, the
  byte-order mark, invisible operators, tag and interlinear-annotation characters. The marks
  right-to-left writing needs (LRM, RLM and the Arabic letter mark) stay allowed, as do the
  joiners and soft hyphen ordinary text uses. Its typed answers must occur in the claims it
  rests on.
- **Practice, not proof.** A reader's version is never proof of recall (below). No check on
  text can stop an author knowing their own answer, so a correction can make a question
  better to practise with but cannot make the reader's mastery easier to claim. The cost: a
  claim whose model-written questions have all been revised or retired -- a quarantined false
  positive the reader corrected included, and every question of a quarantined lesson -- has
  no path to proof until a later generation gives it one.

## The status log

`study_status_log` holds one row for every status a claim, lesson or question has had:

- **Rows start with the first status.** A row records the status the item was created in,
  then every change after it.
- **Each change says why.** The reason is one of `generated`, `validation`, `reported`,
  `claim_reported`, `report_dismissed`, `retired`, `claim_retired`, `revised`, or `updated`
  for a change made outside these functions.
- **Written by trigger.** No path can change a status without leaving a row.
- **Append-only.** A trigger refuses any update, and no API role, not even the service role,
  can write to it.
- **Timestamped by clock time, not transaction time.** The proof rule can then ask what a
  question was at the instant it was answered.

## What counts as recall

`study_answer_events` records answers to generated questions. Each answer names the version
it answered, not its lineage.

- **Append-only.** A trigger refuses any update.
- **The database stamps the time.** A trigger sets `answered_at` to the database's clock
  whatever the caller passes. It first waits for any status change in flight on the
  question, so an answer can be neither back-dated into a validated window nor slipped into
  the gap before a report or dismissal commits.

**There is no reader write path, and none for the service role.** `recall_events`, the feed's
table, accepts rows straight from the browser, grade and all. Generated material must not
work that way, because this table is what "you know this" will be decided from. The
practice change adds a recorder that grades the answer on the server, as a definer
function. Until then, nothing but the database owner can insert.

`study_answer_proves_recall(event_id)` is the one definition of proof. It reads the event
itself, under the caller's rights, so an event the caller cannot read is not proof.
`study_proven_claims()` lists the claims a reader has proven. An answer proves recall of the
claims its question rests on only when all of these hold:

- **It was a real retrieval.** It is correct, unhinted, and graded deterministically. A
  self-graded answer is practice and a hinted one is recognition; neither is proof.
- **The model wrote the question.** An answer to a reader's own corrected version is
  practice. The claims it rests on are proven through the course's model-written questions.
- **The question was `validated` when it was answered.** A draft, a quarantined question, or
  one suspended by a report does not count, even after the report is dismissed.
- **The question is still `validated` now.** A retired version proves nothing, of itself or
  of anything else, and an answer to one version never counts for another. A version
  reported since the answer proves nothing while the report stands.
- **Every claim it rests on is `validated` now.** A claim leaving that state suspends the
  question in the same transaction, so this clause is a second guard behind the previous one.

`supabase/tests/study_validation.sql` checks each case in the list above:

- a retired version;
- a suspended question;
- an answer given while suspended, before and after a dismissal;
- an answer given while a draft;
- an answer to a quarantined question;
- a hinted, a self-graded and a wrong answer;
- a correct answer to a reader's own version;
- a claim suspended under a question.

The practice, scheduling and Delta changes must build on this function rather than on their
own reading of the table. `study_proven_claims()` applies the same clauses in one set-based
query, for speed, and the test suite checks it agrees with `study_answer_proves_recall`
claim by claim.

## Privacy

- **Owner-scoped.** Reports (with their notes), the status log and answers are owner-scoped
  under RLS. A reader reads their own rows and cannot write any of them directly.
- **Exported.** All three are in the account export.
- **Deleted with the material.** They go with the generation of the course they belong
  to, which deleting any of its sources removes, with the course, and with the account.
- **Not reviewed by us.** A study report is about the reader's own private course.
