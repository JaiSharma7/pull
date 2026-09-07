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

**What it costs, measured and unmeasured.** On the way in it is exact: the prompt and the
response schema together grew by 2,593 characters (`supabase/functions/_shared/generated/
prompts.ts`, 6,352 → 8,945 bytes), which is roughly 650 tokens, or about $0.0005 per
summary at the configured $0.75 per million input tokens. On the way out it is up to two
extra questions per Pull, which is not something this repository can measure before a
real generation runs — the honest figure will be the first hosted `cost_ledger` row for a
`synthesize` step after this ships, compared against the ones before it. Stated as an
estimate rather than a measurement, deliberately: the table above is measured, and mixing
a guess into it would make the whole thing untrustworthy.

`quiz_questions_pull_kind_key` is unique on `(pull_id, kind)`, so three is also the
ceiling the schema can usefully ask for — a fourth question could not be a fourth row.

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
