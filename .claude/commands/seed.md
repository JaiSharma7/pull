---
description: Reset the database and reseed the public-domain corpus.
---

`pnpm db:reset`, then verify the seed landed: every seeded work has a published summary,
every summary has pulls, and every pull has an embedding.

Only public-domain and openly-licensed material belongs in the seed. Rights law
(`CLAUDE.md` §4) — no copyrighted source text in this repository, ever.
