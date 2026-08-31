---
description: Plan an unattended overnight run — ground truth, the autonomy contract, file ownership, then dispatch. Usage: /overnight <objective>
---

Prepare an unattended run for: $ARGUMENTS

Read `.claude/skills/overnight/SKILL.md` first. It holds the rules; this command is the
sequence. Do not skip a step because implementation looks easy after exploration — the
steps exist because nobody will be awake to catch what they catch.

## 1. Establish ground truth

Do not edit files in this phase.

- `./scripts/preflight.sh` — record what is actually available, and turn each constraint
  into a consequence.
- `git status`, the current branch, open PRs, and what is deployed at what sha. Distinguish
  what you observed from what you assumed.
- The relevant read path or user flow, traced. If the objective is a bug, reproduce it.

## 2. Write the contract

Instantiate `.claude/skills/overnight/plan-template.md` into `docs/overnight-plan.md`.
Fill every section — a placeholder is a question that will stall a session at 3am.

The parts that decide whether the night works:

- **The evaluator.** One command, query or observation returning pass or fail, with its
  current value as the baseline. If you cannot write one, the objective is not ready to
  run unattended.
- **Caps.** Wall clock, provider spend in cents, pushes per PR, commits.
- **File ownership.** One writer per file for the whole night, and the frozen list.
  Decompose by file, not by feature; sequence anything touching a shared schema or type.
- **Not tonight.** The refactors that are genuinely tempting and would eat the night.

## 3. Get approval before the autonomy starts

Return the contract, the crew plan, the risk tier and the morning acceptance criteria in
one message, with any decision that is truly the owner's. **This is the last point at
which a person can steer.** Wait for approval here — and only here.

## 4. Run

Dispatch, then own it. Subscribe to every PR you open. Follow the standing rules in the
skill: never ask, never end a turn on a red PR, rebase before every push, stay inside your
ownership boundary. Append to the run log as things land — it supersedes the plan.

Report outcomes, evidence, decisions or blockers. Never report that a session is
"working".

## 5. Hand off

`/handoff` at the end.
