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

Wire the step-machine to real providers. Canonical summary pipeline, claim anchors,
generated cards, hero artwork, cost ledger reporting, rate limiting, and private
user generation in the Pull Studio. **The only round that needs API keys.**

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
  the reader did. Round 2 should classify permanent failures (a 404 or a 403 is not a
  500) and drop only those. Found while reviewing my own retry path, not by either
  reviewer.
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
