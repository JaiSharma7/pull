# Study generation

A reader's own source versions become a claim map with exact evidence, then a draft
course: an overview, objectives, short lessons, and varied questions, each tied to the
claims it rests on. This page covers the generation half; what a learner may be shown, and
how a reader corrects it, is [`study-validation.md`](./study-validation.md). The guided
course and practice come in later changes, so nothing is shown to a learner yet.

## The pipeline

```
enqueue_study_generation          1-5 of the reader's versions, a goal, consent
        │
study_prepare                     plan bounded windows over the versions   (no model)
        │
study_extract                     ExtractStudyClaims, once per window      (cached)
        │                         one call per invocation; re-sends itself until done
study_assemble                    AssembleStudyCourse over grounded claims (cached)
        │
study_ground                      resolve evidence, check, write rows      (no model)
        │
study_validate                    validated or quarantined, checks in SQL  (no model)
```

The steps run on the same worker, queue and dispatcher as the canonical pipeline, as a
separate graph (`supabase/functions/_shared/study-graph.ts`). A message names its step,
and a `study_*` step belongs to that graph.

**Two model calls, split for cost.** `ExtractStudyClaims` reads one window of one version
(at most 30,000 characters, ending at a paragraph or sentence break where one falls in
the last fifth) and is independent of the goal, so its output is reused by every course
built from that version. `AssembleStudyCourse` reads only the grounded claims and their
quoted evidence, never the source text, so its input stays small. At the source limits
(five versions, 200,000 characters) a course is at most thirteen extraction calls and one
assembly.

Both functions live in `packages/prompts/baml_src/study_course.baml` and reach the worker
through `pnpm baml:export`, like the canonical summary.

## Evidence

A model cannot count characters, so a claim's evidence is a **verbatim quote**, and the
worker finds it (`resolveQuote` in `_shared/study.ts`): exactly first, then with
whitespace, quotation marks, dashes and case folded, in the window the claim came from
before the rest of the version. What is stored is the source's own text at that span
(`span_text`), its offsets in **Unicode code points** (the unit Postgres `substr` counts),
the page for PDF sources, and whether the match was exact or folded. The model's own quote
is kept beside it.

A claim with no quote that resolves is **rejected** (`evidence_missing`), kept for the
audit, and never shown to the course assembly. `persist_study_course` re-checks every
resolved span against the stored version with `substr` and refuses the whole payload if
one does not match, so a span in the database is the stored text by construction, not by
the worker's arithmetic.

Finding the quote proves that the words are in the source. It does not prove that they
support the claim, or that a question is fair. Those are human judgements, and
[`docs/eval/study-quality.md`](./eval/study-quality.md) is where they are made.

## What is checked, and what is not

`normalizeStudyCourse` applies the rules a machine can decide without judging meaning,
and keeps a failing question or lesson as `rejected` with its reasons:

| Rule                                                                      | Reason                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| cites at least one claim the assembly was shown                           | `no_known_claims`                                                       |
| a choice question has two to four distinct wrong options, none the answer | `too_few_distractors`, `distractor_matches_answer`, `duplicate_options` |
| every wrong option says why it is wrong                                   | `distractor_without_rationale`                                          |
| a cloze has exactly one blank and does not print its answer               | `cloze_malformed`, `answer_in_prompt`                                   |
| an ordering has three to six distinct steps                               | `ordering_malformed`                                                    |
| a matching has two to six pairs with no side repeated                     | `matching_malformed`                                                    |
| a short answer does not appear in its own prompt                          | `answer_in_prompt`                                                      |
| text fits its column                                                      | `too_long`                                                              |

Everything that passes is `draft`, which means _well-formed and pending validation_, not
correct. `study_validate` then decides, by deterministic checks in SQL, which drafts are
`validated` (shown) and which `quarantined`; see [`study-validation.md`](./study-validation.md).
Groundedness beyond the span, ambiguity and multiple defensible answers remain human
judgements, and the release gate is the human-reviewed fixture.

Unanswerable questions the reader's goal invites are **withheld**, not written: the model
records them with a reason in `study_generations.withheld`. Disagreements between sources
are recorded with the claims on each side and never resolved.

## The worked example

A reader imports a self-authored note about Roediger and Karpicke's prose-memory
experiment: repeated study helped more on a test five minutes later, prior retrieval
helped more at two days and one week, under the reported conditions.

- Extraction yields the method, the five-minute finding and the delayed finding, each with
  its qualification and a quote that resolves to the exact span of the note.
- A claim the note does not make ("retrieval practice works better for every learner") has
  no quote that resolves, so it is rejected and the assembly never sees it.
- The course teaches the immediate-versus-delayed contrast in one short lesson citing the
  grounded claims, with a placement question on the one-week result, practice of the
  five-minute exception in another form, and a review question that asks for the contrast
  without showing it.
- A question leaning on the invented claim cites a key the assembly was not shown and is
  rejected. "Does retrieval work better for everyone?" is withheld: the note describes one
  group under reported conditions.

This example is `study-steps.test.ts` ("the worked example, through Gemini and the
journal") and `scripts/test-study-generation.mjs`, which runs it against the real database.

## Cost, and accounting for every attempt

**Nothing runs in a read path.** Reading, question selection, grading and scheduling are
rows and arithmetic. A model runs only in `study_extract` and `study_assemble`.

**Every provider attempt is journalled before it is sent.** The worker's transport
(`_shared/provider-journal.ts`) writes a `provider_calls` row, then sends; if the row
cannot be written, nothing is sent, and a host that is not a model provider is refused.
This is the independent inventory the evaluation contract asks for: it is written by the
transport, not by the accounting.

**Every attempt is ledgered, keyed to its journal row.** The Gemini adapter
(`_shared/structured.ts`) returns one record per HTTP attempt -- the 503 it retried, the
429 that moved to the next model, a request aborted at its timeout -- and
`record_study_stage` writes one `cost_ledger` row for each, with `provider_call_id`, in the
same transaction as the cache entry. It refuses a record for a call the journal never saw,
and a replay neither doubles a charge nor adds it to the job twice. A charge is never
rolled back because the reader deleted the material mid-call (only the cache entry is
skipped), nor because they deleted their account (the attempt is ledgered with no job).

An attempt that reached the provider without reporting usage -- sent and then aborted at
its timeout, or answered with a body that could not be read -- is charged at the ceiling
its hold was sized to, with `usage_known = false`. Recorded at zero it would have
released its hold and let the day's total forget money that may have been spent; a
report can still tell a ceiling from a measurement by the flag. The one network failure
that is known to be free is a connection that never opened -- refused, a DNS failure, a
TLS failure, a connect timeout (`isConnectPhase` in `_shared/provider-journal.ts`, which
reads the error codes Node reports and the message Deno does) -- because nothing was sent.
It is recorded at zero with its usage known, and retried once on the same model. Any
other network failure, and any error shape the classifier does not recognise, may have
been sent and is charged at the ceiling. After an attempt of unknown cost the call stops
rather than retrying or moving to the next model, so one hold never covers two attempts
that may have been billed; answers of known cost (a 5xx, a 429) still retry. A redirect
is not followed: it is recorded as an answer of known zero cost.

**Reconciliation.** `study_provider_call_audit(since)` reports journalled attempts, ledgered
attempts, journalled attempts with no ledger row (should be zero), attempts left open by a
worker that died mid-call, and attempts of unknown cost. Anything but zero in the third
column is an alert.

**The budget.** Each call reserves its worst case immediately before it is sent (the
provider's output ceiling plus the byte length of the prompt and schema) and is refused
into a budget wait when the global daily cap cannot fund it, or when the reader's own
share of study spend cannot (`study_requester_daily_cap_cents()`, 60 cents: their study
jobs' ledger today plus their open holds). The share exists because the cap bounds what
the product spends and is not a fairness mechanism: without it, one maximal course --
fourteen successful calls, thirteen windows and an assembly, plus any failed attempts
charged at their ceiling -- could reach the cap and close the door on every reader until
00:00 UTC. It also bounds what a reader's failing jobs can charge at the ceiling. Both
checks are made by `reserve_budget` itself, under one lock, for every study job;
`reserve_study_budget` is the worker's entry point and adds only the refusal of a job that
is not a study job, so no caller can take a study hold that skips the share.

A share smaller than one call's ceiling would make that call wait for ever, so the
ceilings are bounded too. A window is at most 30,000 code points. The claims digest the
assembly reads is at most 200,000 UTF-8 bytes (`STUDY_LIMITS.maxDigestBytes`): at most two
evidence spans per claim, each cut to 600 characters, and the even spread of claims
thinned until it fits. At default prices that puts the largest extraction's ceiling near
24 cents and the largest assembly's near 31 (a digest at exactly its limit, under a goal
at its limit; the header of `20260925040000` says 28, which is what a digest of maximal
claims reaches, not the bound), and `study.test.ts` pins that the two together fit the
share as the latest migration defines it. A large course can still meet its reader's
share part-way; the step then waits as any budget wait does, every fifteen minutes, and
goes on after 00:00 UTC. The wait count starts again after each window that goes through,
so a course that needs its reader's share on a further day waits for that day too.
Raising `GEMINI_MAX_OUTPUT_TOKENS` or the prices far
past their defaults fails that test until the share is raised with them.

The worker settles each hold
exactly once, on its way out of the invocation -- through `record_job_step`, the failure
path, or explicitly when `study_extract` asks to be sent again -- and never inside
`record_study_stage`, because one settle too many releases a share of a hold that another
delivery of the same step may still be spending under.

**Retries are bounded per step, not per window.** Only a failed attempt writes a
`job_steps` row, so `MAX_ATTEMPTS` (three) counts failures across the whole extraction:
a job whose windows fail three times in total fails, however many windows succeeded in
between. That errs toward stopping spend on a source that keeps failing, and a failed
job's cached windows are reused if the reader asks again. `enqueue_study_generation`
refuses at the door when the day cannot fund `study_min_job_cents()` (31: one minimal
extraction and one minimal assembly), and counts a study job against the same per-reader
allowance as every other generation job: three fast a day, a stagger past that, fifty in
total.

**Caching.** A stage's output is cached per reader under a SHA-256 of the stage, the
exported prompt and schema, the provider and models, and the exact input -- the version
and window for an extraction; for an assembly, the goal, the claims digest and the sorted
ids of every version in the course, so a course over different material never reuses an
assembly whose digest happens to match, and the entry is linked to each of those
versions so deleting any one removes it. An unchanged
version under an unchanged prompt, schema and model costs nothing to reuse; an edit to the
BAML source changes the hash and invalidates the entries made under it. The reader is in
the key and in the table's unique constraint, so one reader's entry never answers another
reader's lookup.

### What to measure

The ledger and journal make these computable per run; none is claimed here, because no
hosted run has happened.

- **Imported source cost** -- every billed extraction attempt for the source, plus the OCR,
  worker and storage share. Browser OCR and extraction are free to the product.
- **Course cost** -- source cost plus the assembly attempts, divided by usable validated
  output; report mean, median, p95, and the spend of failed jobs.
- **Regeneration cost** -- every billed attempt for a changed version, prompt, schema or
  model. An unchanged cached version incurs no new provider cost.
- **Active learner cost** -- new or changed private generation plus allocated public
  generation and infrastructure, over active learners in the same period.

`scripts/study-eval-export.mjs` turns the journal and ledger for a set of jobs into the
input `scripts/study-eval.mjs` reads, with `providerAttemptIds` taken from the journal and
the attempts and ledger rows from `cost_ledger`, so the ledger-completeness gate compares
two independently written records.

## Privacy

- The job's `target` holds only the generation id. The goal lives on `study_generations`
  and the text on the versions; step outputs carry ids and counts only.
- Every derived row is owner-scoped under RLS and joined to its version by a composite
  foreign key on `(version, owner)`, so the database refuses a row whose owner is not the
  version's. Readers can read their own rows and write none directly.
- Deleting any source of a course deletes the whole course and every cache entry derived
  from it, and cancels a job still running. Account deletion cascades. The account export
  includes every table.
- The journal and ledger keep no content. They outlive the material, because the charge
  happened.
- Generation is behind `study_generation_access`, a beta allowlist the service role
  manages, and requires the reader's explicit consent to send the chosen text to the model
  provider. See [`privacy.md`](./privacy.md).

## Not yet

- Course containers, progress events, and the learner-facing screens.
- An Anthropic fallback for the study stages: the adapter journals and ledgers per attempt,
  and the Anthropic provider has not been taught that yet. When every Gemini model is
  unavailable, a study step fails and is retried like any other unbilled failure.
