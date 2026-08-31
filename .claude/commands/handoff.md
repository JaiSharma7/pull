---
description: Produce the evidence packet for work you are handing back — outcome, checks actually run, live deployment state, rollback handles, and what is left.
---

Return one completion packet. Evidence, not narrative of effort.

Evaluate, do not recall. Every line below is either something you ran just now and can
quote, or something you say plainly you did not verify.

1. **Outcome** — what now works for a reader, in the terms they would use.
2. **Acceptance** — the run plan's morning criteria as a table: criterion, how it was
   checked, result. If there is no run plan, the acceptance criteria are the ones stated
   when the work was requested.
3. **Scope** — files, migrations, edge functions, and configuration changed.
4. **Decisions** — the assumptions recorded along the way, and why each was taken.
5. **Evidence** — exact commands and their results. `pnpm check`; CI check state on the
   merged head sha; `get_advisors` for any `supabase/` change; `/design-check` for any
   `apps/web/` or `packages/ui/` change; the paired verification query for every
   migration, with its output.
6. **Deployment** — the newest production deployment's state and `githubCommitSha`,
   confirmed against `origin/main`. A `READY` status is not proof a reader sees the
   change; say which you checked. If nothing was deployed, say so.
7. **Cost** — total `cost_ledger` spend against the cap, and the failed-job count. Report
   it; never round it away.
8. **Risk** — final tier, and the reasoning.
9. **Rollback** — the last known-good deployment id and sha, the merge commits to
   `git revert -m 1`, the compensating migration, and how to retire generated content.
10. **Left for a human** — only what needs access or judgement you do not have. Anything
    you could have finished and did not is a failure to report, not an item to delegate.
11. **Learning** — at most one durable lesson, at the right scope: a law belongs in
    `CLAUDE.md`, a procedure in a skill, a nonnegotiable check in a hook. Nothing that the
    repo already says or that a reader could infer from the diff.

Do not use "should work", "appears fixed" or "probably" in place of a check. If a gate
could not run, say exactly why and reduce the completion claim to match.
