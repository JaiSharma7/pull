# The night of YYYY-MM-DD — unattended run

> **Operating manual for an unattended run.** Every session reads this file in full before
> acting. **No human is awake.** No session may call `AskUserQuestion`, and no session may
> end a turn waiting for a person. Where a judgement call arises, this document decides it;
> where it does not, `.claude/skills/overnight/SKILL.md` §2 decides it.

Instantiate this template into `docs/overnight-plan.md` (or a dated copy) at dusk. Fill
every section. A section left as a placeholder is a question someone will have to answer
at 3am, and nobody will be there.

---

## 0. Run log

Appended as the night proceeds. **Read this before acting; it supersedes the plan below
wherever the two disagree.** Landed and verified; decisions taken, with reasons; what is
in flight.

---

## 1. Where the repo actually stands

Facts, with the evidence that established them. What is deployed, at what sha. What is
merged, what is open, what is stale. The intended outcome by morning, in one paragraph a
reader would recognise.

## 2. Environment constraints — verified, not assumed

Paste the `./scripts/preflight.sh` result, then turn each line into a consequence.

| Constraint | Consequence |
| ---------- | ----------- |
|            |             |

## 3. The contract

| Field           | Value                                                |
| --------------- | ---------------------------------------------------- |
| Objective       |                                                      |
| Evaluator       |                                                      |
| Baseline        |                                                      |
| Caps            | wall clock · spend (cents) · pushes per PR · commits |
| Allowed scope   |                                                      |
| Forbidden scope |                                                      |
| Stop conditions |                                                      |

## 4. Sessions, scope, and file ownership

One writer per file, for the whole night. Waves gate on merges, not on clocks.

### Wave 1 — the shell and the long pole

| Session | Objective | Owns (files) | Depends on | Acceptance |
| ------- | --------- | ------------ | ---------- | ---------- |
|         |           |              |            |            |

**Seams shipped by the shell session, then frozen:** list every file it creates as a stub
for a later session, with the owner of each.

**The frozen list** — no session may edit these:

### Wave 2 — gated on the shell merging and deploying READY

| Session | Objective | Owns (files) | Acceptance |
| ------- | --------- | ------------ | ---------- |
|         |           |              |            |

### Wave 3 — serialized merge queue

Order, smallest blast radius first. Per merge: update the branch → all checks green on the
**new head sha** → merge → confirm the production deploy is `READY` before the next.

## 5. Long-running operations

Wave size and cadence. The arithmetic behind them. Hard stops. Monitoring queries, ready
to paste. Triage: which failures are permanent, which are transient, which are poison
pills never to be re-enqueued.

## 6. Migration protocol

Rule 0 — the default is no migration. Which single session may write SQL. The paired
verification query every migration carries. The known-and-accepted advisor findings, by
name, so a session can tell a new one from an old one. The compensating SQL, written
before the apply.

## 7. Review gate

Which gate is in force tonight and why — the full `AGENTS.md` gate, or the abbreviated one
in the overnight skill §6. Record the choice; do not slide into it.

## 8. Contracts between sessions

Anything two sessions must agree on that is not enforced by a type: a taxonomy, an enum, a
route shape, a column name. Written once, here, and updated in the same PR that changes it.

## 9. Scope discipline

### Not tonight

Each item with the reason it is tempting and the reason it would eat the night. This list
does more work than any other section — it is what stops a session at 2am from starting a
refactor that cannot finish.

### Deferred but valuable — in order, only if you finish early

## 10. Morning state, and rollback

**Acceptance criteria, not vibes.** Each one a query or an observation with an answer:

1.

**Rollback:** the last known-good deployment id and sha · `git revert -m 1 <merge-sha>` ·
the compensating migration · retire generated content rather than deleting it.
