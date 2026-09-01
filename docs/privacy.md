# Privacy Policy

**Effective 30 August 2026.** Every revision of this document is a commit in this
repository, so what changed and when is public history rather than a claim.

## Scope

This policy covers the **hosted service** at whatapull.com and its apps — the account you
sign into, and the data that account accumulates.

It does not cover the open-source repository. Running your own copy of this code makes you
the operator of your own service, and this document says nothing about what you do with it.

> A plain-English summary of a legal document is not the legal document. Where the sections
> below are more specific than the summary, the sections govern.

## The short version

- We ask for **an email address**. Not a password, not a phone number, not your real name.
- The product keeps a model of **what you have read and what you appear to know**, because
  refusing to re-teach you things is the entire point of it.
- **No advertising trackers, no third-party analytics, no data sold or shared for anyone
  else's advertising.** There is no such code in the app; you can check.
- **Your reading history never reaches a language model.** This is architectural rather
  than promised — see [What never reaches a model](#what-never-reaches-a-model).
- Audio and offline reading happen **on your device** and send us nothing.
- Delete your account and your library, history and knowledge model go with it, in one
  cascade, immediately — with one exception, a document you submitted for generation, called
  out under [How long we keep things](#how-long-we-keep-things).

## What we collect

### What you give us

| Data                              | Where it lives        | Why                                                                                                                     |
| --------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Email address                     | Supabase Auth         | The only way to sign in and the only way to reach you                                                                   |
| Handle, display name, bio, avatar | `profiles`            | Optional; needed only if you choose to be visible to others                                                             |
| Topic and reading preferences     | `preference_profiles` | Weights, excluded topics, media kinds, daily minutes, technical level, spoiler tolerance, how often questions interrupt |

Sign-in is a one-time code or link sent to your email. **We never hold a password**, because
we never set one.

### What you create

Saved Pulls and stashes, notes, highlights, your reading progress, the explanations you
write in Say It Back, and the stances you record in the Conviction Ledger
(`stashes`, `saved_items`, `notes`, `highlights`, `progress`, `explanations`, `convictions`).

Two notes on the last of these. Convictions are **append-only by design** — recording a new
stance supersedes the old one rather than overwriting it, because "how my mind changed" is a
feature. And your explanations are your own writing, kept as you typed it. Both are deleted
with your account like everything else; the append-only property is about not losing your
own history to yourself, not about retaining it against your wishes.

### What the product observes

This is the category most services describe vaguely, so here it is precisely:

| Data                                                            | Table                               | What it is                                                       |
| --------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Which ideas you were shown, where in the feed, and what you did | `feed_impressions`                  | Stops the feed repeating itself                                  |
| What you opened and for how long                                | `history_events` (incl. `dwell_ms`) | Your history, and the reading-time signal                        |
| Recall state per idea                                           | `knowledge_states`                  | Stability and last-seen, from which Half-Life is computed        |
| A numeric summary of what you know                              | `user_knowledge_vectors`            | The centroid the Delta compares candidates against               |
| Questions shown, answered or dismissed                          | `interrupt_events`, `session_seeds` | Bounds interleaved questions and backs off when you dismiss them |

`user_knowledge_vectors` deserves a sentence of its own. It is a vector — a list of numbers
— averaged from the ideas you have engaged with. It is not readable prose and it is not
shown to anyone, but it is derived from your reading and we treat it as personal data
accordingly. It is deleted with your account.

**Retrievability is never stored.** How well you currently remember something is computed
at the moment it is asked for, from `stability` and `last_seen_at`. There is no nightly job
writing a decay score onto every row of your memory.

### What the servers record

Ordinary operational records: request logs held by our hosting providers, and — if you ask
the app to generate a summary — a `generation_jobs` row with your user id, the steps it ran
(`job_steps`), and what the provider call cost (`cost_ledger`). Rate-limit counters
(`rate_limits`) exist to stop one account exhausting a shared budget.

We do not collect precise location, contacts, calendar, photos, or device identifiers for
advertising.

## What never reaches a model

Law 2 of this project is that **no language model runs in the read path**. Ranking, search,
the Delta and the interleave planner are SQL and vector arithmetic executed inside Postgres.

The privacy consequence is the point: **when you read, nothing about you is sent to Google
or to any other model provider.** Models run at generation time, once, to turn a _source_
into a canonical summary that thousands of readers then share. What that call contains is
the source material and our prompt — not you, not your history, and not your library.

**The exception is a document you submit yourself.** If you ask the Studio to generate a
summary of your own text or a URL, that text is the source, and the pipeline sends it to
Google as the context for the summary it writes. You are doing that deliberately, but it is
your content reaching a model provider, and it deserves stating plainly rather than leaving
as an implication: what never reaches a model is your **reading** — not something you
supplied to be summarised.

Two schema columns (`explanations.gap_score`, `graded_at`) anticipate a further feature that
would have a model grade your Say It Back answers. **Nothing writes to them today, and no
explanation you have written has ever been sent to a provider.** If that feature ships, this
policy changes first and the change is a commit you can read.

## Legal bases for processing (UK/EU)

| Purpose                                                       | Basis                                         |
| ------------------------------------------------------------- | --------------------------------------------- |
| Running your account, serving your feed, storing your library | Performance of a contract                     |
| Security, abuse prevention, rate limiting, cost control       | Legitimate interests                          |
| Improving ranking and the knowledge model                     | Legitimate interests (no third-party sharing) |
| Anything materially beyond the above                          | Consent, asked for at the time                |
| Responding to lawful requests                                 | Legal obligation                              |

## Who else processes your data

Three, and only three:

| Processor                      | What it handles                                        | Where                   |
| ------------------------------ | ------------------------------------------------------ | ----------------------- |
| **Supabase** (and AWS beneath) | Database, authentication, storage, server functions    | `ca-central-1`, Canada  |
| **Vercel**                     | Serving the web app and its static assets              | Global edge network     |
| **Google** (Gemini API)        | Generating summaries — including a document you submit | Google's infrastructure |

Sign-in emails are delivered through Supabase Auth's email provider, which necessarily
sees your address and the code.

That is the complete list. There is no analytics vendor, no session-replay tool, no crash
reporter, no tag manager, and no advertising SDK in the app today.

## Where your data lives, and transfers

The database is in **Canada** (`ca-central-1`). If you are in the UK, the EEA or elsewhere,
your data is transferred there and to the United States, where the service is operated and
where Vercel and Google process it. Those transfers rely on **Standard Contractual Clauses**
with our processors, together with the UK Addendum where it applies. Canada holds an
adequacy decision from the European Commission for commercial organisations.

## Cookies and what sits on your device

We use **no advertising or analytics cookies**, and no cross-site tracking of any kind.

What the app does put on your device, all of it first-party and all of it necessary:

- **Your sign-in token**, in `localStorage`, so you stay signed in.
- **A small amount of interface state**, in `localStorage`.
- **Your offline library**, in IndexedDB, plus a queue of writes made while disconnected —
  which is how offline reading is free rather than a paid tier.
- **The app itself**, cached by a service worker.

Clearing your browser's site data removes all four, and signs you out.

Read-aloud uses your browser's built-in speech synthesis. **No audio is recorded and none is
sent to us.** Some browsers fetch higher-quality voices from their own vendor's servers; that
is between your browser and its vendor, and we neither see nor control it.

## How long we keep things

While your account exists, your data exists — unlimited history is one of the five things
this product refuses to charge for, so we are not going to quietly trim it.

When you delete your account, deletion cascades from your user record through every table
keyed to it: profile, preferences, stashes, saves, notes, highlights, history, impressions,
knowledge states, vectors, convictions and explanations. That is a foreign-key cascade in
the schema, not a scheduled cleanup job.

Three things survive, all of them severed from you:

- **Generation records, including any document you submitted.** `generation_jobs.requester_id`
  is set to null, so nobody is attached to the job — but the job itself remains, and where you
  supplied text rather than pointed at a public source, that text remains with it. The
  submission is stored in `generation_jobs.target`, and the pipeline keeps what it acquired
  and segmented in `job_steps.output`. **Nulling the requester does not erase the document**,
  so deleting your account does not today remove text you submitted for generation.
  `cost_ledger` never held a user id.

  We would rather this were not true, and it is a schema fix rather than a wording one: the
  source-bearing fields should be erased when the account that produced them is. Until that
  ships, ask us and we will delete them by hand — and if you want a submitted document gone
  with certainty, ask before deleting the account, while we can still tell which jobs were
  yours.

- **Reports you filed.** `reports.reporter_id` is set to null; the report itself stays, so
  deleting an account cannot erase a moderation trail.
- **Backups**, for up to 30 days, after which they roll off.

Anything published under a future community feature is covered in the Terms.

## Your rights

Whoever and wherever you are, you can ask us to **access, correct, delete, export, restrict
or object to** the processing of your data, and you can withdraw consent where consent is
what we relied on. Email the address below; we answer within 30 days.

**If you are in the UK or the EEA**, those are your rights under UK GDPR and GDPR, and you
may complain to your supervisory authority — the ICO in the UK — though we would rather you
told us first.

**If you are in California**, you have the rights to know, delete, correct, and to limit the
use of sensitive personal information under the CCPA as amended by the CPRA. Two disclosures
that matter more than the list: **we do not sell your personal information, and we do not
share it for cross-context behavioural advertising.** We have never done either. We do not
discriminate against anyone for exercising these rights, and since there is no paid tier
there is no financial incentive to offer in exchange for your data.

**If you are in Virginia, Colorado, Connecticut, Texas or another US state with a
comprehensive privacy law**, you have equivalent rights and may appeal a refusal by replying
to our decision.

## Security

- **Row-level security is on every table in the database**, with policies written in the
  migration that creates it. CI fails the build if a table lacks one.
- The browser bundle carries exactly one credential: the Supabase **publishable** key, which
  is designed to be public and which RLS — not secrecy — is what protects. Service keys and
  provider keys exist only server-side.
- Sign-in codes expire. There is no password to breach because there is no password.

No system is perfectly secure, and we will not pretend otherwise. If a breach affects your
personal data we will notify you and the relevant regulator as the law requires — within 72
hours of becoming aware, where GDPR applies.

## Children

The service is not for children under 13, and we do not knowingly collect their data. If you
are in the EEA and under 16 (or the lower age your country sets, down to 13), you need a
parent or guardian's consent. Tell us about an account belonging to a child and we will
delete it.

## Changes

Material changes are announced in the app before they take effect, and the effective date at
the top changes. Because this file lives in a public git repository, you can also read the
diff between any two versions of it — which is a stronger guarantee than a changelog we
write about ourselves.

## Contact

**privacy@whatapull.com** — privacy questions, requests and complaints, and anything under
"Your rights" above.

**security@whatapull.com** — vulnerability reports. See [`SECURITY.md`](../SECURITY.md) for
what to expect and how quickly.

Both are monitored by the operator named in the [Terms](./terms.md). They are role addresses
rather than a personal mailbox on purpose: a privacy contact that is one person's inbox is a
contact that stops working the moment that person is unreachable, and this repository is
public, which makes anything written here permanently indexed.
