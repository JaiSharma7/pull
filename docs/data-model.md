# Data model

39 tables in `public`, created across the 70 timestamped migrations in
`supabase/migrations/` (`YYYYMMDDHHMMSS_name.sql`, applied in filename order — the
range moves with every push, so count the files rather than trusting a number here).
Every one has RLS
enabled with at least one policy, every foreign key has a supporting index, and
every `SECURITY DEFINER` function pins its `search_path`. CI check 4 replays the
whole thing from zero and asserts all of that.

## Shape

```
User
 ├── profiles · preference_profiles · follows
 ├── stashes ─── saved_items · notes · highlights
 ├── history_events · progress
 ├── knowledge_states · user_knowledge_vectors    ← the Delta & Half-Life
 ├── convictions · explanations                   ← Conviction Ledger & Say It Back
 ├── session_seeds · interrupt_events             ← Interleaved Recall
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
  only by the service role, which bypasses RLS.
- **Write policies are split** into INSERT/UPDATE/DELETE rather than `for all`
  wherever a separate read policy exists, so no read pays for two overlapping
  permissive policies. Enforced by invariant 5 in `supabase/tests/lint.sql`.
