# Agentic engineering

How work gets done in this repository when an agent is driving. `CLAUDE.md` holds the
project's laws; this file holds the process.

## The unit of work is a pull request

One concern per PR. Green CI. A description that explains _why_, not just what — the
diff already says what. Never push straight to `main`.

Work happens on a feature branch, is reviewed by two independent reviewers (below), and
merges only when both are satisfied.

## The review gate

**Mandatory, in this order, for every PR. No step is skippable.**

1. **All four CI checks green** — `lint`, `typecheck`, `test`, `db`.

2. **Request Codex review.** Comment `@codex review` on the PR. Then _wait_. Do not
   merge, and do not start unrelated feature work on the same branch, while it is
   pending.

3. **Address every Codex comment.** For each one: fix it and push, or reply on that
   thread explaining precisely why it does not apply. "Out of scope" is a legitimate
   answer; silence is not. Re-request review after pushing.

4. **Repeat 2–3 until Codex signs off.** A round that returns new findings is not a
   pass. On a large PR, expect at least two rounds — a first review of a big diff that
   returns nothing usually means the reviewer did not run, so check before believing it.

5. **Then run `/code-review` scoped to the branch**, and address its findings the same
   way. Running it _after_ Codex is deliberate: it reviews the code that will actually
   merge, including everything the Codex rounds changed.

6. **Merge** — only once both reviewers are satisfied and all four checks are green on
   the final head.

If Codex is not installed on the repository, its review never arrives. Say so and stop;
do not wait indefinitely, and do not merge around the gate on the assumption it passed.

## Modes

| Situation                                                             | Mode                                          |
| --------------------------------------------------------------------- | --------------------------------------------- |
| Data model, a product law, or anything architectural                  | **Plan mode** — design and get approval first |
| Mechanical work already designed (types, tests, a drafted migration)  | `acceptEdits`                                 |
| Destructive or outward-facing (dropping data, force-push, publishing) | **default** — confirm                         |

## Loops

- `/loop 20m /ship` — drive open PRs toward green unattended.
- `/loop` with no interval — self-paced iteration; pick the delay from what is actually
  being waited on, not from habit.
- Background long jobs rather than blocking on them. Never `sleep` to wait for an
  external event — PR activity arrives as a wake.

## PR events

Call `subscribe_pr_activity` on every PR you open, then follow through. On a PR you
opened, red CI or an unanswered review comment is work **now**, not a note for later:
reproduce the failure, fix it, prove the fix locally, push once. One validated push
beats three speculative ones.

`.claude/skills/steward/SKILL.md` carries the repo-specific rules for handling those
events and is read automatically when they arrive.

## Subagents

Sparingly, and by default only when asked. `Explore` for fan-out search across many
files; `Plan` for architecture. A subagent starts cold and re-derives context you already
have — for most tasks, doing it inline is both faster and better.

## Escalation

When two readings of a request would produce materially different work, ask. Otherwise
decide, proceed, and record the assumption in the PR body. Finish the whole task; if part
of it is genuinely blocked, complete everything else and say plainly what was left and
why — scaling the work down is the requester's call, not yours.
