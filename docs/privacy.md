# Privacy Policy

**Effective 28 September 2026.** Every revision of this document is a commit in this
repository, so what changed and when is public history rather than a claim.

**Your study courses now remember what your answers show.** For each claim a course
teaches, we keep how well you remember it — worked out from your answers the course could
check, the way your feed's review schedule is — and when you last answered it right or
wrong (`study_claim_memory`). The course uses it to leave out lessons you have recently shown
you know, to bring back a lesson after a wrong answer, and to ask questions again as memory
fades. Only answers the course checked itself count; being shown a lesson, your own
judgement of an answer, and an answer you looked up never do. Nothing is sent to a model.
See [What you create](#what-you-create).

The previous revision, effective 27 September, **recorded answers to your study courses'
questions.** When you answer a question in one of your courses, we keep what you chose,
typed or arranged (up to 1,000 characters), whether it was right, whether you looked at the
passage first or were trying again after seeing the answer, and — for a short answer the
course cannot check itself — your own judgement of it. The course uses these to show what
you have practised and which ideas you have shown you remember. Your answers are checked by
the database, not by a model, and no answer is sent to any model provider. An answer given
without a connection waits on your device until it can be sent — through a sign-out, for
when you sign in again — and is removed from the device when you delete your account.

The revision before, effective 26 September, **offered study courses in the app** to
accounts in the limited beta. In Studio you choose up to five study sources you saved and
say what the course is for; once you confirm, the title and text of those sources, and that
goal, are sent to Google's Gemini API, and the course it prepares is stored privately in
your account. Preparing a course again after you correct a source sends the newest version
of each of its sources, and the goal, the same way, after the same confirmation. Reading a course records which lessons
you were shown, finished or skipped, so it can remember your place; that record is never
counted as remembering anything. Listening to a lesson uses only a voice installed on your
device, so your material is not sent to a speech service; without one, the app does not
offer to read it aloud.

Before that, the revision effective 25 September described study course generation before
the app offered it: what is sent to Google's Gemini API and when, that each course keeps
the history of each claim, lesson and question's status (checked, held back, reported,
corrected), that a report you file and a version you correct are kept with it privately,
and that the lessons and questions you were shown are recorded. It also corrected
statements that contradicted the rest of this page: the summary said a document you
submitted for generation outlived your account (it does not), this page said you sign in
with an emailed code (you sign in with Google or Microsoft) and that we do not keep your
real name (the name your sign-in account supplies is kept), and it said the Anthropic
fallback was "not enabled" while listing it as a processor (it is a setting the hosted
service does not use, and is listed so that turning it on changes nothing you were told).

Earlier, the revision effective 23 September described private study import. When you
save material in Studio's Prepare study material mode, we store the extracted text you
approved and each corrected version in your private account. We do not upload the
original file, and saving alone does not send the text to a model provider. You can delete
a study source and all its versions from Studio. See
[What you create](#what-you-create) and [How long we keep things](#how-long-we-keep-things).

And the one effective 15 September added Anthropic as an optional Studio
summary fallback and described feedback sent through Settings. Those disclosures remain below.

## Scope

This policy covers the **hosted service** at whatapull.vercel.app and its apps — the account you
sign into, and the data that account accumulates.

It does not cover the open-source repository. Running your own copy of this code makes you
the operator of your own service, and this document says nothing about what you do with it.

> A plain-English summary of a legal document is not the legal document. Where the sections
> below are more specific than the summary, the sections govern.

## The short version

- We keep **an email address** from the Google or Microsoft account you sign in with, and
  the name on that account if it has one. Not a password, not a phone number — and you can
  look around as a guest without giving us even that.
- The product keeps a model of **what you have read and what you appear to know**, because
  refusing to re-teach you things is the entire point of it.
- **No advertising trackers, no third-party analytics, no data sold or shared for anyone
  else's advertising.** There is no such code in the app; you can check.
- **Your reading history never reaches a language model.** This is architectural rather
  than promised — see [What never reaches a model](#what-never-reaches-a-model).
- Audio and offline reading happen **on your device** and send us nothing.
- Delete your account and your library, history and knowledge model go with it,
  immediately — documents you submitted for generation included. The few records that
  survive identify nobody; they are listed under
  [How long we keep things](#how-long-we-keep-things).

## What we collect

### What you give us

| Data                              | Where it lives        | Why                                                                                                                     |
| --------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Email address                     | Supabase Auth         | Identifies your account when you sign in, and the only way to reach you                                                 |
| Handle, display name, bio, avatar | `profiles`            | Optional, except that the display name starts as the name your sign-in account supplies. Readable only by you           |
| Topic and reading preferences     | `preference_profiles` | Weights, excluded topics, media kinds, daily minutes, technical level, spoiler tolerance, how often questions interrupt |

Sign-in is through Google or Microsoft; see [Who else processes your data](#who-else-processes-your-data).
**We never hold a password** — you never set one with us, and we never see your provider's.

### Looking around as a guest

You can use the product without giving us an address at all. "Look around as a guest" on the
sign-in screen creates a **guest session**: a row in the same user table as everyone else,
with no address, no name and nothing that identifies you.

It behaves like an account because it is one, technically — the topics you pick, what you
read and what you stash are stored the same way, under an identifier that exists only in
your browser. Four things are different — three because there is no address, and one
because the session lives in the tab rather than in the browser:

- **It ends with the tab.** A guest session is held in `sessionStorage`, which is how a
  private window behaves: close the tab and it is gone. Duplicating the tab carries it
  across, and a browser set to reopen your last tabs on start-up may bring it back with
  them; an ordinary new tab does not get it, and neither does a link you open in one. This
  is deliberate — a guest account is an identity nobody can prove they own, and on a shared
  or public computer "stay signed in" would mean handing the next person one reader's
  stashes, notes and history with no sign-in wall in the way.
- **It cannot be recovered.** Clear the browser's storage, or open the product on another
  device, and the session is gone with no way back in. There is no account to sign back in
  with.
- **You cannot request a generation, publish a summary, or file a moderation report.** Those
  need an account we can attribute the request to. (Publishing is not yet exposed in the
  app for anyone; the limit is in the database, so it holds whenever it is.)
- **We delete it for you.** A guest session that has not been used for a day is removed
  **from our database**, along with everything keyed to it, by a sweep that runs every
  hour — so the account goes a little over a day after you last had it open, and never
  while you are still reading. A day is short on purpose: a guest account is an identity
  nobody can prove they own, holding a reader's stashes, notes and history, so the shorter
  it exists the less there is to lose. Plan on a day, not on a weekend. What that does not
  reach is the copy your own browser keeps for offline reading. That copy is keyed to the
  session it was made for, so a different session is never shown it — with the same
  caveat as the bullet above: a browser set to reopen your last tabs can bring the session
  itself back, and whoever restarts it is then inside it. Clearing the site's data removes
  the copy outright.

Signing in afterwards starts a fresh account. A guest session is not carried over — there is
no address to attach it to, and guessing which anonymous session belongs to a new sign-in is
exactly the kind of linking this policy exists to say we do not do.

### What you create

Saved Pulls and stashes, notes, highlights, your reading progress, the explanations you
write in Say It Back, the stances you record in the Conviction Ledger, and any feedback
you send (`stashes`, `saved_items`, `notes`, `highlights`, `progress`, `explanations`,
`convictions`, `feedback`).

**Private study sources** are extracted text that you review in Studio before saving:
pasted text, local files, public URL previews, or highlights you already imported.
The title, source URL or label, source format,
extraction notes, text, and each corrected version are stored in `study_sources` and
`study_source_versions` under your account. The original file is read in your browser and
is not uploaded. OCR is optional, uses downloaded recognition code/data, and runs on the
image in your browser. Saving this text does not send it to Google or Anthropic, publish
it, or add it to another reader's experience. You can delete the whole source and its
versions in Studio; they are also included in your account export and deleted with your
account. Correcting a version appends a new row; earlier text remains in your account
export until you delete the source. A content-free save-retry marker remains in
`study_source_mutations` until account deletion, so a delayed request cannot restore
the text you deleted.

If you preview a public source URL, your browser sends that URL to our server, which fetches
an allowlisted page and returns extracted text to this screen. The page host sees the
server request. The preview response is not saved by this feature. When you save,
the reviewed text, page URL, title, format, and extraction notes become a private source
version. Up to twenty preview attempts per
UTC day are counted in `study_url_preview_daily_usage`, without storing the URL or page
text in that counter. Those counts are visible in your account export and deleted with
your account. A learning goal searches the public catalogue without calling a model.

**Study courses** are what the beta generates from sources you choose: the goal you
typed, the claims found in your text with the exact passage each rests on, and the
lessons and questions (`study_generations`, `study_claims`, `study_claim_evidence`,
`study_lessons`, `study_items`, and the tables linking them). The model output they came
from is cached in `study_stage_cache` so the same text is not sent twice. All of it is
readable only by you, is not published, and never enters the catalogue or another
reader's experience. A course (`study_courses`) keeps its goal and the sources it follows
(`study_course_sources`); preparing it again after you correct a source adds a new version
of the course rather than a new course. Deleting any source a course was built from deletes
every version of the course made from it and every cached output made from it, and the
course itself once it has no sources left. You can also delete a course and keep its
sources; the cached model output made from those sources stays with them until you delete
the sources. It is included in your account export and deleted with your account. Whether
your account is in the beta is recorded in
`study_generation_access`, with any note we wrote when adding you — which you can read,
and which is in your export.

A course also keeps its own history (`study_status_log`): each status every claim, lesson
and question has had — checked, held back, reported, corrected, withdrawn — and when. If
you report part of a course (`study_reports`), the report and any note you add (up to
1,000 characters) are kept with it; you can resolve a report but not edit or withdraw it,
because it is the record of why something was hidden. If you correct a lesson or question,
your version is stored alongside the one it replaces, which is kept rather than deleted.
Answers to a course's questions are kept in `study_answer_events`: what you chose or typed,
or the order you put steps in (up to 1,000 characters), whether it was right, whether you
had looked at the passage first or were trying again after a wrong answer, and whether you
judged it yourself; the time is when it reached us. Which lessons and questions of a course you were shown, finished or skipped are
recorded in `study_progress_events` so the course can remember your place, with the time
your device reported (a time more than thirty days back, or in the future, is stored as the
nearest time that is not) and the time it reached us; being
shown something is never counted as remembering it. All of this is readable only by you, is
never reviewed by us, and is in your export. It is deleted with the version of the course it
belongs to — which deleting any source of that version deletes — with the course, and with
your account.

**Feedback** is worth its own sentence, because it is the one thing here you write _to us_
rather than for yourself. Sending it stores what you wrote, the subject you chose, and the
path of the screen you were on before you opened Settings — `/explore`, say. The path is
recorded without its query string or fragment, deliberately: that is what would otherwise
carry a search term you had typed or the identifier of the idea you were reading, and
neither belongs in a bug report you did not know was collecting them. Feedback cannot be
edited or withdrawn from the app once sent, because a message somebody has already read
should not be able to change underneath them — but it is deleted with your account like
everything else, and it appears in your data export.

Two notes on the Conviction Ledger. Convictions are **append-only by design** — recording a new
stance supersedes the old one rather than overwriting it, because "how my mind changed" is a
feature. And your explanations are your own writing, kept as you typed it. Both are deleted
with your account like everything else; the append-only property is about not losing your
own history to yourself, not about retaining it against your wishes.

### What the product observes

This is the category most services describe vaguely, so here it is precisely:

| Data                                                            | Table                                                        | What it is                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Which ideas you were shown, where in the feed, and what you did | `feed_impressions`                                           | Stops the feed repeating itself                                                     |
| What you opened and for how long                                | `history_events` (incl. `dwell_ms`)                          | Your history, and the reading-time signal                                           |
| Recall state per idea                                           | `knowledge_states`                                           | Stability and last-seen, from which Half-Life is computed                           |
| A numeric summary of what you know                              | `user_knowledge_vectors`                                     | The centroid the Delta compares candidates against                                  |
| Questions shown, answered or dismissed                          | `interrupt_events`, `session_seeds`                          | Bounds interleaved questions and backs off when you dismiss them                    |
| Each recall attempt, as it happened                             | `recall_events`                                              | The grade, your stated confidence and what you typed, so a retry never counts twice |
| Highlights you chose to keep                                    | `imports`, `import_items`, and pulls under a private summary | Your own copy of your own reading, so the product can schedule and search it        |
| Questions you wrote for yourself                                | `user_questions`                                             | Asked in Review before ours, because yours is the one you wanted                    |
| Learning path progress and completed steps                      | `path_progress`, `path_step_done`                            | Remembers your place, reflections and tested-out steps on curated learning paths    |
| Sources you asked to see less of                                | `muted_works`                                                | Keeps them out of your feed and your Daily Pull until you unmute them               |
| Lessons and questions of a study course you were shown          | `study_progress_events`                                      | Remembers your place in the course; never counted as recall                         |
| Answers to your study courses' questions                        | `study_answer_events`                                        | What you practised, and what you have shown you remember; what you typed is kept    |
| How well you remember each claim of your study courses          | `study_claim_memory`                                         | Leaves out lessons you know, brings back ones you got wrong, schedules review       |

**Highlights you import are yours, and stay yours.** When you keep a Kindle or Readwise
export, the text of each highlight is stored verbatim — that is the point of keeping it —
under a summary marked private that only you can read, on a source marked as your own
material. Four consequences, and each is enforced by the database rather than by our
intentions:

- It never enters anybody's feed. The feed draws only from summaries that are both
  published and public, and yours is neither.
- It is never sent to a model to write a public summary. Imports do not enter canonical
  generation at all, and nothing else reads them.
- Nobody else can see it, or see that it exists. A source with nothing readable behind it
  is invisible, so another reader listing our catalogue does not learn the titles of the
  books you have been reading.
- It is deleted with your account, along with the batch record and the questions you wrote
  about it. Undo will also let you take back a whole batch — the highlights, the review
  schedule and the saves that came with them — in one action, from Library. The database
  side of that is built; the screen it hangs off is not yet, so today an import is
  something we can do and not yet something you can.

**What an Undo leaves behind, exactly.** Not nothing, and it is worth being precise
because the point of an Undo is that you decide. We keep a one-way fingerprint of each
highlight's text, which cannot be turned back into the highlight, and where in the book it
was. Two reasons, both of which cut in your favour. It is what lets an Undo be undone —
upload the same file again and the highlights come back. And it is what stops an ordinary
re-upload of a file you have already imported from duplicating everything in it.

The record of the book does stay, and we would rather say so. Your highlights go, your
notes and grades go, the private page that held them goes — what is left is a catalogue
entry saying a book with that title and author exists, with nothing of yours attached to
it and nothing readable behind it, which means no other reader can see it at all.

That entry is yours alone: two readers who import the same book now get one entry each.
For a while they shared a single row, and the sentence here said so — until we found that
sharing it meant the second reader could read back the first reader's exact spelling of
the title and the moment they imported it, just by importing the same book. So the entry
is keyed to you, and the only thing the shared row ever shared was one reader's private
library with another's.

It stays rather than being deleted because deleting it is worse. We tried that: a delete
raced other readers' imports and took their highlights with it, in twelve of fourteen
attempts. Losing somebody else's work is not a price worth paying for tidiness, and now
that the row is yours there is nobody else's copy behind it to lose.

It also stays when you close your account, which is the one place this is weaker than we
would like: the highlights and everything you wrote about them are deleted, and the
catalogue entry is not. There is a ceiling on how many of these one account can ever
create, so this cannot grow without bound — but it is a title and an author name that
outlive the account that typed them, and that belongs in this list rather than in a
footnote.

**The text comes back; the work you built on it does not.** This paragraph used to say the
highlights came back "exactly as they were", and that was not true. A re-import creates the
idea afresh, so anything attached to the old one — a question you wrote about it, your
grades and review history for it, notes and highlights you made on it — is gone for good
when you undo, and re-uploading does not bring it back. We would rather you knew that
before you tapped it than discovered it afterwards. What we can tell you today is exact
but late: an Undo hands back the count of everything that went with the highlights —
questions, grades, notes, highlights, explanations, stances — so the screen can say what
it took. Saying it _first_ needs a rehearsal the database does not do yet, and it will
land with the screen rather than before it, because a warning nothing can show is not a
protection. If what you want is the highlights out of the way but the work kept, an
Undo is the wrong tool and we do not currently have the right one.

All of it goes with your account. If you want an import gone rather than undone, deleting
your account is currently the only way to reach that, and we would rather say so than
imply otherwise.

`user_knowledge_vectors` deserves a sentence of its own. It is a vector — a list of numbers
— averaged from the ideas you have engaged with. It is not readable prose and it is not
shown to anyone, but it is derived from your reading and we treat it as personal data
accordingly. It is deleted with your account.

**Retrievability is never stored.** How well you currently remember something is computed
at the moment it is asked for, from `stability` and `last_seen_at`. There is no nightly job
writing a decay score onto every row of your memory.

### What the servers record

Ordinary operational records: request logs held by our hosting providers, and — if you ask
the app to generate a summary or a study course — a `generation_jobs` row with your user id,
the steps it ran (`job_steps`), and what the provider call cost (`cost_ledger`). A study
course also records each request made to the model provider (`provider_calls`: when, which
model, and whether it answered), with no text from your sources in it; these records and
the costs are kept after the course is deleted, because the charge happened. Per-account
quotas, counted from your `generation_jobs` and your study spend today, limit how much of a
shared budget one account can use.

We do not collect precise location, contacts, calendar, photos, or device identifiers for
advertising.

## What never reaches a model

Law 2 of this project is that **no language model runs in the read path**. Ranking, search,
the Delta and the interleave planner are SQL and vector arithmetic executed inside Postgres.

The privacy consequence is the point: **when you read, nothing about you is sent to Google
or to any other model provider.** Models run at generation time, once, to turn a _source_
into a canonical summary that thousands of readers then share. What that call contains is
the source material and our prompt — not you, not your history, and not your library.

**The exception is a document you submit for generation.** Saving a private study
source does not send it to a model. If you ask the Studio to generate a summary of your own text, a URL, or highlights you have imported, that text is the source,
and the pipeline sends it to a model provider as the context for the summary it writes —
Google, or Anthropic where a deployment configures the fallback that answers when Gemini
is unavailable. You are doing that deliberately, but it is your content reaching a model
provider, and it deserves stating plainly rather than leaving as an implication: what
never reaches a model is your **reading** — not something you supplied to be summarised.

The Studio says that sentence on the screen, above the box, before you have typed anything
— not in this policy alone. The summary it writes is **private**: it is readable by you,
it is not published, it never enters the catalogue or anybody else's feed, and it is
deleted with your account like everything else keyed to you. Asking for one needs an
account, because generation costs real money and a guest session costs nothing to create.

**A study course is the same exception, asked for separately** — offered in Studio to
accounts in the beta, and accepted by the database from no one else. Building one sends the
title and text of the sources you chose, in passages, to Google's Gemini API, and then
sends the claims found in them, with their quoted passages, their source titles and your
goal, to write the lessons and questions. There is no fallback to another provider for
courses. It needs an account in the beta and your confirmation, each time, that you are
sending that text — including each time you prepare a course again, which sends the newest
version of each of its sources.

Checking a course, reporting part of it, correcting it and answering its questions involve
no model. An answer is checked by the database against the course's own answer, and what you
type is kept only in your account.

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

The app uses these services:

| Processor                             | What it handles                                                           | Where                                  |
| ------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| **Supabase** (and AWS beneath)        | Database, authentication, server functions                                | `ca-central-1`, Canada                 |
| **Vercel**                            | Serving the web app and its static assets                                 | Global edge network                    |
| **Google** (Gemini API)               | Generating summaries and study courses — including your own text          | Google's infrastructure                |
| **Anthropic** (Claude API)            | Studio summaries, when Gemini is unavailable and a fallback is configured | Anthropic's infrastructure             |
| **Google or Microsoft** (your choice) | Authenticating your account when you choose that sign-in provider         | The selected provider's infrastructure |

Sign-in uses Google or Microsoft through Supabase Auth. The selected provider shares your
account identifier, email address and basic profile information needed to sign you in.
We do not receive your provider password. Email codes and email/password sign-in are disabled.

That is the complete list. There is no analytics vendor, no session-replay tool, no crash
reporter, no tag manager, and no advertising SDK in the app today.

**There was a fourth, and we had not counted it.** Until recently the stylesheet loaded
three typefaces from `fonts.googleapis.com`, which meant your IP address and browser
reached Google on the first paint of every page — including this one, before you had
read a word of it. That was a request nobody had decided to make, sitting against the
sentence about cross-site tracking below. The fonts are now served from our own origin,
so the request no longer happens. It is recorded here rather than quietly fixed because
a privacy policy that has only ever been right is not evidence of anything.

**Anthropic is listed because it can be switched on, not because it is on.** The fallback is
a deployment setting (`SUMMARY_FALLBACK_PROVIDER`), not a code change, so this table and the
Studio's consent line name it before it could ever be used rather than after. Up to this
revision, every generation the hosted service has recorded ran on Gemini, apart from three
test runs on the day it launched that called no model at all; none has used Anthropic.
Study courses cannot use it at all: they call Gemini only.

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
- **Your listening settings and your listening queue.** The three settings — speed, voice
  and sleep timer — are in `localStorage`, because they describe the machine rather than
  you: a voice is an engine installed on _this_ device and means nothing on another one.
  The queue is what you have lined up to hear, so it is a reading list rather than a
  setting, and it is kept under your own id and cleared when you sign out. A guest's
  queue, and a signed-out visitor's, live in `sessionStorage` instead, so the next person
  to open the browser on a shared machine does not find it waiting.
- **Your offline library**, in IndexedDB — the Pulls cached for reading without a
  connection, today's practice downloaded so a review session survives losing signal, and
  a queue of writes made while disconnected — which is how offline reading and offline
  practice are free rather than a paid tier. All three are keyed to the account that
  fetched them, and the queued writes carry their owner and are only ever sent for them.
  Two mechanisms, one promise: a shared browser never shows one reader another's copy.
  The downloaded practice is deleted when you sign out, rather than only being hidden. The
  queued writes wait through a sign-out, to be sent when the same account signs in again,
  and are deleted from the device when you delete the account.
- **A short answer you were judging**, in `localStorage`, from when the course's answer is
  shown until what you say — whether you had it — is recorded or queued. If the page closes
  first, it is sent as you judged it, or as not had if you had not judged it yet, so an
  answer you had seen is never taken as one you remembered. It
  is kept under your own id and the page's, sent only while you are signed in, waits through
  a sign-out for you, and is removed from the device you delete your account on.
- **The app itself**, cached by a service worker.

Clearing your browser's site data removes all of it, and signs you out.

Read-aloud uses your browser's built-in speech synthesis. **No audio is recorded, and nothing
is sent to us.**

Your browser is a different matter, and the distinction is worth being exact about. Voices
come in two kinds. A **local** voice is installed on your device and speaks entirely on it —
nothing leaves the machine, and it works with no connection. A **remote** voice (Chrome's
"Google" voices, for example) is synthesised on the vendor's servers, which means **the text
of the Pull being read is sent to them**. That is between your browser and its vendor; we
neither see it nor control it, but it is not the same as fetching a voice file, and the
earlier wording implied it was.

So the app prefers a local voice **in a language you read** — your own, or failing that
another variety of it — and leaves the choice to your browser when your device has none it
could pick. That is a narrower promise than "when your device has no local voice at all",
and the difference is deliberate: a device may carry local voices in languages you do not
read, and reading an English Pull in an Afrikaans voice is not a kindness. When we hand the
choice back, your browser may well reach for a remote voice, so the paragraph above applies
— on that reading, the text is sent to your browser's vendor. Choosing a voice for yourself is coming
— the Listening settings are being built and will list local voices first — and when they
land, picking a remote voice will be a trade you make knowingly. Today the app makes the
quieter choice on your behalf.

A lesson of your own study course is read more strictly still, because it is made from your
material rather than from a published Pull: only a voice on your device ever speaks it --
the voice you chose, when it is one, and otherwise a local voice in a language you read --
and when your device has none the app says so and does not offer to read it. A lesson you
listen to joins your listening queue while the page is open, so the player's controls reach
it, and its title shows where the player's does: on the player bar, and in your device's
media controls and lock screen. It is never stored with the queue on your device: when it
ends, when you leave the lesson or close the page, or when you sign out, it is gone.

Dictation — the **Dictate** button on "say it back" — is different, and the difference is
worth stating plainly rather than leaving inside the same sentence. It uses your browser's
speech recognition, and in most browsers that is **not** on your device: the audio goes to
whoever makes your browser — Google for Chrome, Apple for Safari, Microsoft for Edge. **We never receive it**, we store no recording,
and nothing is sent to any model of ours — but your voice does leave your machine, to your
browser's vendor, under their privacy policy and not ours. The button is opt-in, per answer,
and typing the same answer sends no audio at all.

## How long we keep things

While your account exists, your data exists — unlimited history is one of the five things
this product refuses to charge for, so we are not going to quietly trim it.

You can delete an individual private study source and all its versions from Studio.
This removes the extracted text for that source, and every version of a study course and
every cached model output built from it, with their reports, history, answers and
progress, without deleting your account; a course left with no sources goes too. You can
also delete a study course and keep the sources it was built from.

When you delete your account, deletion cascades from your user record through every table
keyed to it: profile, preferences, stashes, saves, notes, highlights, history, impressions,
knowledge states, recall events, vectors, convictions and explanations. That is a foreign-key
cascade in the schema, not a scheduled cleanup job.

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

Four things survive, none of them attached to you:

- **Reports you filed about catalogue content.** `reports.reporter_id` is set to null; the
  report itself stays, so deleting an account cannot erase a moderation trail. Reports about
  your own study courses are different: they were never ours to review, and they are
  deleted with the course and with your account.
- **Spending records.** `cost_ledger` keeps a row with no user attached — a model name, a
  token count and a cost — and `provider_calls` keeps one per request made to a model
  provider: when, which model, and whether it answered. Neither ever held a user id or
  any of your text, and they are how this project can state what generation costs.
  Nothing in them identifies you.
- **The catalogue entry for a book you imported** — its title and its author, and nothing
  else. Not your highlights, which go; not the page that held them, which goes; not any
  link between it and you, which goes with your account. It stays because deleting it
  raced other readers' imports and took their highlights with it, in twelve of fourteen
  attempts, and losing somebody else's work is not a price worth paying for tidiness.
  There is a ceiling on how many of these one account can ever create, and it counts rows
  that exist rather than rows we expect to make — which it did not always, so for a while
  the ceiling could be walked past. This is the fourth, and it was three until we looked
  properly.
- **Backups**, for up to 30 days, after which they roll off.

**A guest session is deleted for you.** Unused for a day, it is removed outright from the
database — account row, preferences, history, everything keyed to it — by a scheduled
sweep (`sweep_guest_accounts`). This is the one place where the "while your account
exists, your data exists" rule above does not hold, and deliberately: a guest session has
no address, so nobody can come back to it and nobody can ask us to delete it. Keeping it
indefinitely would be hoarding reading history belonging to people we cannot contact.

The sweep reaches our database and not your device. The offline copy the app keeps in your
browser — the Pulls it cached to read without a connection, a practice pack if you
downloaded one, and anything you wrote while offline that had not yet been sent — is not
cleared when the session ends. It is keyed to the account that made it, so an offline load
shows a reader only their own copy: on a shared computer the next person is never shown
the previous person's cached feed, and the queue of unsent writes was kept apart the same
way from the start. Earlier versions of the app kept the cached feed without recording
whose it was, and this document said so; those rows are discarded the first time the
current version opens, because nothing in them could say which reader they belonged to.
Clearing the site's data in your browser removes all of it.

Anything published under a future community feature is covered in the Terms.

## Your rights

Four of these you do yourself, without asking and without waiting, from
**Account**:

| Control                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Download everything**     | Every row stored against your account, as one JSON file — including each recall attempt as it happened, the reports you have filed, the seeds that decided your reading order, and the vector described above. Paged in a fixed order, so a large library is neither truncated nor double-counted. Two things are held back on purpose: your unspent recovery codes, which exist to be shown once and not written into a file you might email yourself, and the operational rate counters, which are not yours in any meaningful sense. If any table cannot be read, the file names it rather than quietly leaving it out. |
| **Where you are signed in** | Every session, with the device and when it started. End any of them, or all but this one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Second factor**           | An authenticator app, with single-use recovery codes for when you lose it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Delete this account**     | Immediate and irreversible, after a recent sign-in and typing CONFIRM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
- Sign-in goes through Google or Microsoft. There is no password with us to breach because
  we never hold one.

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

**whatapull@proton.me** — privacy questions, requests and complaints, anything under "Your
rights" above, and vulnerability reports. See [`SECURITY.md`](../SECURITY.md) for what to
expect on a security report and how quickly, and for GitHub's private vulnerability
reporting as an alternative.

Monitored by the operator named in the [Terms](./terms.md). It is a project mailbox rather
than a personal one, and it is new: this section named `privacy@whatapull.com` until
recently, at a domain the project does not own, so a privacy request reached a stranger
rather than the operator — which defeats the point of having a privacy contact at all.

Worth knowing either way: every right under "Your rights" above is exercisable without
reaching us. Export and deletion are both self-service from your account. Nothing you are
entitled to depends on us answering mail.

Separate role addresses return when there is a domain to host them on. The argument for
them still holds: a privacy contact that is one person's inbox stops working the moment
that person is unreachable, and this repository is public, which makes anything written
here permanently indexed.
