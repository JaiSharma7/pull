# The night of 2026-08-31 — unattended MVP run

> **Operating manual for an unattended run.** Every session reads this file in full before
> acting. **No human is awake.** No session may call `AskUserQuestion`, and no session may
> end a turn waiting for a person. Where a judgement call arises, this document decides it;
> where it does not, §3 decides it.

---

## 1. Where the repo actually stands

The engineering is far ahead of the product. 56 migrations, 38 RLS'd tables, a verified
12-step generation pipeline, a deployed worker, a live `pg_cron` dispatcher, real Gemini
providers with cost accounting, and a good design system. What is missing is **content,
navigation, and reader agency**.

Production holds **7 works, 24 pulls, 7 summaries, 12 topics, 1 profile, 0 saves, 0
history, 0 knowledge_states**.

Seven findings, each verified against the code or the live database, shape the whole night:

1. **The pipeline never writes `work_topics`.** Grepping `supabase/functions/` for "topic"
   returns nothing. `topic_affinity()` (`20260829130357_feed_rpc.sql:14`) returns `0.0` for
   a work with no topic rows. So every generated work scores **0 on the 28% topic term**
   while the six hand-seeded works score up to 1.0. A preferences picker built on top of
   this would appear to work and would only ever surface the six seeded works.
   **Topic tagging is a prerequisite for preferences, not a polish item.**
2. **`preference_profiles.media_kinds` defaults to `{book,film,documentary,podcast,paper,essay}` —
   no `lecture`.** The manifest is 27 essay / 7 lecture / 3 paper / 1 book, and `get_feed`
   filters the pool on `w.kind = any(media)`. **Seven of 38 sources would be fetched,
   summarised, paid for, published, and then invisible to every default reader.**
3. **Throughput is 6 pipeline steps per minute, globally, and the queue drains
   breadth-first.** `MESSAGES_PER_INVOCATION = 1` (`worker/index.ts:42`); the dispatcher
   fires one `net.http_post` per 10s tick. 12 steps per source ⇒ **one source every two
   minutes, ~30/hour**. And `advance_generation_job` re-enqueues with
   `pgmq.send(..., 0)` onto a **FIFO** queue, so a single 120-job batch does all 120
   `resolve_identity`, then all 120 `acquire` — **nothing is publishable until ~11/12 of the
   batch is done.** This one fact dictates the entire corpus strategy: **waves of ~12, never
   one big batch.**
4. **PR #6 already contains a hand-rolled router.** `App.tsx` on
   `claude/privacy-terms-legal-b7iscr` has `useState(() => window.location.pathname)`, a
   `popstate` listener, `navigate()` via `history.pushState`, and a `Legal` route.
   **Routing is not greenfield — it is extending PR #6.** Do not adopt TanStack Router.
5. **`og` already promises a route that does not exist.** `supabase/functions/og/index.ts`
   (deployed, v2) builds `${APP_ORIGIN}/pull/${id}` and 302s browsers there. Today that
   lands on the feed. `/pull/:id` is a live broken promise, not a nice-to-have.
6. **PR #5's gate is not binding tonight.** `covered` is computed against `known_ideas`,
   derived from `knowledge_states` with `retrievability > 0.7`. Production has **zero
   `knowledge_states`**, so `covered` is false for every candidate and the Delta cannot hide
   anything from a reader who has read nothing. **Seeding need not wait for PR #5.**
7. **`select('*')` on `works` will now fail.** `20260831013500` dropped the table grant and
   re-granted named columns to exclude `content_hash`. Any new query must enumerate columns.
   (No current code does this — it is a forward hazard for the source-detail screen.)

**Intended outcome by morning:** a deployed app serving a few hundred real Pulls across a
real topic taxonomy; a URL for every screen; a shareable source-detail page; a preferences
picker that measurably steers the feed; and no screen that lies when a request fails.

---

## 2. Environment constraints (verified — not assumptions)

| Constraint                                                                        | Consequence                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No Docker daemon**                                                              | `pnpm db:start` / `db:reset` / `db:lint` **cannot run**. CI check 4 is the _only_ migration replay oracle. Do not waste time trying.                                                                                                                                                                                      |
| Egress allowlisted: `github.com` yes; `*.supabase.co` and `wikisource.org` **no** | No direct REST calls, no local URL validation via `--check`. All DB work goes through the Supabase MCP. **But the database itself has egress** — see §5.4.                                                                                                                                                                |
| `supabase` / `vercel` / `gh` / `coderabbit` CLIs **not installed**                | MCP servers substitute. CodeRabbit is unavailable; `/code-review` is the reviewer.                                                                                                                                                                                                                                        |
| Supabase MCP connects as **`postgres` superuser**                                 | Seeding, `apply_migration`, Vault and `cron` all reachable — and a careless statement can damage production. Read §6.                                                                                                                                                                                                     |
| Supabase org on **free plan**                                                     | No branching. `zjvfwhjwaytyogdxeddo` is the only database.                                                                                                                                                                                                                                                                |
| Vercel **Hobby** — 1 concurrent build                                             | Deploys queue; two are already `BLOCKED` today. **Budget ≤3 pushes per PR.**                                                                                                                                                                                                                                              |
| **Migration ledger drift**                                                        | Production applied the last four migrations under MCP timestamps (`20260831012218`, `012225`, `012249`, `012345`) instead of the repo filenames (`20260830200114`, `20260830203352`, `20260830214412`, `20260831013500`). Content matches; versions don't. **Never run `supabase db push`** — it would re-apply all four. |
| `.claude/settings.json` has **zero `mcp__github__*` entries**                     | A session reaching `merge_pull_request` could stall on a prompt. Sessions run with permissions pre-granted; the allowlist is being extended as insurance.                                                                                                                                                                 |

---

## 3. Standing rules for every session

These replace a human being awake.

1. **Never ask. Decide, and record it** in the PR body under `## Assumptions`. Do not call
   `AskUserQuestion`. Do not end a turn waiting for input.
2. **Never end a turn on a red PR you opened.** Reproduce, fix, push. If genuinely blocked,
   comment once on the PR with exactly what is blocking and what you tried, then continue
   with the rest of your scope. Blocked on one item never means idle.
3. **Stay inside your file ownership boundary** (§4). If your work seems to need a file
   owned by someone else — including anything on the frozen list — **stop and report it in
   your PR body rather than editing it.** A merge conflict at 4am costs more than a seam.
4. **Rebase before every push.** `main` moves all night. `git fetch origin main && git
rebase origin/main`, re-run checks, push.
5. **`pnpm check` before every push.** It is the whole local gate; there is no local DB gate.
6. **Self-merge is authorised** once §7's gate passes. Do not wait for a human.
7. **Budget:** only the corpus session may cause provider spend, capped at **$1.00
   (100 cents)**. Everyone else: zero.
8. **Never** disable/skip/quarantine a test, weaken `supabase/tests/lint.sql`, hand-edit
   `packages/db/src/database.types.ts`, force-push, or edit an applied migration (law 6).
9. **The seven laws in `CLAUDE.md` bind absolutely** — law 1 (no gradients, no shadows, one
   accent `#8C2F26`, radius ≤ 4px), law 2 (no model in the read path), law 3 (the five stay
   free), law 4 (public domain only), law 5 (RLS), law 6 (append-only), law 7 (only the
   publishable key reaches the browser). A diff that breaks one is wrong even if it works.
10. **Subscribe to your own PR** (`subscribe_pr_activity`) so CI failures wake you.
11. **Finished early?** Do not invent features. Take the next item from §10 _Deferred_.

---

## 4. Sessions, scope, and file ownership

### Wave 1 — two sessions, zero file overlap

#### `S1 · corpus` — owns production SQL, `scripts/**`, new `supabase/migrations/*`, `docs/`

Touches nothing under `apps/` or `packages/`. Depends on nothing. **This is the long pole —
it must never stall.**

**A canary wave of 6 Emerson/Thoreau essays was already enqueued by the orchestrator at
T+0.** Its first job is to confirm that wave is healthy before enqueuing more.

1. **Canary acceptance** (poll every 3 min with the queries in §5.3): ≥5/6 `succeeded`; at
   least one published summary whose pulls have `embedding is not null`; cost/source within
   2× of 0.39¢; no 429/503 in `job_steps.error`.
2. **Then the topic + media fix** — the highest-leverage change of the night:
   - `supabase/functions/_shared/gemini.ts` (`SUMMARY_SCHEMA`, ~line 154): add a `topics`
     field, an array of strings constrained by `enum` to the §8 taxonomy. Gemini already
     returns structured JSON under `responseSchema`, so this is **one field, no extra call,
     no extra cost** — exactly "use Gemini at generation time, then store the result".
   - `supabase/functions/_shared/db.ts` `upsertWork` (~line 86): insert `work_topics` rows
     for the returned slugs. **Narrow unknown slugs away at the boundary**, the way
     `pipeline.ts` narrows `work_kind` and `rights_status` — this repo has been burned three
     times by values TypeScript accepted and Postgres rejected. Drop an unrecognised slug.
   - Deploy with `mcp__Supabase__deploy_edge_function`. **`scripts/go-live.sh` will not run
     here** (no Docker, no access token). **Verify against one real job** before trusting it.
   - **Migration: widen the taxonomy to §8, and fix the `media_kinds` default** to include
     `lecture`, `video`, `interview` — updating existing rows **only** where they still hold
     the exact old default (`where media_kinds = '{book,film,documentary,podcast,paper,essay}'::public.work_kind[]`),
     never clobbering a reader's choice. Both changes are rows and defaults, **not schema**,
     so `database.types.ts` does not change and CI's staleness diff cannot fire. That
     property is why this shape was chosen.
3. **Backfill topics** for the canary wave via `execute_sql` (data, not schema).
4. **Waves of 12 thereafter.** Launch a new wave whenever
   `count(*) from generation_jobs where status in ('queued','running')` drops below 4 —
   roughly one wave per 25 min. **Never one big batch** (§1.3).
5. **Expand the manifest** toward ~110–120 sources total, deliberately widening beyond
   18th–19th-century Anglo-American moral philosophy into science, economics, psychology,
   rights, craft, medicine and logic. The manifest's own `$comment` argues this: _"A feed of
   nothing but Stoicism makes the Delta look clever and tells you nothing."_ Validation
   per §5.4. **Law 4 is absolute: if you are not certain a work is public domain, leave it
   out.** Short works only — `acquire` truncates at 200,000 chars.
6. **Honesty constraint:** `scripts/corpus/public-domain.json`'s `$comment` currently claims
   every URL was fetched and checked via `--check`. If you add entries validated another
   way, **you must amend that comment to say so** — do not leave a true statement in the
   repo that your change makes false.

**Acceptance:** ≥45 works, ≥250 published pulls with no null embeddings, ≥8 topics carrying
≥8 sources each, advisors clean, spend < 100¢, `main` green.

#### `S2 · shell` — owns `apps/web/src/App.tsx`, `lib/routes.ts`, `routes/Auth.tsx`, `packages/ui/src/styles/index.css`

Sole owner of the application shell for the entire night. Its job is to be **fast and
boring**; Wave 2 is gated on it.

1. **Merge PR #6, then PR #5.** For each: `update_pull_request_branch` → wait for all four
   checks green **on the new head sha** → merge. PR #5 also adds `db:test` to CI check 4,
   which becomes the safety net for every later SQL change. **Leave PR #9 open** (§10).
2. **Extend PR #6's existing router into a route table** — `apps/web/src/lib/routes.ts`, a
   pure module with `parsePath(pathname)` and `hrefFor(route)`, unit-tested. Routes:
   `feed`, `review`, `library`, `preferences`, `source/:workId`, `pull/:pullId`, `daily`,
   `legal/:doc`. The three tabs become routes so back/forward and refresh work.
   **Do not adopt TanStack Router or Query** (§10).
3. **Ship every Wave-2 seam already wired**, so no Wave-2 session edits `App.tsx`. Create
   these as honest one-paragraph stubs, then never touch them again:

   | File (created by S2, then frozen)                                                          | Owned for the night by |
   | ------------------------------------------------------------------------------------------ | ---------------------- |
   | `routes/Source.tsx` (exports `Source`, `PullRedirect`)                                     | **S3**                 |
   | `routes/Preferences.tsx` (exports `Preferences`, `OnboardingGate`)                         | **S4**                 |
   | `routes/Daily.tsx`                                                                         | **S5**                 |
   | `lib/source-api.ts`                                                                        | **S3**                 |
   | `lib/preferences-api.ts`                                                                   | **S4**                 |
   | `lib/daily-api.ts`                                                                         | **S5**                 |
   | `packages/ui/src/styles/{source,preferences,daily}.css` (empty, imported from `index.css`) | S3 / S4 / S5           |

   Also ship the final navigation (`Feed · Review · Library · Preferences`, Daily from the
   colophon) so no Wave-2 session needs a nav edit, and wrap the signed-in shell in a
   pass-through `<OnboardingGate>` that S4 later fills in.

4. Deliberate un-DRY: three small `*-api.ts` files instead of extending `lib/api.ts`, which
   is the hottest conflict surface in the repo. Note the merge-back as follow-up in the PR.

**The frozen list** — no Wave-2 session may edit any of these: `App.tsx`, `lib/routes.ts`,
`lib/api.ts`, `lib/session.ts`, `lib/supabase.ts`, `lib/offline.ts`,
`packages/ui/src/index.ts`, `packages/ui/src/styles/index.css`, `components.css`,
`tokens.css`, `eslint.config.js`, `package.json`, `turbo.json`, `.github/workflows/ci.yml`.

**Acceptance:** every screen has a URL; back/forward and refresh work; `/pull/:id` and
`/source/:slug` resolve; feed session counters still survive tab switches (today's `App.tsx`
keeps Feed mounted via `hidden` on purpose — a naive port loses this and the session rail
starts lying); CI green; merged; production deploy `READY` at that sha.

### Wave 2 — gated on S2's merge + a READY production deploy. Four sessions, disjoint files.

| Session                    | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Owns                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **S3 · source**            | `/source/:workId`: the work (**columns enumerated, never `select('*')`** — §1.7), its published summary, its pulls in ordinal order with save + listen, and `get_source_delta(workId)` as _"you already hold 3 of 21 ideas here"_ — implemented and tested since round 1 with no UI. `PullRedirect` resolves `/pull/:id` → `summary.work_id` → `/source/:workId#p-<id>`, making `og`'s promise true. Wire feed/library source chips. **No SQL.**                                                                                                                                                                                                                                                        | `routes/Source.tsx`, `lib/source-api.ts`, `styles/source.css`                   |
| **S4 · preferences**       | §9. **No SQL, no RPC** — `preference_profiles_own` is `for all using (auth.uid() = user_id)`, so the browser writes its own row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `routes/Preferences.tsx`, `lib/preferences-api.ts`, `styles/preferences.css`    |
| **S5 · honesty + daily**   | `Review.tsx:22` — `.catch(() => setDue([]))` renders an RPC failure as the _success_ message _"Nothing is fading. Everything you have saved is still solid."_ Split three states: `null` loading, `[]` genuinely nothing due, `Error` → "Could not check what is fading" + retry, mirroring `Feed.tsx`'s existing pattern; `lib/rpc-error.ts` already distinguishes transport failure from server refusal. Then `/daily`: `daily_pulls` is seeded, RLS'd `select using (true)`, and has **zero readers** — curated Daily Pulls are one of law 3's five free-forever promises and exist today only as a label string in `Enough.tsx`. Handle "nothing curated today" as a first-class state. **No SQL.** | `routes/Review.tsx`, `routes/Daily.tsx`, `lib/daily-api.ts`, `styles/daily.css` |
| **S6 · corpus, continued** | S1 continued: wave cadence, topic backfills, manifest expansion, monitoring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | same as S1                                                                      |

**Feed pagination and `p_last_placed` are explicitly NOT in Wave 2.** `page: 0` is hardcoded
and `Feed.tsx` is frozen under S2. If time remains after Wave 3, it is §10 item 1.

### Wave 3 — serialized merge queue

Smallest blast radius first: **S6 (SQL/scripts) → S5 → S3 → S4.** Per merge:
`update_pull_request_branch` → all four checks green **on the new head sha** → merge →
confirm the production deploy is `READY` before starting the next. ~15 min each.

---

## 5. Corpus operations

### 5.1 The arithmetic

6 steps/min × 12 steps/source ⇒ **30 sources/hour**. A ~4-hour draining window is
**~110–120 sources**, roughly $0.45 at the measured 0.39¢/source, yielding maybe 700–1,000
published pulls at 6–8 pulls per source.

### 5.2 Pacing and hard stops

Waves of **12**. A wave finishes in ~24 min and _leaves publishable content behind_ — so if
the night dies at T+2 the owner still wakes to ~50 live sources instead of zero.

Any one of these halts new enqueues: past the drain window; `sum(cost_cents) > 100`; a wave
with >20% `failed`; or `count(*) from summaries where status='published'` failing to
increase for 30 minutes.

**Do not raise the dispatcher tick rate as a first move.** Going 10s → 5s doubles throughput
and costs almost nothing in invocations, but it doubles concurrent Gemini calls, and
`isRetryable` treats 429 as retryable inside a shared 100s budget — three 429s and a job
fails permanently. Make it a _measured_ decision only if the canary shows zero 429/503.
Never below 5s. Rollback is the identical call with `10`.

### 5.3 Monitoring queries

```sql
select status, count(*) from public.generation_jobs group by 1;
select count(*) as depth from pgmq.q_generation;
select step, status, count(*), max(left(error,160)) as sample from public.job_steps group by 1,2 order by 1;
select coalesce(sum(cost_cents),0) as cents, count(distinct job_id) as jobs from public.cost_ledger;
select count(*) from public.summaries where status='published';
-- must be 0:
select count(*) from public.pulls p join public.summaries s on s.id=p.summary_id
 where s.status='published' and p.embedding is null;
-- poison pills: never re-enqueue these
select target->>'url' from public.generation_jobs where status='failed';
-- duplicate spend guard
select target->>'url', count(*) from public.generation_jobs group by 1 having count(*)>1;
-- quality: read 5 random cards per wave with a human eye
select w.title, p.headline, left(p.body,240) from public.pulls p
 join public.summaries s on s.id=p.summary_id join public.works w on w.id=s.work_id
 where s.status='published' order by random() limit 5;
```

Triage: an `acquire` error is a bad URL — drop it, never re-enqueue. A `synthesize` 429/503
is Gemini — pause 15 min, do not change the tick. MAX_TOKENS means the source is too long —
drop it. **`critic` is structural only** (non-empty body, headline ≤ 200 chars), so a wave
that reads badly is _stopped_, not tuned at 3am.

### 5.4 Validating URLs without container egress

The container cannot reach Wikisource, so `--check` cannot run. **The database can** — it is
what dispatches the worker. Use `pg_net`:

```sql
select net.http_get(u) from unnest(array['https://en.wikisource.org/wiki/...']) u;
-- moments later
select id, status_code, content_type, octet_length(content) as bytes from net._http_response;
```

**Calibrate first** against three URLs already known good from the committed manifest, and
set the accept band from that ground truth — this measures raw HTML where `--check` measures
visible text (expect ~3–5×). Confirm pg_net's response-size cap in the same run; a truncated
body makes every long source look short.

Final arbiter is the pipeline itself: `acquire` runs **before** any provider call, so a bad
URL costs **$0** — about 30 seconds of throughput. Promote new sources into the manifest
only after they clear a probe wave.

---

## 6. Migration protocol

**Rule 0 — the default is no migration.** Preferences: none. Source detail: none. Review and
Daily: none. Routing: none. **Exactly one session writes SQL tonight.**

1. **Append-only (law 6).** New file `supabase/migrations/20260831HHMMSS_snake_name.sql`,
   version strictly greater than `20260831013500`. Never edit a pushed migration.
2. **CI is the only replay oracle.** Green on the branch is the **precondition** for touching
   production, never the reverse.
3. **Prefer migrations with no type surface** — rows, defaults, grants, and
   `create or replace function` at an unchanged signature leave `database.types.ts` alone.
   Both of tonight's planned changes are deliberately of this kind.
4. If the type surface must change, **do not hand-write the generated file.** Push without
   it, let check 4 fail, read the exact diff from the job log
   (`mcp__github__get_job_logs`, `failed_only: true`), apply verbatim, push once.
5. **Apply with `mcp__Supabase__apply_migration`**, `name` = the repo filename stem. MCP
   mints its own version string; accept it — the _name_ is what makes the row recognisable.
6. **Verify after applying; never assume.** This repo's sharpest lesson is `20260830200114`:
   a column-level `revoke` that ran cleanly, reported success, passed review, and changed no
   privilege at all. Every migration carries a paired verification query whose output goes in
   the PR body.
7. **Advisors after every apply.** A _new_ security finding is a stop. Three are known and
   accepted: `enqueue_generation_job` being SECURITY DEFINER (deliberate), leaked-password
   protection off in Auth, and duplicate indexes on `artworks`.
8. **Write the compensating SQL before applying.** Append-only means rollback is a new
   migration.
9. **Never** `create_branch` (free plan). Never `apply_migration` for a data backfill — that
   is `execute_sql`, with the row count recorded.
10. Verify destructive-looking SQL inside `begin; ... rollback;`, the pattern
    `scripts/smoke-read-path.sql` already uses. **No `update`/`delete` on a content table
    without first running the identical `select` and pasting the count.**

---

## 7. Review gate

Replaces the four-reviewer `AGENTS.md` gate for this run. Per PR:

1. All four CI checks green on the head being merged.
2. **`/code-review` at high effort** — fix every finding, or say in the PR body why it does
   not apply.
3. **`/design-check`** on any diff touching `apps/web/` or `packages/ui/`.
4. **`get_advisors`** clean for any diff touching `supabase/`.
5. **Secret scan before push:**
   `git diff --cached | grep -nE 'sb_secret_|service_role|AIza|AQ\.[A-Za-z0-9]|BEGIN [A-Z ]*PRIVATE KEY'`
   A hit is a stop, not a judgement call. A leaked key is **rotated**, not quietly removed.
6. **Then self-merge**, recording in the PR body that the abbreviated gate was used and why.

---

## 8. Topic taxonomy — a contract between the corpus and preferences sessions

The corpus session writes it and constrains Gemini to it; the preferences picker offers it.
**Existing slugs must not be renamed** — `work_topics` already references them.

| Parent             | Children                                                       |
| ------------------ | -------------------------------------------------------------- |
| `philosophy`       | `ethics`_, `stoicism`_, `logic`, `metaphysics`, `aesthetics`   |
| `psychology`       | `attention`_, `habits`_, `learning`, `emotion`                 |
| `science`          | `evolution`_, `physics`_, `chemistry`, `astronomy`, `medicine` |
| `society`          | `economics`_, `liberty`_, `government`, `justice`, `education` |
| `arts-and-letters` | `literature`, `rhetoric`, `criticism`                          |
| `history`          | `biography`, `revolutions`                                     |

`*` already exists. Target **≥8 topics with ≥8 sources each** — a picker where half the
topics are empty is worse than no picker. If this table changes, update this section in the
same PR.

---

## 9. Preferences — the feature the owner asked for

`/preferences`, plus a fourth rail item. **No migration, no RPC**: `preference_profiles_own`
is `for all using ((select auth.uid()) = user_id)` and `topics` is `select using (true)`, so
the browser reads and writes its own row through PostgREST.

**Ship only controls that reach the read path.** A control that changes nothing is a lie,
and an honest account is this product's whole claim:

| Column                                                                    | Read by                                     | Ship?   |
| ------------------------------------------------------------------------- | ------------------------------------------- | ------- |
| `topic_weights`                                                           | `topic_affinity()` → 28% of the score       | **yes** |
| `excluded_topics`                                                         | `get_feed` pool filter                      | **yes** |
| `media_kinds`                                                             | `get_feed` pool filter                      | **yes** |
| `interrupt_rate`                                                          | `plan_interleave` (`0` disables interrupts) | **yes** |
| `daily_minutes`, `technical_level`, `novelty`, `spoilers`, `counter_rate` | nothing                                     | **no**  |

- **Topics** are a **three-state control** — _More of this_ / _Default_ / _Not for me_ — not
  a checkbox, because the model genuinely has three states and `excluded_topics` is a
  different mechanism from a low weight. "More" writes `topic_weights[slug] = 1.0`; "Not for
  me" writes the slug into `excluded_topics`; "Default" writes neither. Read topics from the
  database, never hardcoded, so corpus expansion is picked up automatically.
- **Design law 1:** selected state signalled by more than colour, keyboard-reachable, visible
  non-colour focus, no gradient, no shadow, radius ≤ 4px, one accent.
- **Saving** is one upsert, then `window.location.assign('/')`. Blunt, but `Feed`'s fetch
  effect is keyed on `session.seed` and `lib/session.ts` is frozen. Record it in the PR body
  as a known rough edge to replace with a `refresh()` seam later.
- **Onboarding is required, and it is one screen, not a flow.** `onboarded_at` already exists.
  Without it the picker is a settings page nobody opens and 28% of the ranking score stays
  flat forever. `OnboardingGate` reads `onboarded_at` once; if null it renders the same
  screen in onboarding mode with one headline (_"What do you want to learn about?"_) and two
  exits — **Start reading** (writes weights + `onboarded_at`) and **Show me everything**
  (writes `onboarded_at` only). If it is set, **or if the read fails**, it renders children:
  **fail open, never trap a reader behind a settings screen because a query 500'd.** That
  failure direction deserves a test.
- **Dependency, stated plainly:** this screen is inert until topic tagging lands. It still
  ships and does no harm if that PR does not.

---

## 10. Scope discipline

### Not tonight — each is genuinely tempting and each would eat the night

1. **TanStack Router / Query.** Zero imports today; adopting either is a whole-app refactor
   touching every file Wave 2 depends on. PR #6's hand-rolled `pushState` + `popstate` is
   ~80 lines from a route table and conflicts with nothing. Do not remove the unused deps
   either — lockfile churn for no reader-visible gain.
2. **Search.** No tsvector, no RPC, no UI. Round 3.
3. **Wiring `refresh_knowledge_vector`.** The `uvec` term is a constant `0.5` for every card,
   so it is _inert_ — it does not distort ranking, it wastes 18% of the weight budget. The
   roadmap frames it as a decision (call it on a cron, or drop the term and redistribute),
   not a chore. **This is a change from an earlier draft of this plan.**
4. **Relation extraction** to make PR #5 effective on generated content. PR #5 is edge-exact
   and no pipeline step writes `pull_relations`, so on generated content it is **inert**.
   That is a thirteenth step, a new prompt, a redeploy and a review round. Record it; don't
   build it.
5. **The `generation_hash_claims` reuse lease.** Deferred deliberately — a crashed job
   holding a claim stalls the queue, which is worse than a duplicated bill. Tonight's corpus
   has no duplicate URLs, so the race cannot fire.
6. **Zod in `packages/schemas`**, or mirroring the feed scorer in `packages/ranking`. Real
   gaps between `CLAUDE.md`'s claims and the code; both are cleanup.
7. **Playwright or any e2e harness.** New toolchain, new CI job, new flake surface, at 2am.
8. **Stashes, highlights, notes, history, profile, Pull Studio, Explore.** Breadth of
   half-empty screens is the shape explicitly rejected in favour of "content + the loop".
9. **Artwork.** `generation.md` names it the first thing to switch off under cost pressure.
   `{generated: false}` is a supported outcome and the card degrades to typography.
10. **Merging PR #9.** Its workflows add a Claude review bot to every PR at the exact moment
    `/code-review` was chosen instead — an extra pending check on every PR, and a pending
    unexplained check is the thing most likely to make a 3am session wait forever. **Leave it
    open**; it is a five-minute decision for the morning.
11. **`supabase db push`**, and **changing the dispatcher interval as a first move**.
12. **Creating test users in production.** The rolled-back transaction in
    `scripts/smoke-read-path.sql` is the only sanctioned way to exercise RLS against the
    hosted database, and `count(*) from auth.users` must match either side of it.

### Deferred but valuable — take these in order only if you finish early

1. Feed pagination + sending `p_last_placed` (`get_feed` already accepts it, and
   `interleave.test.ts` has a 3,000-seed regression for the cross-page gap it protects —
   these two ship together or not at all).
2. Offline-queue Review grades; wire the exported-but-never-called `stopSpeaking` /
   `speechSupported` so Listen has a stop control and degrades on unsupported browsers.
3. Tests for `Feed.tsx`'s `weave()` — pure, untested, and it silently drops any slot at
   index 0.
4. A History screen — `history_events` is populated and law 3 promises unlimited history with
   no surface at all.
5. Ledger reconciliation (§2), rehearsed in `begin; ... rollback;` with the row count checked
   to be exactly 4 first.

---

## 11. Morning state, and rollback

**Acceptance criteria, not vibes:**

1. The newest `target: "production"` Vercel deployment is `READY` and its `githubCommitSha`
   equals `origin/main`.
2. All four CI checks green on `origin/main`.
3. `count(*) from works` ≥ 45; published pulls ≥ 250; **published pulls with null embedding
   = 0**.
4. `/preferences` loads, lists ≥ 20 topics under parents, and saving visibly changes the
   feed — proven by setting one topic to "More of this", reloading, and confirming the top
   card's work carries that topic in `work_topics`.
5. A card's source chip is clickable; `/source/<workId>` shows work, summary, pulls and
   Delta; `/pull/<pullId>` resolves through — so `og`'s deployed promise is finally true.
6. `/review` distinguishes loading, nothing-due, and failed-to-check.
7. `sum(cost_cents)` < 100. **`count(*) where status='failed'` is reported in the brief, not
   hidden.**
8. `get_advisors` returns only the three known findings.
9. `docs/roadmap.md` has a dated section: what landed, what failed and why, what was cut,
   the exact cost, and the rollback handles below.

**Rollback:**

- **Frontend, one action, no git:** promote the last known-good production deployment —
  `dpl_7nnFN8oYzXAdEKK9jDdk5wcJ5cGz`, sha `3b6c5a4`, the pre-night production build.
- **Git:** every merge is a merge commit; `git revert -m 1 <merge-sha>`. Never force-push.
- **Schema:** append-only; the compensating migration was written before the apply (§6.8).
- **Content:** generated content is additive, so rollback is not a delete — _retire_ it:
  `update public.summaries set status='retired' where id = any('{...}');`
  `get_feed` filters on `status='published'`, so this removes it from every reader instantly
  while preserving the audit trail, job history and cost record.
