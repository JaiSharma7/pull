# Content policy and rights

> This is a product-design risk posture, not legal advice. An attorney familiar with
> copyright should review the ingestion and publication system before public launch.

## The principle

Copyright does not protect ideas, procedures, concepts or discoveries — but it does
protect expression, and the statutory definition of a derivative work expressly includes
**abridgments and condensations**. A summary is therefore not automatically safe, and
there is no word count or percentage below which copying is automatically fine.

So What a Pull is built as an **analysis product**, not a substitution product.

## What we publish

| Prefer                      | Avoid                                         |
| --------------------------- | --------------------------------------------- |
| Ideas and arguments         | Chapter-by-chapter replacement text           |
| Commentary and criticism    | Long quotations                               |
| Applications and examples   | Reproduced passages                           |
| Cross-source comparison     | "Here is effectively the whole book, shorter" |
| Questions and counterpoints | Scene-by-scene retellings                     |

For **film and television** this matters most. Detailed plot retellings have been
litigated precisely because they can substitute for experiencing the work. So:

**Not this**

> Scene 1 happens. Then Character A says X. Then Character B does Y. Then the ending is…

**This**

> **Central idea: memory and identity.** The film asks whether identity comes from
> objective history or from the memories through which a person understands it.
> **How the film explores it:** unreliable perspective, visual motifs, and deliberate
> ambiguity about the protagonist's past.

That is both the more defensible use and the better learning product.

## Rights status is a first-class field

Every `works` row carries one:

- `public_domain` — the easiest place to build a rich launch corpus, and where our seed lives
- `licensed`
- `user_owned` — a user's own document, private by default
- `public_reference` — publicly accessible material referenced with attribution
- `community` — contributed, subject to the UGC workflow below
- `review_required` — the default for anything unresolved; not publishable

## The repository is not the database

```
OPEN SOURCE REPOSITORY          ≠        HOSTED SERVICE DATA
code · schemas · prompts                 generated summaries
sample public-domain content             community submissions
tests                                    licensed metadata · user libraries
```

**Never commit** copyrighted book text, screenplay text, transcripts we lack rights to,
pirated PDFs or ripped media. This is enforced socially in review and stated in
`CONTRIBUTING.md`; there is no automated check that can catch it, so it needs attention.

## User-generated content

Once users publish generated summaries or uploads, the hosted service becomes a host of
third-party material and needs the §512 machinery before that launches:

```
Report infringement → rights queue → disable/investigate
   → notify contributor → counter-notice where applicable → resolution
```

Backed by: a designated agent and a public copyright-contact process, a repeat-infringer
policy, user reporting, moderation logs, content hashes and version history. The
`rights_requests` and `moderation_decisions` tables exist for exactly this and are in the
schema from the start, before the feature that needs them.

There is a commercial reason too: ad networks prohibit monetising infringing content, so
getting this wrong breaks the funding model as well as the legal position.

## Attribution

Every Pull keeps its source identity, links back to a legitimate original, and carries
claim-level `citation_anchors` where possible. This is also the answer to the most common
criticism of micro-content — that it dead-ends with no way into the real material.
