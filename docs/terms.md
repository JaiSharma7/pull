# Terms of Service

**Effective 1 September 2026.** Every revision of this document is a commit in
[this file's history](https://github.com/JaiSharma7/pull/commits/main/docs/terms.md), so
what changed and when is public record.

**Why this revision takes effect immediately rather than on notice.** §14 promises
material changes are announced before they take effect, and that is a real promise about
your obligations as a user. This revision changes none of them. The licence row below is
_descriptive_ — it reports which licence the repository carries, and the repository
carries the AGPL from the moment that commit landed. Dating the description forward would
not delay anything; it would only make this document describe the repository incorrectly
for a month, which is the opposite of notice. §7's contributor terms are new obligations,
but only for someone about to contribute, who meets them at that moment rather than
retroactively.

**The in-app announcement §14 describes is not built yet.** Saying so is better than
letting the clause imply a mechanism that does not exist. Until it is, this file and its
history are the notice — which is why the pointer to that history is the first thing
above.

These terms are a contract between you and the operator of **What a Pull** ("we", "us")
covering the hosted service at whatapull.com and its apps. By using the service you accept
them. If you do not, do not use the service.

**Three different things live in this repository, and only one of them is governed here.**
Confusing them is the easiest mistake to make now that the source is public, so:

|                                                                                               | Governed by                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The hosted service** at whatapull.com — the account you sign into, the Pulls you read there | These Terms and the [Privacy Policy](./privacy.md)                                                                                                                                 |
| **The code** — everything in this repository                                                  | The [GNU AGPL v3](../LICENSE). Do what it permits, including running your own instance — but if you modify it and let others use it over a network, you must offer them its source |
| **Your own instance** — what you get when you deploy it                                       | Nothing here. You become the operator, and the obligations these Terms describe become yours toward your own users, including the data-protection ones                             |

Running your own copy does not make you our user and does not make us your processor. If
you offer it to other people, the Privacy Policy in this repository describes _our_
service; publishing it unchanged as a description of yours would be inaccurate.

## 1. Who may use it

You must be at least 13. If you are in the EEA and under 16 — or under whatever higher age
your country sets, up to 16 — you need a parent or guardian's permission. If you are using
this on behalf of an organisation, you are confirming you have authority to bind it.

One human, one account. Do not share credentials, and tell us promptly if you think someone
else has access to yours.

## 2. Your account

Sign-in is a code or link sent to your email, so **keeping access to that mailbox is what
keeps you in control of your account**. There is no password to recover.

You can also look around as a **guest**, without giving us an address. A guest session is
covered by these Terms exactly as an account is, with two differences that follow from
there being no address: we cannot restore it to you if it is lost, and it is deleted
automatically after a day of disuse. A day is measured from when you last used it, not
from when it was created, so a guest session does not end underneath somebody who is
still reading. Requesting a generation, publishing a summary and filing a report all need
an account.

You can delete your account at any time. We can suspend or terminate one for a clear breach
of section 5, for conduct that puts other readers or the service at risk, or where the law
requires it. Except where the breach is serious or urgent, we will tell you why and give you
a chance to respond.

## 3. What it costs, and what stays free

The service is free. It will be funded by advertising, which is disclosed rather than hidden.

**Five things are free permanently**, and this is a commitment we are prepared to be held
to rather than marketing copy:

1. Listening to Pulls read aloud
2. Reading offline
3. Unlimited reading history
4. Unlimited saving and stashing
5. Curated Daily Pulls

Each is free because of how it is built — audio and offline reading run entirely on your
device, and the rest are rows in a database — so none of them has a per-reader cost worth
metering. **We will not move any of the five behind a payment, a subscription, or an
advertisement you must watch to proceed.** If we ever introduce a paid tier, it will be for
capabilities that genuinely cost money per reader, and those five will not be among them.

Ad removal is deliberately not on that list. When advertising arrives it will be clearly
marked, it will not interrupt an idea part-way through, and rewarded formats — if used at
all — will only ever apply to expensive generation, never to the learning features.

## 4. The content

### Ours and our licensors'

The design system, the software and the service itself are owned by us or our licensors —
the software under the GNU AGPL v3 in this repository. You may read, save, quote with
attribution, and share links. We ask that you not scrape the corpus in bulk, redistribute
it as a competing dataset or product, or train a model on it.

**How strong that claim is, honestly.** Most summaries here are produced end to end by a
language model, and under current U.S. Copyright Office guidance material generated
without human authorship is not protected by copyright. So for those, the paragraph above
is a term of this agreement — binding on you because you accepted it in order to use the
service — rather than a copyright we can assert against the world. Where a human selected,
arranged, edited or wrote, that part is ours in the ordinary way. We would rather state
the distinction than imply a stronger claim and hope nobody checks.

Where a source is in the public domain, the underlying work is free for anyone, and always
was. Nothing here narrows that.

### That it is machine-generated, and imperfect

**Summaries are produced by language models and are interpretations, not the source.** They
can be wrong, incomplete, out of date, or confidently mistaken about a book they describe.
Every Pull names its source, and a source page carries the author and a link to the
original where we hold one, so you can check it — checking it is the intended use.

Works generated before the schema could store a link do not all have one yet, and a
summary produced from text somebody pasted in has no public original to point at. Where
the link is missing, the summary is still an interpretation and should be treated as one.

Nothing here is **professional advice** — not medical, legal, financial, or psychological.
Ideas from a summarised book are not a substitute for a professional who knows your
situation.

### What we deliberately do not publish

This is an analysis product, not a substitution product. We publish ideas, arguments,
criticism and commentary. We do not publish chapter-by-chapter replacement text, extended
quotation, reproduced passages, or scene-by-scene retellings. The reasoning is in
[`content-policy.md`](./content-policy.md), and it is a product rule before it is a legal
one: a summary that replaces the book is both more legally exposed and a worse way to learn.

If you believe something we have published crosses that line, section 8 is how to tell us,
and we would rather hear it early.

### Yours

Your notes, highlights, explanations, stances and saved collections are **yours**. We claim
no ownership.

To run the service we need a limited licence to what you put into it: a worldwide,
non-exclusive, royalty-free licence to store, back up, reproduce and display your content
**to you**, and to process it to provide the features you are using. Nothing more. We do not
use your private content to train models, and we do not show it to other readers.

If you later publish something — public stashes and community contributions are planned, not
built — publishing extends that licence to what publication plainly requires: displaying it
to others, and allowing them to reference or fork it with attribution intact. Deleting
published content withdraws it going forward; it cannot retract copies others already made.

You are responsible for having the right to upload what you upload, and you keep that
responsibility even after we have processed it.

## 5. Acceptable use

Do not:

- Upload or publish material you have no right to, or ask the service to reproduce a
  copyrighted work rather than analyse it
- Post content that is unlawful, harassing, hateful, sexual content involving minors, or
  that incites violence
- Attack the service — probe or bypass access controls, exhaust resources, evade rate limits,
  or attempt to reach other readers' data
- Automate access outside anything we have documented as permitted, or scrape at scale
- Impersonate anyone, or misrepresent a source
- Resell, sublicense or otherwise commercially redistribute the service or its corpus

**Security research is welcome**, and [`SECURITY.md`](../SECURITY.md) says what is in
scope, what is not, and what we already know about. Testing against your own account and
reporting what you find in good faith — to **security@whatapull.com** or through GitHub's
private vulnerability reporting — is not a breach of these terms, and we will not pursue
you for it. Give us reasonable time to fix an issue before publishing it, and do not
access, alter or exfiltrate anyone else's data while you look.

The source, the schema and every policy are public, and a local stack is one command
away, so there is rarely a reason to probe the hosted service to find something.

## 6. Generation, quotas and cost

Asking the service to generate a summary spends real money on our side, so requests are rate
limited and quotas apply. We may adjust them, decline a request, or refuse a source
altogether — a source whose rights status is unresolved is not publishable and will not be
published.

Generating a summary of a document you supply does not make it public. It stays private to
you unless you publish it, and it is subject to the same rights rules as everything else.

## 7. Contributing to the code

Contributions to this repository are governed by the [GNU AGPL v3](../LICENSE), not by
these Terms. Inbound is outbound: what you send is licensed to everyone on exactly the
terms the project is already on.

There is **no contributor licence agreement**. Instead, every commit carries a
`Signed-off-by:` line — the [Developer Certificate of
Origin](https://developercertificate.org/) — which is you stating that you wrote the
change or have the right to submit it. CI checks for it. `CONTRIBUTING.md` has the
details, including what is expected if you used an AI assistant.

You keep copyright in what you write, and we gain no right to relicense it. Contributed
code stays AGPL, and cannot be taken proprietary by anyone, us included.

Contributing code does not create an account relationship, and does not make you a user
of the hosted service.

## 8. Copyright complaints (DMCA)

We respond to notices modelled on the **Digital Millennium Copyright Act, 17 U.S.C. § 512**,
and we terminate the accounts of repeat infringers.

**Being straight about the safe harbour.** § 512(c) protection requires the designated
agent to be _registered with the U.S. Copyright Office_, and that registration has not
been completed. So this is the § 512 process, followed in full and in good faith, and we
do not currently claim the statutory safe harbour that comes with registering. Nothing
below changes for you as a rights holder: the notice reaches a monitored address and is
acted on. It is recorded because claiming a protection one has not perfected is the kind
of paper shield that is worse than none — and because this repository is public, so the
claim is checkable.

**To report infringement**, send to the designated agent below a written notice including:

1. Your physical or electronic signature
2. Identification of the copyrighted work you say is infringed
3. Identification of the material on the service and where to find it — a link
4. Your address, telephone number and email
5. A statement that you believe in good faith that the use is not authorised by the owner,
   its agent, or the law
6. A statement, **under penalty of perjury**, that your notice is accurate and that you are
   the owner or authorised to act for them

**Designated agent:** copyright@whatapull.com

**Counter-notice.** If your material was removed and you believe that was a mistake or a
misidentification, you may send a counter-notice with your signature, identification of the
removed material and where it appeared, a statement under penalty of perjury that you believe
in good faith it was removed by mistake, and your contact details together with consent to
the jurisdiction of the federal court for your district (or, if outside the US, any district
where we may be found). We may restore the material after 10 business days unless the
complainant files suit.

Knowingly misrepresenting that material is infringing — or was wrongly removed — carries
liability for damages under § 512(f).

## 9. Reports and moderation

You can report content. We review reports, and we can remove material or restrict an account
where these terms or the law require it. Decisions are logged. Where we remove something you
posted we will tell you what and why, unless the law prevents us, and you can dispute it by
replying.

## 10. Availability, and changes to the service

The service is provided as it is. We may change, suspend or discontinue features, and this
is early software — expect defects. Where we discontinue something material and you have
content in it, we will give reasonable notice and a way to export.

## 11. Disclaimers and liability

**To the fullest extent permitted by law**, the service is provided **"as is" and "as
available"**, without warranties of any kind, express or implied, including merchantability,
fitness for a particular purpose, non-infringement, and any warranty that the content is
accurate, complete or current.

**To the fullest extent permitted by law**, we are not liable for indirect, incidental,
special, consequential, exemplary or punitive damages, nor for lost profits, lost data or
lost goodwill. **Our total aggregate liability is limited to the greater of the amount you
paid us in the twelve months before the claim — which for a free service is nothing — or
US$100.**

Some jurisdictions do not allow the exclusion of certain warranties or the limitation of
certain damages. **Nothing in these terms excludes or limits liability for death or personal
injury caused by negligence, for fraud or fraudulent misrepresentation, or for anything else
that cannot lawfully be excluded** — and if you are a consumer, your statutory rights are
unaffected. Where such a limit is unenforceable against you, it applies only to the extent
permitted.

## 12. Indemnity

If you are using the service for business purposes, you agree to indemnify us against claims
arising from your content, your use of the service, or your breach of these terms. This does
not apply to you as a consumer using the service personally.

## 13. Governing law and disputes

These terms are governed by the laws of the **State of Delaware, USA**, without regard to its
conflict-of-laws rules. Disputes go to the state and federal courts located in Delaware, and
we each consent to their jurisdiction.

**If you are a consumer**, this does not deprive you of the protection of the mandatory laws
of your country of residence, or of your right to bring proceedings there where local law
gives you that right.

**Talk to us first.** Email the address below with what happened and what you want. Most
things end there, and we would rather resolve a problem than litigate it.

## 14. The rest

- **Whole agreement.** These terms and the [Privacy Policy](./privacy.md) are the agreement
  between us on this subject.
- **Severability.** If a provision is unenforceable, the rest stands.
- **No waiver.** Not enforcing something once does not waive it.
- **Assignment.** You may not assign these terms; we may, on notice, to a successor.
- **Changes.** Material changes are announced in the app before they take effect and the
  effective date above changes. Continuing to use the service afterwards accepts them; if you
  do not accept, delete your account. The diff between any two versions of this file is
  public.
- **Survival.** Sections 4, 5, 10, 11 and 12 survive termination.

## 15. Contact

| Address                     | For                                                                          |
| --------------------------- | ---------------------------------------------------------------------------- |
| **legal@whatapull.com**     | Legal notices and anything about these Terms                                 |
| **copyright@whatapull.com** | Copyright complaints and counter-notices — the designated agent in section 8 |
| **privacy@whatapull.com**   | Data requests and anything in the [Privacy Policy](./privacy.md)             |
| **security@whatapull.com**  | Vulnerability reports — see [`SECURITY.md`](../SECURITY.md)                  |

Role addresses rather than a personal mailbox, because this repository is public and an
address written here is indexed permanently.
