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

- We ask for **an email address**. Not a password, not a phone number, not your real name —
  and you can look around as a guest without giving us even that.
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

### Looking around as a guest

You can use the product without giving us an address at all. "Look around as a guest" on the
sign-in screen creates a **guest session**: a row in the same user table as everyone else,
with no address, no name and nothing that identifies you.

It behaves like an account because it is one, technically — the topics you pick, what you
read and what you stash are stored the same way, under an identifier that exists only in
your browser. Three things are different, and all three are consequences of there being no
address:

- **It cannot be recovered.** Clear the browser's storage, or open the product on another
  device, and the session is gone with no way back in. There is nothing to send a code to.
- **You cannot request a generation, publish a summary, or file a moderation report.** Those
  need an account we can attribute the request to. (The first two are not yet exposed in
  the app for anyone; the limit is in the database, so it holds whenever they are.)
- **We delete it for you.** A guest session that has not been used for a day is removed
  outright, along with everything keyed to it. You do not have to ask. A day is short on
  purpose: a guest account is an identity nobody can prove they own, holding a reader's
  stashes, notes and history, so the shorter it exists the less there is to lose. Come
  back the next evening and it is still there; come back on Monday and it is not.

Signing in afterwards starts a fresh account. A guest session is not carried over — there is
no address to attach it to, and guessing which anonymous session belongs to a new sign-in is
exactly the kind of linking this policy exists to say we do not do.

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
| **Supabase** (and AWS beneath) | Database, authentication, server functions             | `ca-central-1`, Canada  |
| **Vercel**                     | Serving the web app and its static assets              | Global edge network     |
| **Google** (Gemini API)        | Generating summaries — including a document you submit | Google's infrastructure |

Sign-in emails are delivered through Supabase Auth's email provider, which necessarily
sees your address and the code.

That is the complete list. There is no analytics vendor, no session-replay tool, no crash
reporter, no tag manager, and no advertising SDK in the app today.

**There was a fourth, and we had not counted it.** Until recently the stylesheet loaded
three typefaces from `fonts.googleapis.com`, which meant your IP address and browser
reached Google on the first paint of every page — including this one, before you had
read a word of it. That was a request nobody had decided to make, sitting against the
sentence about cross-site tracking below. The fonts are now served from our own origin,
so the request no longer happens. It is recorded here rather than quietly fixed because
a privacy policy that has only ever been right is not evidence of anything.

**If a second model provider is ever switched on**, this table changes before it does.
The code supports one (`SUMMARY_FALLBACK_PROVIDER`), it is not enabled, and enabling it
without amending this page would make the sentence above false.

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

You do this yourself, from **Account → Delete this account**. It is not a request you
send us and wait on: the deletion happens when you confirm it. Because it cannot be
undone, it asks for a sign-in within the last ten minutes first — a token minted weeks
ago on a device you no longer have should not be able to spend the account.

**Documents you submitted for generation are deleted too.** This page used to say they
were not, and that was accurate: `generation_jobs.requester_id` is `on delete set null`,
so a foreign-key cascade alone left the job — and any text you pasted in, and whatever
the pipeline fetched into `job_steps.output` — sitting in the database with your name
taken off it. That is not deletion. `delete_my_account` now removes those rows outright
before the account goes.

Three things survive, none of them attached to you:

- **Reports you filed.** `reports.reporter_id` is set to null; the report itself stays,
  so deleting an account cannot erase a moderation trail.
- **Spending records.** `cost_ledger` keeps a row with no user attached — a model name, a
  token count and a cost. It never held a user id, and it is how this project can state
  what generation costs. Nothing in it identifies you.
- **Backups**, for up to 30 days, after which they roll off.

**A guest session is deleted for you.** Unused for a day, it is removed outright —
account row, preferences, history, everything keyed to it — by a scheduled sweep
(`sweep_guest_accounts`). This is the one place where the "while your account exists,
your data exists" rule above does not hold, and deliberately: a guest session has no
address, so nobody can come back to it and nobody can ask us to delete it. Keeping it
indefinitely would be hoarding reading history belonging to people we cannot contact.

Anything published under a future community feature is covered in the Terms.

## Your rights

Four of these you do yourself, without asking and without waiting, from
**Account**:

| Control                     | What it does                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Download everything**     | Every row stored against your account, as one JSON file. Paged, so a large library is not silently truncated at a hundred rows. |
| **Where you are signed in** | Every session, with the device and when it started. End any of them, or all but this one.                                       |
| **Second factor**           | An authenticator app, with single-use recovery codes for when you lose it.                                                      |
| **Delete this account**     | Immediate and irreversible, after a recent sign-in and typing your address.                                                     |

A note on ending a session, because the honest version is less impressive than the
usual claim: it stops that device getting a _new_ token. A token it already holds keeps
working until it expires, within the hour. That is how stateless tokens work, and no
amount of server-side deleting changes it.

Beyond those, whoever and wherever you are, you can ask us to **access, correct, delete, export, restrict
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

- **Row-level security is on every table in the database, and every one carries a
  policy.** CI replays every migration from zero on a real Postgres and fails the build
  if a table has RLS disabled, has no policy, has a `SECURITY DEFINER` function with an
  unpinned `search_path`, or has two permissive policies overlapping on reads.

  This used to say the policies are "written in the migration that creates" the table.
  That is the project's stated intent and it is not what the schema does — tables land
  in one migration and their policies in the next, and migrations here are append-only
  so it cannot be retrofitted. What CI asserts is the **end state**, which is what
  protects you: no environment that finishes migrating has an unprotected table. The
  stronger sentence was a claim about process, and it was wrong.

- **This whole thing is public.** The source is on GitHub, including the schema, every
  policy, and the URL and publishable key of the production project. That is deliberate:
  the security of your data rests on row-level security and on the credentials the
  repository does **not** contain, not on any of it being unreadable. If it rested on
  secrecy, publishing would break it — and you would have no way to check any of the
  claims on this page. See `SECURITY.md` for how to report something.
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
