---
name: overnight
description: How an unattended run works in What a Pull — the autonomy contract, file-ownership isolation, wave pacing, hard stops, the abbreviated review gate and the morning handoff. Read before starting or joining any run where nobody is awake.
---

# Shipping overnight

An unattended run is not a long working session. It is a different discipline, because
the one resource every other workflow depends on — a person who can answer a question —
is gone. Every question is a stall. Every ambiguity is a stop. Every optimistic claim is
a lie told to someone who is asleep and cannot check it.

This skill is what replaces that person. `docs/overnight-plan.md` is a full worked
example: the night of 2026-08-31, with its run log intact. Read it for shape; read this
for the rules.

## 0. Before dark — establish what is actually true

```bash
./scripts/preflight.sh      # capabilities, not assumptions
```

Record its output in the run plan's environment table. The most expensive thing that can
happen at 2am is discovering that a capability the plan assumed does not exist — no
Docker daemon means `db:reset` and `db:lint` cannot run and CI becomes the only migration
replay oracle; a missing egress allowlist entry means URLs cannot be validated the obvious
way. Both are survivable when known at dusk and night-ending when discovered at three.

Write each constraint down with its **consequence**, not just its name. A table of facts
nobody drew a conclusion from gets re-derived by every session.

## 1. The contract

Autonomy is proportional to verifiability. Before the run starts, write down:

| Field           | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| Objective       | One outcome, observable by a reader. Not "improve the app".             |
| Evaluator       | The exact command, query or observation that returns pass or fail.      |
| Baseline        | What that evaluator returns right now.                                  |
| Caps            | Wall clock, provider spend in cents, pushes per PR, commits, sessions.  |
| Allowed scope   | Directories and files, per session.                                     |
| Forbidden scope | Named. Auth, billing, production data, and anything on the frozen list. |
| Stop conditions | Target met, no valid move remains, or a cap is hit.                     |

**Never change the evaluator to make progress look better.** If the evaluator turns out
to be wrong, that is a finding to record, not a number to edit.

Caps exist because a long loop amplifies a bad objective. `Budget ≤3 pushes per PR` is not
frugality — on a Hobby plan with one concurrent build it is the difference between a
deploy queue that drains and one that never does.

## 2. Standing rules for every session

1. **Never ask.** Do not call `AskUserQuestion`. Do not end a turn waiting for input.
   Decide, and record the decision in the PR body under `## Assumptions`.
2. **Never end a turn on a red PR you opened.** Reproduce, fix, push. If genuinely
   blocked, comment once on the PR with exactly what is blocking and what you tried, then
   continue with the rest of your scope. Blocked on one item never means idle.
3. **Stay inside your ownership boundary** (§3). If your work seems to need a file owned
   by someone else, stop and report it in your PR body rather than editing it.
4. **Rebase before every push.** `main` moves all night: `git fetch origin main && git
rebase origin/main`, re-run checks, push.
5. **`pnpm check` before every push.** With no local database it is the whole local gate.
   The secret scan runs itself — see §6.
6. **Self-merge is authorised** once §6's gate passes. Do not wait for a human.
7. **Only the session that owns generation may cause provider spend**, capped in cents by
   the contract. Everyone else: zero.
8. **Never** skip, disable or quarantine a test; weaken `supabase/tests/lint.sql`;
   hand-edit `packages/db/src/database.types.ts`; force-push; or edit an applied
   migration.
9. **The seven laws in `CLAUDE.md` bind absolutely.** A diff that breaks one is wrong even
   if it works, and time pressure is not an exception — it is when the laws earn their
   keep.
10. **Subscribe to your own PR** (`subscribe_pr_activity`) so CI failures wake you.
11. **Finished early?** Do not invent features. Take the next item from the run plan's
    deferred list.

Permissions are pre-granted at launch, not negotiated at 3am. A session that hits a
permission prompt while merging is a session that stalls until morning — check
`.claude/settings.json` covers every tool the plan needs before dark, and launch
unattended sessions in a mode where the `ask` entries will not block.

## 3. Isolation — decompose by file, not by feature

Two agents editing one file is the failure this whole section exists to prevent. A merge
conflict at 4am costs more than any duplication it would have saved.

- **One writer per file, for the whole night.** Ownership is assigned in the run plan and
  does not move. Features that share a file are one session's work, not two.
- **The frozen list.** Name explicitly the files nobody may edit — the app shell, the
  shared API and session modules, the design tokens, `package.json`, `turbo.json`,
  `eslint.config.js`, the CI workflow. These are the hottest conflict surfaces in the
  repo and freezing them is worth more than whatever a session wanted to change.
- **Ship the seams first.** The shell session creates every file later sessions will need
  — honest one-paragraph stubs, the final navigation, empty stylesheets already imported
  — then never touches them again. Wave 2 fills in files that already exist and already
  compile, so no leaf session ever edits the shell.
- **Deliberate un-DRY beats a conflict.** Three small `*-api.ts` files instead of
  extending the one shared module is the right call at 2am. Record the merge-back as
  follow-up in the PR body so it is a decision, not a mess.
- **Exactly one session writes SQL.** The default for any feature is no migration.
- **Waves, not a free-for-all.** Wave 1 is the shell plus the long pole; wave 2 is leaf
  screens gated on the shell having merged and deployed; wave 3 is a serialized merge
  queue, smallest blast radius first, confirming a `READY` deploy between merges.

Parallelise only what can succeed independently. Anything touching a shared schema,
contract or foundational type is sequenced.

## 4. Pacing — leave finished work behind at every hour

Long-running generation runs in **waves**, never one big batch. A wave that finishes in
~25 minutes leaves publishable content behind, so a night that dies at T+2 still wakes the
owner to a real result instead of a queue full of nothing.

- Launch the next wave when work in flight drops below a threshold, not on a timer.
- **Any one of these halts new enqueues:** past the drain window; spend over the cap; a
  wave failing more than ~20%; or the published count failing to increase for 30 minutes.
- **Do not tune throughput as a first move.** Doubling the dispatcher rate doubles
  concurrent provider calls, and a retryable 429 inside a fixed time budget turns into a
  permanent failure. Change it only on measured evidence of headroom, and know the
  rollback call before you make it.
- **Triage by cause, not by mood.** A fetch error is a bad input — drop it, never
  re-enqueue. A provider 429/503 is transient — pause, do not retune. A token-limit
  failure means the input is too long — drop it. Track poison pills so no later wave
  pays for them twice.
- **A structural critic is not a quality gate.** Read a few generated cards by eye each
  wave. A wave that reads badly is _stopped_, not tuned at 3am.

## 5. Verification — evidence, never inference

- **Never claim fixed, working, deployed or passing from code inspection.** Run the check.
- **Verify after applying; never assume.** This repo's sharpest lesson is a column-level
  `revoke` that ran cleanly, reported success, passed review, and changed no privilege at
  all. Every migration carries a paired verification query whose output goes in the PR
  body — and it must confirm the changed state itself, not merely that the statement ran.
- **Prefer changes with no type surface.** Rows, defaults, grants and
  `create or replace function` at an unchanged signature leave `database.types.ts` alone,
  so CI's staleness check cannot fire and the night does not stall on a generated file.
- **CI is the replay oracle** when no local stack exists. Green on the branch is the
  precondition for touching production, never the reverse.
- **Write the compensating SQL before applying.** Append-only means rollback is a new
  migration, and 4am is the wrong time to compose one.
- **Advisors after every apply.** A new security finding is a stop. Known-and-accepted
  findings belong in the run plan by name, so a session can tell new from old.

## 6. The gate, when the four reviewers cannot run

`AGENTS.md` is the standard: Codex first, then four parallel specialists, repeated until a
round comes back clean. Overnight, a metered reviewer stalls a branch at the worst moment.
The substitute, per PR:

1. All four CI checks green **on the head being merged**.
2. **`/code-review` at high effort** — fix every finding, or say in the PR body why it
   does not apply.
3. **`/design-check`** on any diff touching `apps/web/` or `packages/ui/`.
4. **`get_advisors`** clean on any diff touching `supabase/`.
5. **The secret scan** — `./scripts/secret-scan.sh`, which the `PreToolUse` hook in
   `.claude/settings.json` already runs before every commit and push. A hit is a stop, not
   a judgement call, and a leaked key is **rotated**, not quietly removed from the diff.
6. **Then self-merge**, recording in the PR body that the abbreviated gate was used.

Using the abbreviated gate is a decision to write down, not a default to slide into. If
the full gate can run, run it.

## 7. Morning — handoff by evidence

Run `/handoff` at the end. It produces the packet: what now works, what changed, what was
decided and why, the exact checks and their results, the final risk tier, the deployment
actually verified live, the rollback handles, and what is left.

Two rules about that packet:

- **Acceptance criteria, not vibes.** Each one is a query or an observation with an
  answer, decided at dusk and evaluated at dawn.
- **Report the failures.** Failed jobs, cut scope, gates that could not run, and exact
  spend go in the brief. "Should work" and "appears fixed" are not results. Hiding a
  partial failure behind optimistic wording is the one unrecoverable mistake of an
  unattended run, because it destroys the owner's ability to trust any of the rest.

Keep the rollback handles concrete and current: the last known-good production deployment
id and sha; `git revert -m 1 <merge-sha>` for every merge; the compensating migration; and
for generated content, _retire_ rather than delete — flipping status out of `published`
removes it from every reader instantly while preserving the audit trail, job history and
cost record.

## 8. Escalating with nobody to escalate to

Three things, and only these three, stop a night rather than being decided:

1. An action that is irreversible and outside the contract's caps.
2. A change that cannot be made without breaking one of the seven laws.
3. The run plan and reality disagreeing about something material — a constraint that was
   wrong, a dependency that does not exist, a file two sessions both need.

For all three: write it in the PR body and in the run log, take the rest of your scope,
and leave it for the morning. For everything else, decide, record the assumption, and
keep moving.
