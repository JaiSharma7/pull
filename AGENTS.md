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

2. **Codex reviews the first pass only.** Comment `@codex review` once, on the opening
   diff of a PR. Then _wait_. Do not merge, and do not start unrelated feature work on
   the same branch, while it is pending.

   One pass, not a loop. Codex is metered, and a rate-limited reviewer stalls a branch
   at the exact moment there is most to review. Its value is concentrated in the first
   look at a large unfamiliar diff, where it reliably finds enum members Postgres will
   reject, columns that do not exist, and grants nobody checked — the flat, factual
   mistakes that survive typechecking. Spend it there.

3. **Address every Codex comment.** For each one: fix it and push, or reply on that
   thread explaining precisely why it does not apply. "Out of scope" is a legitimate
   answer; silence is not.

4. **Then review in parallel, and repeat _that_ until it comes back clean.** Four
   specialists over non-overlapping slices of the diff, run at once:

   | Reviewer   | Slice                                           |
   | ---------- | ----------------------------------------------- |
   | security   | auth, RLS, SSRF, secrets, migrations            |
   | typescript | async correctness, state machines, types        |
   | database   | migrations, policies, grants, concurrency       |
   | frontend   | `apps/web`, the design laws, what a reader sees |

   This is the loop, and it is the one that must not be cut short. **A round that
   returns new findings is not a pass**, and the reason is specific rather than
   procedural: on this codebase, fixes have repeatedly _created_ the next
   vulnerability. Setting `summaries.author_id` was necessary to make a private
   summary readable by its requester, and it is what made an author able to publish
   that summary to the world. Round 2's findings were consequences of round 1's fixes
   three separate times. Re-review after fixing is not diligence theatre; it is where
   half the real findings come from.

   Prefer reviewers that verify. A finding demonstrated against a running stack under
   real RLS is worth ten that are reasoned about, and the difference is not effort —
   it is whether the claim is true.

5. **Merge** — only once the parallel round comes back clean and all four checks are
   green on the final head.

If Codex is not installed, or is rate-limited, say so and continue from step 4 rather
than waiting indefinitely. Do not merge around step 4 on the assumption it would have
passed — that step is the gate now, and skipping it is skipping the whole thing.

## Secrets

Law 7 in `CLAUDE.md` says what may reach the browser. This is how to hold to it.

**Before every push**, the diff is checked for credentials outside the one place they
belong. This no longer depends on anyone remembering it: `scripts/secret-scan.sh` runs as
a `PreToolUse` hook on every `git commit` and `git push` and blocks the call on a hit.

```bash
./scripts/secret-scan.sh --staged   # or --push, or --range <rev-range>
```

It reports `file:line` and the kind of credential, never the matched text — a scanner
that prints the secret it found has written it into the transcript, which is the thing
law 7 exists to prevent. Its rules require the shape of a _value_, so the many honest
mentions of `service_role` in migrations and docs do not trip it.

A hit is a stop, not a judgement call.

**Where each credential lives.** The Supabase publishable key is committed in
`apps/web/.env.production` on purpose — it is designed for the browser and RLS is the real
protection. Every other credential is server-side: the service_role key is injected into
Edge Functions by the platform as `SUPABASE_SERVICE_ROLE_KEY` and is never written down;
provider keys and the generation dispatch token live in Edge Function secrets or Vault, read
by the worker through a `security definer` RPC that is revoked from `anon` and
`authenticated`.

**Never move a key toward the client to make something work.** If a browser feature seems to
need a provider key, the feature belongs behind an Edge Function — which is also what law 2
requires, since anything calling a model from the client is a read-path model call by
definition.

**A leaked key is rotated.** Removing it in a follow-up commit does nothing: it stays in
history and in every clone. Rotate at the provider, then clean up.

**Local-stack keys are dev-only, and the split is deliberate.** `supabase start` prints two.
The publishable one is committed in `apps/web/.env.development` so a fresh clone runs
`pnpm dev` with no setup; it points at `127.0.0.1:54321` and is useless against anything
else. The secret one (`sb_secret_…`) is never committed — it is service_role for the local
database, and the local stack's JWT secret is a published default, so anyone who can reach
that stack can mint an admin token for it. Loopback only, always.

Neither ever goes into `.env.production`, a Vercel or Supabase environment variable, or any
deployed config. If a local key would make production work, something is pointed at the
wrong database.

Overriding locally is `.env.local`, which is gitignored — use it if your stack prints
different values than the committed defaults.

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

## Unattended runs

A night with nobody awake is a different discipline, not a longer session: every question
is a stall, every ambiguity is a stop, and every optimistic claim is a lie told to someone
who cannot check it.

- `./scripts/preflight.sh` — what this container can actually do, probed rather than
  remembered. Run it before anything depends on the answer.
- `/overnight <objective>` — ground truth, then the autonomy contract (objective,
  evaluator, baseline, caps, ownership, stop conditions), then approval, then dispatch.
- `.claude/skills/overnight/SKILL.md` — the rules that replace a person: never ask, never
  end a turn on a red PR, one writer per file, waves that leave finished work behind,
  the abbreviated review gate, and the escalations that are worth stopping a night for.
  `plan-template.md` beside it is the run plan to instantiate.
- `/handoff` — the evidence packet, with the failures reported rather than rounded away.

`docs/overnight-plan.md` is the worked example: the run of 2026-08-31 with its log intact.

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
