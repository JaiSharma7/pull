---
name: Source suggestion
about: A public-domain work the corpus should carry
labels: content
---

**Title, author, and a URL.**

**Why it earns a place.** The corpus is deliberately spread across philosophy,
politics, science, economics and craft — a feed of nothing but Stoicism makes the Delta
look clever and tells a reader nothing, because everything sits near everything else.

**Rights.** It has to be unambiguously public domain: first published well before 1929,
and if it is a translation, the _translation_ must be too. See `docs/content-policy.md`.

**Length.** `MAX_SOURCE_CHARS` is 200,000. A full-length book gets summarised from its
opening third and labelled as though it were the whole, which is a quiet way to be
wrong — essays, letters, speeches, single chapters and papers all fit comfortably.

If you can, run `node scripts/seed-corpus.mjs --check` with your entry added and say
whether it passed.
