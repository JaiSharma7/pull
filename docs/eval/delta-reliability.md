# Delta reliability: evidence, review, and rollout

This change makes false suppression the first risk to control. A vector can retrieve
candidate relationships and rank feed cards, but cannot prove that two claims mean
the same thing. A close contradiction therefore remains visible unless the reader
has separately established knowledge of that very idea.

## Active decision

The append-only migrations dated 20260922120000, 20260922230000,
20260923010000, and 20260923020000 replace the final get_feed from
20260909050000 and get_source_delta from 20260830222533. Both require a
knowledge state above the existing 0.7 retrievability floor plus the latest
relevant recall event: good/easy review, recall, or say-it-back; or easy on the
explicit “Already knew it” Delta probe. A later server-applied forgot/hard answer removes that
evidence, even if the state remains highly stable. A delayed offline success
submitted before that failure cannot revive it. An old success expires from its
recorded event time and stability: opening the card cannot refresh that proof.
Legacy events without recorded stability remain unverified until fresh recall. Calibration, conviction,
counterpull, opening, reading, saving, and impressions do not prove knowledge.

Direct knowledge is never subject to the 500-idea semantic comparison cap.
Reviewed equivalence can suppress only when one endpoint belongs to the
strongest 500 above-floor knowledge states and has recall evidence. The cap is
applied before the event-history probe; an unproved state inside it is not
replaced by a weaker state beyond it. This conservatively leaves some redundant
ideas visible as a reader's history grows. Null embeddings stay in that set: a reviewed equivalence is
usable without vectors. Missing embeddings and missing equivalence edges never
cause semantic suppression. Authored opposition and approved opposition work in
either stored direction for ranking and veto any conflicting equivalence for the
same pair. The user's knowledge centroid, topic preferences, dwell, prior
impressions, and muted sources retain their ranking and eligibility roles.

The new relationship table links Pulls, not normalized claims. Its unordered
pair key prevents duplicate or contradictory proposed kinds for one pair.
Only an approved equivalence suppresses; approval requires evidence, a review
timestamp, and at least one human reviewer reference. A single-reviewer
equivalence additionally requires an explicit review note. Assistant critique
is not counted as a reviewer. Approval of an uncertain or directionless elaboration label is
forbidden. Disabling a bad edge immediately removes its read-path effect
without touching any reader's knowledge history. The table permits readers
to see an approved relation only when both endpoint summaries are readable under RLS;
authenticated readers cannot write, truncate, or trigger it. A follow-up
migration revokes inherited table privileges and grants only SELECT; it also
stamps updated_at on relation review changes.

The Feed's matched count covers directly known ideas in the bounded candidate
pool plus reviewed equivalences in the shortlist. At the default limit, the
pool can contain 800 ideas and the shortlist 400; neither count means
“cards removed from the 20 displayed.” Pull IDs break equal-score ties at
each feed sort boundary. Candidate pools may overlap across pagination, so the UI reports the latest search instead of summing pages.
The minutes value sums stored estimated reading seconds for those matches and
is not measured elapsed time saved. The Source page asks get_summary_delta
for the selected published summary it displays. The Library uses
get_source_delta for all readable published versions of the work. “Unverified”
means no proof of knowledge,
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
comparisons to 100 and applying the known-state cap before history probes,
ten repeated calls measured Feed p50 216.6 ms and p95 233.4 ms;
work-wide Source Delta p50 40.7 ms and p95 43.9 ms. An earlier single
unbounded-ranking run took about 778 ms for Feed. These are local synthetic
vectors, not hosted user latency or a release threshold. Re-run
scripts/bench-delta-709.sql in CI or staging and measure real reader cohorts
before setting a latency gate.

The existing cost ledger records 213 synthesis calls at median 1.2970 cents
and 202 embedding calls at median 0.0049 cents. These are measurements of
different operations, not a price estimate for relationship classification.
The current proposal backfill makes no provider calls, so its provider spend
is zero. Human review time is still an unknown input. At most six neighbors per anchor means at most 4,254 directed candidates for 709 anchors before unordered-pair deduplication; actual proposals can be much fewer. Review cost = proposal count × one human review × measured minutes per review × reviewer hourly cost / 60, plus time to resolve challenged labels. Measure those inputs before budgeting the full backfill.

## Pilot evaluation

The 31 rows in docs/eval/delta-pilot-candidates.json represent 24 distinct
public-catalogue pairs: two anchors per selected topic, each with a nearest
cross-source neighbor, plus the existing opposition. Seven rows repeat a pair
under another topic. Selection covers large, middle, and small topics. The
query in scripts/delta-pilot-candidates.sql regenerates it. The product owner
labeled all 24 distinct pairs in docs/eval/delta-pilot-review.csv: one same
claim, 15 related but distinct, and eight unrelated. No contradiction or
elaboration was confirmed, so this pilot cannot establish those metrics.
These are single-human labels, not independently adjudicated ground truth.

The product owner is the sole human reviewer for this pilot. The assistant
compares full public Pulls and challenges doubtful labels, but its judgments
are not a second human vote. The initial contradiction label for the one
paraphrase was changed to same claim after comparing both Pull bodies. The
worksheet records the owner's agreed labels; supporting source passages or
a reason provenance is unavailable still need to be recorded before any edge
is approved. A reviewer labels one of: same claim, related but distinct,
contradiction, elaboration/narrower claim, unrelated despite similar wording,
or uncertain; the direction for elaboration and whether proven knowledge
should hide the candidate are separate decisions. Keep rejected and uncertain
proposals for audit. The new migration permits one documented human review,
but these pilot labels are provisional and have no read-path effect until a
relation is separately approved and the migration is deployed.

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

1. Complete the single-human pilot and expand the reviewed sample until it
   includes real contradictions and elaborations. Record source evidence,
   baseline metrics, and representative latency under real RLS. Verify the
   one-human approval rule and its evidence requirement before activating edges.
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


## Expanded public review queue (2026-09-23)

A read-only export of the hosted public catalogue retrieved 709 ideas across
217 works; all 709 had embeddings. Applying the same four nearest cross-work
and two nearest within-work selection as scripts/delta-proposals.sql produced
4,220 directed neighbors. After unordered-pair deduplication and exclusion of
the 24 reviewed pilot pairs, docs/eval/delta-review-queue.csv contains 2,897
unlabeled candidate pairs. It contains only public Pull IDs, headlines, source
titles, distances, and review fields; no private reader data or vectors are
exported. Its ordering puts each anchor's nearest neighbors first. A queue
entry is a retrieval candidate, never a generated or approved relationship.

At one minute per pair, reviewing all 2,897 would take about 48 hours; at
two minutes, about 97 hours. Those are workload scenarios, not measured review
times. Work through small, varied batches with the single human reviewer and
stop once evaluation evidence is sufficient. The first 24-pair pilot found
only one same-claim pair and no confirmed contradiction, so a larger selected
sample is needed before release thresholds can be set.
