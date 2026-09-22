## What and why

<!-- One concern per pull request. The diff says what changed; explain why it needed to.
If it fixes something, describe the failure a reader saw or a query returned. -->

Related issue: <!-- Fixes #123, or "none — focused self-contained change" -->

## The laws

<!-- CLAUDE.md. Delete the ones the diff cannot touch; do not tick a box you have not
thought about. -->

- [ ] **1 · Design** — no gradients, no shadows, one accent. `packages/ui` unchanged, or
      `design-laws.test.ts` still passes.
- [ ] **2 · Cost** — no model call in the read path. Ranking, search and the Delta are
      still SQL and vector maths.
- [ ] **3 · Free** — audio, offline, history, stashing and Daily Pulls are still free
      and still unbounded.
- [ ] **4 · Rights** — no copyrighted source text added. Anything new is public domain
      or openly licensed.
- [ ] **5 · Privacy** — every table this touches has RLS enabled and a policy, and I ran
      `pnpm db:lint`.
- [ ] **6 · Migrations** — append-only. I added a migration rather than editing one.
- [ ] **7 · Secrets** — nothing but the publishable key reaches `apps/web` or a `VITE_*`
      variable.

## Backend / Supabase

<!-- Delete this section when the change does not touch backend behavior. Contributors
and reviewers validate against the local stack; hosted access is not required. -->

- [ ] A clean `pnpm db:reset` replays the change from zero.
- [ ] RLS and authorization behavior is covered as the real reader or visitor role,
      including a denial case where relevant.
- [ ] `pnpm db:lint` and `pnpm db:test` pass.
- [ ] I ran `pnpm db:types` and committed the generated diff, or the schema is unchanged.
- [ ] Any `SECURITY DEFINER`, service-role, authentication, cross-user, backfill, or
      compatibility behavior is explained below.

Backend risk notes: <!-- "none", or explain the boundary and rollout concern -->

## Checks

- [ ] `pnpm check` passes
- [ ] Every commit is signed off (`git commit -s`) — see CONTRIBUTING.md

## AI assistance

- [ ] I used an AI assistant on this change.

Using one is fine. The rule is the same either way: **you must be able to explain this
diff** — every line, why it is there, and what happens if it is wrong. If any claim in
the description or the comments says something was measured or verified, say how.
