# Roadmap

Build order matters: the product should feel good **before** any AI generation exists.
If it is not enjoyable with a hand-seeded public-domain corpus, generation will not save
it.

## Round 1 — the spine ✅

Monorepo with four CI checks, the agentic setup, 28 migrations across 38 tables with RLS
everywhere, the read path (ranking · Delta · interleave), a public-domain seed, The
Archive design system, the generation step-machine skeleton, and a working app: auth →
feed → interleaved questions → save → review → Enough.

The free-forever five all land here, each affordable because of where it runs rather than
because of a subsidy: audio (Web Speech, on-device), offline (service worker + IndexedDB),
unlimited history and stashes (rows in Postgres), and Daily Pulls (one shared editorial
query).

**Known gaps carried into round 2**, so they are not rediscovered as surprises:

- Onboarding is not built. New readers get default preferences from the signup trigger and
  an unweighted feed, which works but is not personalised until they have history.
- The Delta's `covered` check scans the reader's known set per candidate. Correct and fast
  at seed scale; it needs a precomputed neighbour table before a library grows large.
- `packages/ranking` mirrors the interleave planner but not the feed scorer. Only the
  planner has a parity test; the scorer lives solely in SQL for now.
- Source pages, Explore, Library and Studio are stubs or absent — `get_source_delta` is
  implemented and tested but has no screen yet.
- Embeddings are synthetic (concept axes). Real ones arrive with the providers in round 2,
  and no read-path code needs to change when they do.
- The generation step-machine is wired and verified but **not deployed**, and runs stub
  providers. Round 2 deploys the Edge Functions, enables the `pg_cron` dispatcher and swaps in
  real providers.
- `public.enqueue_generation_job` is deliberately `SECURITY DEFINER` and callable by signed-in
  readers — the only way to make the job insert and its queue send one transaction, since the
  `authenticated` role has no privilege on `pgmq`. It derives the requester from `auth.uid()`
  and enforces the quota internally. The security advisor notes this by design; it is the one
  advisory the project accepts, and the reasoning is in the migration that grants it.

## Round 2 — generation

### Deployment ✅

The app and the step-machine are live. What that took, so it is repeatable:

- `vercel.json` configures the monorepo build; `apps/web/.env.production` carries the
  publishable key and project URL, so a deploy needs no dashboard step.
- All three Edge Functions are deployed. `worker` runs with `verify_jwt` off and
  authenticates the dispatcher itself — see `supabase/functions/README.md`.
- `enable_generation_dispatcher_with_token` mints a token into Vault and schedules
  `pg_cron` every 10s, so turning generation on never requires reading the service_role
  key out of the dashboard.
- Verified end to end: a job walked all twelve steps to `succeeded`, wrote twelve
  `job_steps` rows and three `cost_ledger` rows (the three provider steps), and the worker
  returns 401 to a request with no token or a wrong one.

One deviation from law 5's spirit worth recording: `pnpm build` never worked on a cold
checkout (`TS6310` — `--noEmit` in `tsc -b` applies to referenced composite projects).
CI hid it because its typecheck job runs first and warms the graph. Fixed, and CI's
`pnpm build` is now a real check rather than a cached no-op.

### Providers ✅

`_shared/gemini.ts` and `_shared/config.ts` implement the environment-selected provider
set `architecture.md` has described since round 1. No key means stubs, so a fresh clone
still runs the whole pipeline. Verified against the live API, not mocked.

Three things that measurement changed:

- **Embeddings must be normalised client-side.** At a truncated 1536 dimensions Gemini
  returns vectors of length ~0.69, not 1. Every comparison in the read path is a cosine
  distance against an HNSW index; un-normalised vectors do not error, they rank wrongly.
- **Thinking tokens are output tokens.** A trivial prompt billed 5 visible output tokens
  and 157 reasoning tokens. Counting only `candidatesTokenCount` would have understated
  that call by ~97%, so `computeUsage` adds `thoughtsTokenCount`.
- **The newest model is not the right default.** `gemini-3.7-flash` and
  `gemini-flash-latest` both returned 503 under load while `gemini-3.6-flash` answered;
  `gemini-2.5-flash` 404s despite being listed. So the default is an ordered chain, and
  the model that actually answered is returned per call and recorded — a provider name
  pinned to the head of the chain would misattribute every fallback.

### The Delta is negation-aware ✅

The Delta _treated_ cosine distance `< 0.14` as "the reader already knows this",
hardcoded across six migrations and tuned against synthetic concept-axis vectors. Measured
against real Gemini embeddings:

| distance        | verdict       | relationship                  |
| --------------- | ------------- | ----------------------------- |
| 0.0635 · 0.0987 | covered ✓     | same idea, reworded           |
| **0.0618**      | **covered ✗** | **same topic, opposed claim** |
| 0.1474 · 0.1823 | new ✓         | related but distinct          |
| 0.2775 · 0.3423 | new ✓         | unrelated                     |

The ordering mostly survives, but _"spacing improves retention"_ and _"spacing offers no
benefit"_ are 0.0618 apart. Embeddings barely encode negation, so the Delta would file a
**contradiction** as already-known and hide it — precisely the material Counterpull and
the Conviction Ledger exist to surface.

**Re-tuning was the wrong framing, and it is worth recording why.** No value of the
threshold separates 0.0618 from 0.0987: an opposed claim sits _closer_ than a paraphrase,
so the ordering the constant relies on is not merely mis-calibrated, it is inverted. The
0.0618 is not a weak statement about redundancy — it is not a statement about redundancy
at all. It is an artifact of vectors that do not encode negation, and no constant recovers
information the vectors never carried.

So the fix is structural, and it does not exempt anything: opposed pairs are removed from
the comparison itself, and `covered` and `novelty_distance` then both come out right with
no special case downstream. A contradiction is judged against everything the reader knows
_except_ the ideas it contradicts — novel if nothing else is near it, redundant if it
genuinely duplicates something else. It earns its rank rather than being handed one.

Three things that building it changed:

- **An exemption is not enough, and the difference is measurable.** The first design
  exempted the candidate from `covered` and floored its novelty at the threshold. It was
  wrong: the contradiction survived the filter and then ranked **last** — 0.0268 against
  0.1380 and 0.1600 — because the floor is worth `0.12 × (0.14 − 0.0618) = 0.0094` of a
  score whose weights sum to 1.0, against the 0.12 a merely-novel card earns. It was not
  hidden by the filter; it was hidden by the scorer instead. `delta_negation.sql` asserts
  against that specific failure by requiring a contradiction to score identically for a
  reader who knows the opposed idea and one who knows nothing.
- **`kind = 'opposes'` cannot be an index condition under RLS.** `enum_eq` is not
  leakproof, so the planner may not push it below the security-barrier quals of
  `pull_relations_read_readable`; it lands in `Filter`, _after_ the policy, and every
  unrelated edge pays that policy in full. Two **partial** indexes fix it, because a
  partial index predicate is a plan-time constraint rather than a runtime qual and so
  escapes the leakproof rule entirely. Observed once on a seeded stack: at seed size the
  planner ignores them, and at a few thousand relations it switches to an index-only scan
  and `kind` disappears from `Filter`. Not yet a committed check — the plan shape would
  fit `db:test` and belongs there before it is quoted as fact.
- **Widening the exclusion through paraphrase is unsound, and no gate rescues it.** A
  reader knows a _claim_, usually through several phrasings, while only one carries an
  `opposes` edge — so the exclusion was widened to anything within the threshold of an
  opposed idea. That is the same blindness one level up: a contradiction is inside that
  threshold too, so the widening also dropped ideas the candidate _agreed_ with, and a
  reader holding both sides of a debate was served an idea they already held as maximally
  novel. Gating the widening on an `opposes` edge looked like the fix and is not: the
  widening exists _because_ edges are sparse, and the gate reads a missing edge as "not
  opposed". Both cannot be true of the same graph, and at ~0% annotation coverage the gate
  would essentially never fire. Two reviewers reproduced it independently, from different
  fixtures.

  So exclusion is edge-exact. That is **incomplete** — a reader who knows an unannotated
  restatement still has the contradiction hidden — and `delta_negation.sql` asserts the
  limitation rather than papering over it, so the day it stops holding somebody has to
  make a decision. Incomplete fails the way the old Delta already failed; the widening
  failed by serving known ideas as novel, which is a new way to be wrong. Closing it needs
  edges dense enough to describe claims rather than pulls — relation extraction's job.

- **The two Delta functions disagreed about how much a reader knows.** `get_feed` has
  always capped the known set at 500 by retrievability; `get_source_delta` capped nothing,
  so the same reader could get different answers. Survivable while the comparison was
  linear, and not once the paraphrase join made it quadratic in a whole history — measured
  at 327–423ms for 8,000 known ideas, on a function every source page calls. Capped to
  match. The negation work amplified this rather than inheriting it, which is why it is
  recorded here rather than filed as a pre-existing gap.

The constants now live in `delta_covered_distance()` and `known_retrievability_floor()`,
so a re-tune is a one-line migration rather than an edit across superseded files. `0.1474`
sitting 0.007 from the cut still says the threshold deserves a real distribution rather
than one tuned by hand — but that measurement wants real embeddings, which is what this
unblocks, so it belongs after the backfill rather than before it.

**What this does and does not unblock.** Nothing writes `pull_relations`: the twelve
pipeline steps never emit edges, so every row in the database comes from the seed
migration. The exclusion is therefore live for the **seed** corpus — whose `opposes` edges
are hand-written — and inert for generated content until a step produces them. Backfilling
the seed corpus is now safe. Generated content needs the relation-extraction step below
first, or the Delta will suppress disagreement in exactly the material we generate.

### The pipeline writes content ✅

`runStep` runs the real twelve steps. Worth recording what that took, because the
first version of it looked finished and could not have completed a single job:

Four separate values were rejected by the database and by nothing above it —
`works.content_hash` (a column no migration created), `rights_status: 'user_private'`,
`work_kind: 'article'`, and `summaries.model` (another absent column) — while
`summaries.author_id` went unset, which `summary_is_readable` needs for a private
summary to be readable by the person who asked for it. TypeScript accepts any string,
the test fakes accept any string, PostgREST forwards it, and Postgres refuses at the
end, after the expensive call is paid for. The hosted project's zero generation jobs
had looked like nobody having tried one.

The lesson is narrow and worth keeping: a test that mocks the database cannot catch an
invalid enum member unless it asserts the member. Enum mirrors now live in
`pipeline.ts` with narrowing functions at the boundary, and the tests assert the values
that reach Postgres rather than the call counts alone. Unrecognised rights claims
narrow to `review_required`, so the direction a mistake falls in is toward refusing to
publish.

### Open risk: reuse is narrowed, not serialized

Two jobs fingerprinting the same source can still both pay a provider.

`acquire` asks whether a source is already summarised, and `synthesize` now asks again
immediately before calling the provider — but they are separate invocations, minutes
apart on a queue, so the answer can go stale in between:

```
job A   acquire ──────── … ──────── synthesize ─── template (commits)
job B        acquire(miss) ──── … ──────── synthesize ← second lookup catches it here
                                             ↑
                        still open: both reach synthesize inside this gap
```

The adopt-on-`23505` in `createSummary` means this no longer ends in a crash or a
permanently failed job, so what remains is purely a duplicated bill — which is a law 2
failure whether or not anything throws, since the whole cost argument is that a source
is generated once.

Closing it properly means reserving the fingerprint: a `generation_hash_claims` row
taken at `acquire` and released at publish or failure, with a lease timeout. That was
deferred rather than half-built because the lease is the hard part — a crashed job
holding a claim would block every later request for the same source, turning a
duplicated bill into a stalled queue, which is the worse failure. Worth doing when reuse
volume makes the duplicate spend measurable; `cost_ledger` is where that shows up, since
two billable `synthesize` rows against one content hash is exactly the query.

### Still to do

Claim anchors — which is also where **relation extraction** belongs, since the Delta's
negation-awareness is inert on generated content until something writes `opposes` edges,
and the embedding backfill of generated summaries is gated on it. Then generated cards,
hero artwork, cost ledger reporting, rate limiting, and private user generation in the
Pull Studio.

Then public-domain ingest workers — Gutenberg, arXiv, Wikisource, open-access journals —
to grow the corpus without rights exposure.

## Round 3 — personal intelligence

Feed Builder with natural-language feed creation. Semantic search UI. The Depth Dial
across all media types. Pull Graph visualisation. Counterpull surfacing at scale.
Ask this Pull. Personalised resurfacing.

## Round 4 — community

Profiles, follows, public stashes, publish, **fork** (with attribution and revision
history — the GitHub-shaped collaboration model that Deepstash has no equivalent for),
comments, reports, moderation, and the §512 rights workflow. The rights machinery must
land _before_ public UGC, not after.

## Round 5 — ads

Ad abstraction behind the existing feature flag. One clearly-marked native unit after
12–20 content cards, tuned from real retention data rather than a hardcoded ratio.
Rewarded ads only for expensive generation slots — never for knowledge features. No
app-open ads, and never an interruption mid-Pull.

## Round 6 — Capacitor

Only once the PWA is genuinely offline-capable.

```bash
npm i @capacitor/core @capacitor/cli @capacitor/ios
npx cap add ios && npx cap sync
```

Then selectively: native share sheet, background audio, haptics, camera page-scanning,
push notifications, universal links so `whatapull.com/pull/abc123` opens in-app, and a
native ad SDK.

## Known gaps carried out of round 1

Named here because they are inert rather than broken, and a reader of this repo should
not have to rediscover them.

- **`refresh_knowledge_vector` has no caller.** `user_knowledge_vectors` is therefore
  never populated, so the `uvec` term in `get_feed` — 18% of the ranking score, and the
  largest personalisation signal in it — evaluates to the same constant for every card
  and every reader. The feed is currently ranked by topic weights, quality, novelty and
  jitter alone. Wiring it up belongs with the generation pipeline that produces the
  embeddings it averages, not before: recomputing a reader's centroid on every read
  would be a write amplification we have no evidence is needed. Round 2 either calls it
  from a `pg_cron` tick or drops the term and redistributes its weight.
- **The Delta banner counts the pool, not the page.** At the `p_limit` the client actually
  sends (20), `directly_known` counts over an 800-row candidate pool and `covered_delta`
  over a 400-row shortlist, while the page shows 20 — so the number describes something
  forty times larger than what the reader is looking at. So a well-read reader can be told _"skipped 240 ideas you
  already know"_ above twenty cards. It is a true statement about what the ranker
  considered and a false one about the page, and the same seconds drive the Enough
  screen's "against reading the sources in full" — where `estimated_read_seconds` is
  per-card, not per-source, so that line over-claims independently. Both are copy or
  counting-scope decisions rather than bugs in the maths, and both predate the negation
  work; recorded because the function comment that used to assert "describes this page"
  was corrected rather than carried forward.
- **`packages/ranking` cannot run in a browser.** `seededUnit` needs a synchronous MD5
  and takes it from `node:crypto`. That is fine for its actual job — testing the
  placement rules over thousands of sessions without a database — but the prefetch use
  it was originally described as serving would need a pure-JS MD5 first. It is a
  devDependency now, which is what it has always in fact been.
- **A permanently-invalid queued write retries forever.** `drainAndReschedule` keeps a
  timer alive while `hasPending` is true, and a write that can never succeed — a save
  for a pull deleted while the reader was offline — keeps it true. The loop settles at
  its 5-minute ceiling and stays there for the life of the tab: one IndexedDB read and
  one request per cycle, so cheap, but unbounded. The obvious bound is to give up after
  N attempts, which trades this for the worse failure of silently discarding something
  the reader did. Round 2 should classify permanent failures — a 404 or a 403 is not a
  500 — and drop only those. Found while reviewing my own retry path, not by either
  reviewer.
- **`acquire` is still open to DNS rebinding.** The host blocklist rejects private
  and link-local literals in both IPv4 and IPv6, and re-checks every redirect hop, so
  a public URL that 302s to `169.254.169.254` is refused. What it cannot see is
  `evil.example.com` with an A record of `10.0.0.1`: the check is on the literal, and
  resolution happens inside `fetch`. Closing it needs the address resolved before
  connecting and the socket pinned to it, which Deno's `fetch` does not expose —
  realistically a small resolve-then-connect helper, or an egress proxy. It matters
  because the worker holds a service-role key and writes what it fetched into
  `job_steps.output`, which the requester can read, and because
  `enqueue_generation_job` is reachable by any signed-in reader. Found by Codex
  reviewing the IPv4-only version of the blocklist; the IPv6 half is fixed, this half
  is not.
- **RLS is enabled one migration after the tables are created.** Law 5 in `CLAUDE.md`
  says "in the migration that creates it", and the schema does not do that: tables land
  in `20260829124548_learning.sql` and its siblings, policies in
  `20260829124730_rls.sql`. CI check 4 asserts the end state, so no environment that
  finishes migrating is exposed — but an environment that stops between the two is, and
  a table added to one of those files inherits the gap by default. Since migrations are
  append-only the split cannot be retrofitted; the choice is to keep the law as written
  and treat this as a standing deviation, or to reword it to describe what is actually
  enforceable. That is a decision for the repo owner, not a cleanup.

## Deliberately not planned

- A paid tier. The five free capabilities are the positioning; adding a subscription
  later would retract the one promise the product is built on.
- Engagement maximisation. The Enough screen and the time-saved metric are load-bearing,
  not decoration. Any metric that rewards longer sessions works against the thesis.
