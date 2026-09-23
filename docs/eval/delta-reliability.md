# Delta reliability: evidence, review, and rollout

This change makes false suppression the first risk to control. A vector can retrieve
candidate relationships and rank feed cards, but cannot prove that two claims mean
the same thing. A close contradiction therefore remains visible unless the reader
has separately established knowledge of that very idea.

## Active decision

The append-only migration dated 20260922120000 replaces the final get_feed from
20260909050000 and get_source_delta from 20260830222533. Both require a
knowledge state above the existing 0.7 retrievability floor plus the latest
relevant recall event: good/easy review, recall, or say-it-back; or easy on the
explicit “Already knew it” Delta probe. A later forgot/hard answer removes that
evidence, even if the state remains highly stable. An old success also expires from its event time: opening the card cannot refresh that proof. Calibration, conviction,
counterpull, opening, reading, saving, and impressions do not prove knowledge.

Direct knowledge is never subject to the 500-idea semantic comparison cap.
Reviewed equivalence can suppress only when one endpoint belongs to that capped
proven-known set. Null embeddings stay in that set: a reviewed equivalence is
usable without vectors. Missing embeddings and missing equivalence edges never
cause semantic suppression. Authored opposition and approved opposition work in
either stored direction for ranking and veto any conflicting equivalence for the
same pair. The user's knowledge centroid, topic preferences, dwell, prior
impressions, and muted sources retain their ranking and eligibility roles.

The new relationship table links Pulls, not normalized claims. Its unordered
pair key prevents duplicate or contradictory proposed kinds for one pair.
Only an approved equivalence suppresses; approval requires evidence, a review
timestamp, and two distinct reviewer references. Approval of an uncertain label is
forbidden. Disabling a bad edge immediately removes its read-path effect
without touching any reader's knowledge history. The table permits readers
to see an approved relation only when both endpoint summaries are readable under RLS;
authenticated readers cannot write it.

The Feed's matched count covers directly known ideas in the bounded candidate
pool plus reviewed equivalences in the shortlist. At the default limit, the
pool can contain 800 ideas and the shortlist 400; neither count means
“cards removed from the 20 displayed.” Candidate pools may overlap across
pagination, so the UI reports the latest search instead of summing pages.
The minutes value sums stored estimated reading seconds for those matches and
is not measured elapsed time saved. A Source Delta counts all published,
readable ideas attached to that source; “unverified” means no proof of knowledge,
not proof that the idea is unfamiliar. Search and Topic still receive the older
knowledge-state annotation from their own RPCs; their labels now say “in your
learning history” because a read or calibration can create that state without
proving recall.

## Hosted catalogue baseline

Read-only aggregate audit on 2026-09-22, before this migration:

| Measure                                               |                                         Result |
| ----------------------------------------------------- | ---------------------------------------------: |
| Published public sources / ideas / represented topics |                                 217 / 709 / 35 |
| Public ideas with / without embeddings                |                                        709 / 0 |
| Ideas linked to a generation job / with no job link   |                                       675 / 34 |
| Unique public relation pairs by kind                  | ancestor 1, descendant 1, opposes 1, related 1 |
| Ideas per source, min / p25 / median / p75 / max      |                              1 / 3 / 3 / 4 / 6 |
| Ideas on sources lacking source_url                   |                        696, across 207 sources |
| Ideas lacking a citation anchor                       |                                            709 |

Topic counts and relation coverage by topic are reproducible from
scripts/delta-catalogue-audit.sql. A topic can contain an idea from a source
classified under several topics, so summing topic rows is not a catalogue
count. Generation-job linkage does not prove the unlinked 34 ideas were
hand-seeded, and there is no per-vector origin tag to distinguish a synthetic
vector from a real one reliably. Do not claim that distinction from these
aggregates.

The sparse relations and missing provenance limit how confidently an
automatic classifier could approve a pair. The pilot therefore uses people
to review public claims before any edge affects a reader. No private reader
text or credential was exported in this audit.

A local, transaction-rolled-back benchmark built 709 public ideas and 500
proven-known ideas under authenticated RLS. After bounding ranking-only vector
comparisons to 100, ten repeated calls measured Feed p50 271.8 ms and p95
314.2 ms; Source Delta p50 54.6 ms and p95 59.9 ms. An earlier single
unbounded-ranking run took about 778 ms for Feed. These are local synthetic
vectors, not hosted user latency or a release threshold. Re-run
scripts/bench-delta-709.sql in CI or staging and measure real reader cohorts
before setting a latency gate.

The existing cost ledger records 213 synthesis calls at median 1.2970 cents
and 202 embedding calls at median 0.0049 cents. These are measurements of
different operations, not a price estimate for relationship classification.
The current proposal backfill makes no provider calls, so its provider spend
is zero. Human review time is still an unknown input. At most six neighbors per anchor means at most 4,254 directed candidates for 709 anchors before unordered-pair deduplication; actual proposals can be much fewer. Review cost = proposal count × two reviews × measured minutes per review × reviewer hourly cost / 60, plus adjudication time. Measure those inputs in the 31-pair pilot before budgeting the full backfill.

## Pilot evaluation

The 31 rows in docs/eval/delta-pilot-candidates.json and the blank reviewer worksheet in docs/eval/delta-pilot-review.csv are a deterministic,
unlabeled queue drawn from the hosted public catalogue: two anchors per
selected topic, each with a nearest cross-source neighbor, plus the existing
opposition. Selection covers large, middle, and small topics. The query in
scripts/delta-pilot-candidates.sql regenerates it. No model-generated label
is ground truth.

Two reviewers independently read the full Pulls and, where available, the
source material. Each records one of: same claim, related but distinct,
contradiction, elaboration/narrower claim, unrelated despite similar wording,
or uncertain; the direction for elaboration; supporting passages or a reason
why provenance is unavailable; and whether the candidate should be hidden
given proven knowledge of the other claim. Disagreements go to a third
adjudicator. Equivalent edges require agreement on the same claim, not merely
the same topic. Reviewer identities and final evidence are recorded on the
approved row. Keep rejected and uncertain proposals for audit.

The public catalogue currently has no missing embeddings. Test that failure
mode and the two-private-reader isolation case in the transaction-rolled-back
RLS fixture, not by exposing private content to the pilot file. Most pilot
pairs lack relation edges; reviewers should flag those. Build the adversarial
set only after human labels identify a real contradiction whose cosine
distance is lower than that of a real paraphrase. The database fixture also
constructs this ordering to prevent regression, but it is not a substitute
for a reviewed catalogue example.

Report separately: false suppression among non-equivalent pairs, missed
suppression among equivalent pairs, contradiction visibility among eligible
contradictions, feed/source decision disagreement for the same reader and
idea, reviewed relation coverage by topic and kind, and p50/p95 read-path
latency at 709 ideas and a capped 500-idea known set. False suppression and
hidden contradictions have the highest product cost. Record the baseline and
reviewed sample size before setting numerical release thresholds. Do not
convert 31 unlabeled candidates into an accuracy claim.

## Bounded proposal backfill

scripts/delta-proposals.sql defaults to a dry run over ten public idea
anchors. It retrieves at most four nearest cross-source and two nearest
within-source neighbors per anchor. The ordered UUID cursor, printed as
next_after_id, resumes the next batch. A batch is capped at 100 anchors.
The unordered pair key and conflict handling make replay idempotent.
The output reports anchors scanned, candidate pairs, new proposals, and
pending proposals. A committed batch still inserts only uncertain proposals;
a second run of the same slice inserts zero. Check the pending count and
cursor after any interruption. This is candidate selection, not a blind
all-pairs classification.

Run against a local or staging database first. For a hosted run, inspect a
dry run, supply an explicit database URL through the operator environment,
then run with delta_dry_run=off. Do not run this script against the hosted
project until the migration passes the PR gate and is deployed. Only public
published ideas are selected. A reviewer may approve equivalent or opposed
pairs after checking evidence; related and elaborates labels remain available
for future discovery features but do not suppress. Change a bad approved
row to disabled and record the correction in review_note. The reader's recall
events and knowledge states are untouched.

This release uses human classification and has no new BAML output or model
call. If reviewer throughput later requires model-assisted proposals, add a
BAML structured classification function in a separate PR; use these bounded
candidate pairs, retain evidence and provenance, reserve budget before each
call, record every attempt in the cost ledger, and keep model output in
proposed status until human review. The read path must never call BAML.

## Rollout gates

1. Complete two independent labels and adjudication for the public pilot;
   record the baseline metrics and representative latency under real RLS.
2. Merge only after required CI, opening Codex review, and a clean parallel
   specialist review round under AGENTS.md.
3. Deploy the migration and copy together; monitor feed/source consistency,
   false-skip reports, read latency, and the candidate count wording.
4. Dry-run and commit a small representative proposal slice, review it, and
   compare against the pilot before generating the remaining proposals.
5. Expand by bounded batches only while reviewed false suppression,
   contradiction visibility, latency, and reviewer throughput meet thresholds
   set from the baseline. Disable a bad edge instead of deleting history.

No hosted database rows were changed while preparing this implementation.
