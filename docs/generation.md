# Generation and cost control

## Generate once, read thousands of times

The threat to an ad-supported product is not storage. It is letting any user interaction
become a fresh inference.

```
8,000 users → 8,000 generations        ✗  ~$450
8,000 users → 1 canonical summary      ✓  ~$0.056, amortised to ~0.0007¢ each
```

Personalisation therefore decides **which** cards are shown and **in what order** — never
whether another copy needs to be generated.

## Cost shape

Using representative public pricing for a 50k-input / 4k-output summary:

| Operation                |     Approx. |
| ------------------------ | ----------: |
| Standard text generation |     $0.0148 |
| Batch text generation    |     $0.0074 |
| One medium illustration  |     $0.0410 |
| **Text + one image**     | **$0.0558** |
| One web-search call      |     $0.0100 |

Note what that says: **the illustration can cost several times the summary.** So we do
not generate art per card. One hero image plus perhaps two section images, reused across
10–25 cards, and deterministic diagrams, typography and public-domain imagery wherever
they will do. Art is the first thing to switch off under cost pressure, and the product
is designed so that switching it off degrades gracefully.

## The questions ride the summary

A generated Pull carries up to three questions — one `recall`, one `mcq`, one `cloze` —
and they are produced by **the same call that produced the idea**. There is no question
step, no second request and no second bill: `packages/prompts/baml_src` declares exactly
one `function`, `WriteCanonicalSummary`, and adding a kind adds fields to its schema
rather than a call to a provider.

That is the whole reason this is affordable. A question generated per reader would be the
$450 column of the table above; generated once with the summary it is a few hundred
output tokens amortised across everyone who ever reads that idea. Grading is arithmetic
the client does — `lib/activities.ts` compares a picked option to a stored answer — so
nothing about asking or marking a question reaches a model. Law 2 is intact in both
directions.

**What it costs, measured and unmeasured.** On the way in it is exact: what is actually
sent grew by **1,663 characters** — the prompt text by 1,331 and the JSON Schema by 332 —
which is roughly 415 tokens, or about $0.0003 per summary at the configured $0.75 per
million input tokens.

An earlier version of this paragraph said 2,593 characters and ~650 tokens, and cited
`supabase/functions/_shared/generated/prompts.ts` growing from 6,352 to 8,945 bytes. That
is the growth of the whole TypeScript file — pretty-printed schema indentation and the
export wrapper included — and none of that reaches a provider. Two reviewers caught it
independently. The figures above were measured by importing both versions of that module
and comparing `messages[].text` and `JSON.stringify(schema)`, which is what a request
carries. Over-stating a cost is the safe direction, but the sentence claims to be exact. On the way out it is up to two
extra questions per Pull, which is not something this repository can measure before a
real generation runs — the honest figure will be the first hosted `cost_ledger` row for a
`synthesize` step after this ships, compared against the ones before it. Stated as an
estimate rather than a measurement, deliberately: the table above is measured, and mixing
a guess into it would make the whole thing untrustworthy.

Three is the ceiling because the response schema's `kind` enum has three members, not
because of the index: `quiz_questions_pull_kind_key` is unique on `(pull_id, kind)` and
`quiz_questions_kind_known` allows six kinds, so a pull can hold six rows. An earlier
version of this line said a fourth question could not be a fourth row, which is true only
of a fourth question of a kind already written.

## Three tiers — don't pay for research you don't need

| Tier                 | When                                                       | Cost                |
| -------------------- | ---------------------------------------------------------- | ------------------- |
| **A** — indexed      | The canonical summary already exists                       | retrieval only      |
| **B** — known source | Identity resolves; metadata + permitted context → generate | generation only     |
| **C** — research     | Genuinely unknown; search, synthesise, cite                | generation + search |

Five searches per summary is five cents _before_ generating anything. Never use Tier C
where Tier A will do.

## Personalised views without regeneration

A user asking _"skip the basics, show me only what's new to me"_ must not trigger a
regeneration:

```
canonical ideas + user knowledge vector + history
        → personal relevance ranking → personalised view
```

Cheaper, faster, and it gets better as the library grows rather than more expensive.

## Provenance on every generation

```
model · prompt version · timestamp · source edition · source inputs
claim anchors · moderation state · human edits · revision history · cost
```

Recorded in `job_steps` and `cost_ledger`. Without this a bad summary is an unfixable
mystery; with it, it is a diff.

## Keeping expensive work free

There is no paid tier, so quotas exist for sustainability, not monetisation:

```
3 fast generations per day, then:
  • continue in the normal queue (free, just slower), or
  • watch a rewarded ad for one more fast slot
```

Nobody has to pay, and no knowledge feature is ever behind the ad. The quota exists to
stop someone scripting 100,000 image generations against the public instance — not to
convert users.

### A cap for the day, because a per-requester quota is not one

The quotas above count rows belonging to **one identity**: three fast jobs a day, a
stagger past that, a hard ceiling of fifty. That is exactly the right shape for stopping
one reader running away with the budget, and no shape at all for stopping a hundred
readers each spending their allowance on the same afternoon. Fifty jobs at $0.056 is
$2.80 for one account and $280 for a hundred, and nothing in the schema noticed.

Studio makes that worth fixing rather than theoretical — a private summary of a reader's
own text means everybody can spend, not only whoever asks for a canonical work — so
`20260914010000` adds the bound the per-requester quotas cannot express: a **global
ceiling on provider spend in one UTC day**, `daily_spend_cap_cents()`, currently 200
cents. The two compose. A reader is still bounded by their own quota; the product is
bounded by the cap whatever the quotas allow.

**Checking a number before spending is not a cap.** Two workers read `spend_today()` at
the same moment, both see the same figure, both decide they are under the cap, and both
spend — and the overshoot grows with the number of workers, not by one job. So the cap is
a **reservation**: under one global advisory lock, the worst case of the step about to run
is written to `budget_reservations`, counted against the cap by everyone who looks, and
replaced by the real charge when the `cost_ledger` row lands. `record_job_step` and
`record_failed_job_step` settle in the same transaction as the charge, so there is no
instant in which the money is counted twice and none in which it goes uncounted.

A step that dies holding a reservation is released twice over: the stranded-job sweep
settles what it fails, and a reservation older than an hour is ignored by the sum whether
anything settled it or not.

`spend_today()` is the ledger plus open reservations and **nothing else**. Never
`generation_jobs.cost_cents`: `record_job_step` already rolls every ledgered charge into
that column, so a sum over both reports double the real spend and slams the cap at half of
it — a cap of $1 that claims to be $2, which is worse than either.

| Step         | Reserved, worst case |
| ------------ | -------------------: |
| `synthesize` |              6 cents |
| `embed`      |               1 cent |

Those are the constants the pipeline reserves with, rounded up from the cost shape above
so a reservation is never smaller than the charge that replaces it. Two rows, not three:
`artwork` calls no provider today and reserves nothing, and carrying a price for it here
would put the worst case of a job at 12 cents when `enqueue_generation_job` pins its own
door check at 7 — which is what a reader reconciling the two would then widen. The hold is taken
**after** the source claim — a job that is only ever going to wait on a source another job
is synthesising should not take a hold it will not use — and **immediately before** the
provider, because a reservation taken afterwards is a receipt rather than a cap.

A step that cannot reserve **waits**, it does not fail. Nothing was sent, so nothing is
owed and the attempt must not count against `MAX_ATTEMPTS`: the worker re-sends the step
with a delay, exactly as it does for a held source, and bounds the waiting itself. The two
kinds of waiting carry separate counts, because they are bounded by different facts — a
source claim survives minutes, so thirty minutes of waiting means something is wrong,
while the daily cap refills at 00:00 UTC, so a job arriving at 08:00 on a day that filled
early waits sixteen hours and is perfectly healthy.

| Waiting on    | Between asks | For up to |
| ------------- | -----------: | --------: |
| A held source |         60 s |    30 min |
| The daily cap |        900 s |      24 h |

### The private tier

`generation_jobs.kind` has existed since the table was created and was written by nothing,
so every row said `canonical_summary` whatever it actually was. `enqueue_generation_job`
now writes it, narrowed to two values:

| `kind`              | What it describes                                                                  |
| ------------------- | ---------------------------------------------------------------------------------- |
| `canonical_summary` | A work for the catalogue: published, public, generated once and read by thousands. |
| `private_summary`   | A reader's own text, summarised for them and published nowhere.                    |

**The column is descriptive, and it is worth being exact about that**, because the table
above reads like an enforcement mechanism and is not one yet. Nothing in
`supabase/functions` branches on `kind`. What actually keeps a private summary private is
`generation_jobs.visibility` — which defaults to `private`, which `enqueue_generation_job`
refuses to take from the client, and which `template` passes to `summaries.visibility` —
plus the `moderate` step, which re-checks rights immediately before publication and
refuses an uncleared job. Those three hold the line. `kind` records which sort of job it
is, so a spend report can tell canonical work from private and so the pipeline has
somewhere to branch when `embed_private` and `relate_only` arrive. Validating it today
buys a refusal for a typo rather than a job nothing will ever pick up, which is worth
having and is not the same as enforcement.

A private summary is the one place a reader's own content reaches a model provider, and
it happens because they asked. `docs/privacy.md` says so in the reader's words.

**An imported book gains a summary, not a second `works` row.** `upsertWork` keys on
`content_hash`, which is the right identity for a canonical source and the wrong one for
an import: a reader's imported highlights already have a work of their own, created per
reader by `commit_import`, and the text they later send to Studio is not the text that row
was hashed from. So `template` adopts `target.work_id` instead — but only where the
requester has authored a summary on it, checked against the row at the moment of the
write. `enqueue_generation_job` strips a `work_id` that fails the same test at the moment
of the request; the two together are what stop a private generation attaching itself to a
work its requester has nothing to do with. The adopted row's `rights_status`, `owner_id`
and `byline` are left exactly as the import wrote them.
