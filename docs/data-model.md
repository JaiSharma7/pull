# Data model

46 tables in `public`, created by the timestamped migrations in `supabase/migrations/`
(`YYYYMMDDHHMMSS_name.sql`, applied in filename order). Every one has RLS enabled with
at least one policy, every foreign key has a supporting index, and every
`SECURITY DEFINER` function pins its `search_path`. CI check 4 replays the whole thing
from zero and asserts all of that.

The Shape below is the list, not an illustration of it. If it and the count disagree, the
Shape is the one to trust and the count is the one to fix — the previous number survived
being wrong precisely because the diagram had drifted with it and the two still agreed.

## Shape

```
User
 ├── profiles · preference_profiles · follows
 ├── stashes ─── saved_items · notes · highlights
 ├── history_events · progress
 ├── knowledge_states · user_knowledge_vectors    ← the Delta & Half-Life
 │    └── recall_events                          ← one row per attempt; append-only
 ├── convictions · explanations                   ← Conviction Ledger & Say It Back
 ├── session_seeds · interrupt_events             ← Interleaved Recall
 ├── imports ─── import_items                     ← highlights you kept
 ├── user_questions                               ← questions you wrote yourself
 └── feed_recipes · feed_impressions

Work                                              ← the thing itself
 ├── editions                                     ← its concrete forms
 ├── work_contributors ─── contributors
 ├── work_topics ─── topics (hierarchical)
 └── summaries                                    ← one versioned interpretation
       ├── pulls                                  ← one idea; what the feed serves
       │    ├── citation_anchors                  ← claim-level provenance
       │    ├── pull_relations                    ← lineage + counterpoints
       │    └── quiz_questions
       └── artworks

generation_jobs ─── job_steps ─── cost_ledger
reports ─── moderation_decisions · rights_requests
daily_pulls · interleave_config · rate_limits
blocked_email_domains                             ← refused at signup
```

## Decisions worth knowing

**Work vs. Edition.** _Blade Runner_'s three cuts and a book's four ISBNs are
distinct `editions` rows under one `works` row. Without this a citation can only
point at a title string; with it, it points at a real page in a real printing.

**Summaries are structured, not markdown.** `elevator_pitch`, `why_it_matters`
and a `sections` JSONB array rather than one blob. This is what makes the Depth
Dial free — the 30-second, 3-minute and 15-minute views are different subsets of
the same record, not separate generations. `sections` is JSONB because the shape
belongs to the medium: a paper has Method/Findings/Limitations where a film has
Themes/Craft/Context.

**Every grade is an event before it is a number.** `recall_events` keeps one row per
attempt — grade, stated confidence, what was typed, stability before and after, and
the `client_mutation_id` the client minted for it. `grade_recall` inserts that row
before it touches `knowledge_states`, so a retry of a lost response finds its own row
and returns the state untouched. The log is append-only through the API and is the
evidence a scheduler change is judged against.

**An imported highlight is an ordinary pull.** `commit_import` writes the same
works/summaries/pulls triple the pipeline does: a `works` row marked `user_owned`, a
summary the reader authors at `visibility = 'private'`, and one pull per highlight. There
is no second content path — Review schedules them, search finds them, the Delta can embed
them — and there is no second privacy story either, because `get_feed` pools on
`published AND public` and `works_read_readable` hides a work whose only summary is
somebody else's. The `works` row is shared between two readers who import the same book;
nothing else about it is. `import_items` carries the sha256 that makes a re-import a
no-op, and it deliberately outlives the pull it created, so Undo does not hand back
everything the reader just removed.

**A reader's own question lives in its own table.** `user_questions` rather than a row in
`quiz_questions`, because the pipeline upserts canonical questions with
`on conflict (pull_id, kind)` and a partial unique index added to make room for reader
rows would change what that upsert resolves against. `get_due_reviews` prefers the
reader's own unretired question and says which one it gave, so `recall_events` can file
the grade against `user_question_id` rather than the canonical foreign key.

**Retrievability is computed, never stored.** `knowledge_states` holds
`stability` and `last_seen_at`; `public.retrievability()` derives the current
value on read. A cron job that rewrote every row nightly would not scale, and a
row it had not reached yet would be indistinguishable from a fresh one.

**Convictions are append-only.** A new stance sets `superseded_by` on the old
one rather than overwriting it, so "how my mind changed" stays queryable. A
partial unique index on `(user_id, pull_id) where superseded_by is null` makes
"what do they believe _now_" an index lookup rather than a window function over
their whole history.

**Lineage and counterpoints share one edge table.** `pull_relations.kind` covers
`related`, `opposes`, `elaborates`, `ancestor` and `descendant`. Counterpull
reads the `opposes` edges; Idea Lineage walks `ancestor`/`descendant`.

The read path reads `opposes` too, and not as a feature — as a correction.
Embeddings barely encode negation, so a claim and its contradiction sit closer
together than two paraphrases of the same claim do. `get_feed` and
`get_source_delta` therefore drop opposed pairs from the distance comparison
before deciding what the reader already knows; without that, the Delta hides
every disagreement. This makes the edges load-bearing rather than decorative: a
missing `opposes` edge is a contradiction silently suppressed, which is why
relation extraction is a prerequisite for backfilling real embeddings over
generated content.

The exclusion is edge-exact and deliberately so. Widening it by distance — to
catch the reader who knows a claim through several phrasings while only one
carries an edge — is unsound, because distance cannot tell a restatement from a
contradiction either: the widening drops ideas the candidate _agrees_ with and
serves them as novel. Nor can it be gated on the absence of an `opposes` edge,
since that absence is the very thing the widening compensates for. Density has
to come from the edges themselves.

**Interleave tunables live in a table.** `interleave_config` is a single-row
table with a `check (id)` singleton constraint, so the question rate can be
tuned from real usage without a deploy. A check constraint enforces that the
five type weights sum to 100.

**Cost data is not user-facing.** `cost_ledger` and `moderation_decisions` have
RLS enabled with a policy of `using (false)` — service-role only. That is
deliberate, not an oversight: the invariant check requires _a_ policy to exist,
not that it grants anything.

## Indexes on the hot path

| Index                                               | Serves                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pulls_embedding_hnsw` (HNSW, cosine)               | the Delta compares every candidate against the user's centroid on every page |
| `user_knowledge_vectors_hnsw`                       | centroid lookups                                                             |
| `knowledge_due_idx` (partial)                       | the review queue only ever asks for due rows                                 |
| `feed_impressions_user_time_idx`                    | recently-seen and repetition penalties                                       |
| `convictions_one_current_per_pull` (partial unique) | current stance in one lookup                                                 |
| `works_title_trgm`, `pulls_headline_trgm` (GIN)     | full-text search                                                             |

## Policy posture

- **User-owned data** — the owner only, via `(select auth.uid()) = user_id`.
  Wrapping `auth.uid()` in a scalar subquery lets Postgres evaluate it once per
  query instead of once per row.
- **Canonical content** — world-readable once `status = 'published'`; written
  only by the service role, which bypasses RLS. A `works` row is visible only when
  one of its summaries is readable by the caller (published and public, or their
  own), so a source with nothing readable behind it is not enumerable.
- **Write policies are split** into INSERT/UPDATE/DELETE rather than `for all`
  wherever a separate read policy exists, so no read pays for two overlapping
  permissive policies. Enforced by invariant 5 in `supabase/tests/lint.sql`.
