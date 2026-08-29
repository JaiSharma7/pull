# Roadmap

Build order matters: the product should feel good **before** any AI generation exists.
If it is not enjoyable with a hand-seeded public-domain corpus, generation will not save
it.

## Round 1 — the spine ✅

Monorepo, four CI checks, the agentic setup, the full schema with RLS, the read path
(ranking · Delta · interleave), a public-domain seed, The Archive design system, and a
working vertical slice: auth → onboarding → feed → save → review → Enough.

Plus the free-forever five: audio, offline, unlimited history, unlimited stashes, and
curated Daily Pulls.

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

## Deliberately not planned

- A paid tier. The five free capabilities are the positioning; adding a subscription
  later would retract the one promise the product is built on.
- Engagement maximisation. The Enough screen and the time-saved metric are load-bearing,
  not decoration. Any metric that rewards longer sessions works against the thesis.
