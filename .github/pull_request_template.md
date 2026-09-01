## What and why

<!-- The diff says what changed. This should say why it needed to. If it fixes
     something, describe the failure: what a reader saw, or what a query returned. -->

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

## Checks

- [ ] `pnpm check` passes
- [ ] `pnpm db:lint` and `pnpm db:test` pass (if `supabase/` changed)
- [ ] Every commit is signed off (`git commit -s`) — see CONTRIBUTING.md
      **Contributor licence — tick exactly one.** Nothing in CI reads these; a reviewer
      checks them before merging, which is why leaving both blank is not a neutral state.

- [ ] This is my first contribution. I have read `CLA.md` in the repository root, I
      agree to it, and I have added myself to `CONTRIBUTORS.md` in this PR.
- [ ] I have contributed before and am already listed in `CONTRIBUTORS.md`.

## AI assistance

- [ ] I used an AI assistant on this change.

Using one is fine. The rule is the same either way: **you must be able to explain this
diff** — every line, why it is there, and what happens if it is wrong. If any claim in
the description or the comments says something was measured or verified, say how.
