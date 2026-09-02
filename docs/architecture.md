# Architecture

## Shape

```
┌──────────────────────────────────────────────┐
│  Browser / (later) Capacitor                 │
│  React 19 · Vite · pushState routing         │
│                                              │
│  IndexedDB          Cache API                │
│  ├── saved Pulls    ├── UI bundle            │
│  ├── summaries      ├── images               │
│  ├── history        └── audio                │
│  └── pending mutations                       │
└───────────────┬──────────────────────────────┘
                │ supabase-js
┌───────────────▼──────────────────────────────┐
│  Supabase                                    │
│  PostgREST ── RPCs ── Auth                   │
│                                              │
│  Postgres 17                                 │
│  ├── relational data                         │
│  ├── pgvector (HNSW, 1536d)                  │
│  ├── pg_trgm full-text                       │
│  ├── pgmq   generation queue                 │
│  └── pg_cron + pg_net  dispatcher            │
│                                              │
│  Edge Functions: worker · enqueue · og       │
└──────────────────────────────────────────────┘
```

There is no separate API server, no Redis and no S3. The research blueprint called for
all three; Supabase supplies each as a Postgres extension or built-in, which removes
three deployment surfaces and keeps a self-hoster's setup to one `docker compose`.

## The rule that shapes everything: no LLM in the read path

Models run at **generation** time, once per canonical summary. They never run at
**delivery** time.

```
Atomic Habits
      ↓
Canonical Summary v3  ──→  18 Pull cards  ──→  embeddings + tags
      ↓
    CACHE
  ↙   ↓   ↘
user user user …          personalisation picks WHICH cards and in WHAT ORDER
```

One canonical generation costs roughly $0.056. A thousand readers of that summary amortise
it to a fraction of a cent each. A thousand *personalised regenerations* of the same book
cost about $56. That ratio is not an optimisation — it is the difference between an
ad-supported product that works and an API bill that outgrows its audience.

So ranking, search, the Delta and the interleave planner are SQL and vector arithmetic:

```
SELECT candidates → vector similarity → filters → score → diversity rerank → response
```

not:

```
call a model → ask what the user should see next
```

## The generation graph

Supabase Edge Functions cap at **150s wall-clock and 2s CPU** per request on the free
plan. A generation pipeline — acquire, chunk, extract, synthesise, critique, embed,
illustrate — does not fit in one invocation and must never be written as though it does.

So generation is a resumable machine. Each invocation executes **exactly one node**,
records what it produced and what it cost, and dispatches whatever that node unblocks:

```
pg_cron (every 10s) ──pg_net──> worker function
                                    │
                            pgmq.read('generation')
                                    │
                            execute ONE node, given only the outputs it declared
                                    │
                    write job_steps + cost_ledger (one transaction)
                                    │
                    dispatch each successor whose predecessors have all succeeded
```

The nodes form a graph, declared as data in `supabase/functions/_shared/graph.ts` and
asserted by `graph.test.ts` (acyclic, every node reachable, every input an ancestor):

```
resolve_identity → acquire ──reuse?──────────────────────────┐
                      ↓                                       │
                    chunk                                     │
              ┌───────┴────────┐                              │
      extract_evidence     synthesize → template              │
              └───────┬────────┘                              │
                   critic → cards                             │
                           ┌──┴───┐                           │
                       artwork  embed                         │
                           └──┬───┘                           │
                          moderate ◄──────────────────────────┘
                              ↓
                          publish
```

Each node declares `needs` (the outputs it reads — the worker fetches only those) and
`after` (the nodes that must have succeeded first). A node with several `after` entries
is a join, sent by whichever predecessor commits last; `dispatch_generation_step` verifies
the rows and guards the send with a unique index on `(job, step)`, so two predecessors
finishing in the same instant produce one message by construction. A job whose join can
never fire — one predecessor failed for good — is caught by `sweep_stranded_generation_jobs`.

Each node is keyed `unique (job_id, step, attempt)`, so a retry after a mid-node crash
cannot duplicate work. Every node records its model, prompt version, token counts,
duration and cost — which makes a bad generation correctable rather than a permanent
mysterious blob.

## Provider abstraction

The shapes in `supabase/functions/_shared/providers.ts`, as they actually are:

```ts
interface SummaryProvider {
  name: string;
  generateSummary(input: SummaryInput): Promise<SummaryDraft>;
}
interface EmbeddingProvider {
  name: string;
  embed(texts: string[]): Promise<{ vectors: number[][]; usage: Usage }>;
}
interface ImageProvider {
  name: string;
  generateArtwork(prompt: string): Promise<Artwork | null>;
}
```

There is **no `SpeechProvider`**, and there never was — this file described one for
several rounds. Audio is `speechSynthesis` in the browser (`apps/web/src/lib/speech.ts`),
which is what makes law 3 able to promise it free: it costs nothing per listen because
nothing leaves the device.

Selected by environment, so a self-hosted instance is never forced to reproduce our
vendors:

```env
SUMMARY_PROVIDER=gemini          # or anthropic, or unset for the stubs
EMBEDDING_PROVIDER=gemini        # or unset for the stubs
SUMMARY_FALLBACK_PROVIDER=       # anthropic, if a second is wanted
```

No key means the stub providers, so a fresh clone runs the whole pipeline end to end and
gets placeholder prose rather than an error — which is what makes `pnpm db:reset && pnpm
dev` work with no setup.

`IMAGE_PROVIDER` is not read by anything, deliberately: the `artwork` step is disabled in
`pipeline.ts`, and a variable that appears to select something it cannot select is worse
than no variable. Artwork is the first thing cut under cost pressure (law 2), and the
product degrades to typography, which the design brief was built for anyway.

## What an operator has to switch on

Three things in this schema are scheduled rather than automatic, and one is hosted
configuration. None of them is applied by a migration, deliberately: CI check 4 replays
every migration from zero, and a migration that calls `cron.schedule` makes that replay
depend on `pg_cron` running as a background worker inside a test container. The cost is
that they have to be listed somewhere, which is here.

| Call, once, as `postgres`                   | What stops without it                                             |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `enable_generation_dispatcher_with_token()` | The queue never ticks; generation jobs sit in `pgmq` for ever     |
| `enable_knowledge_vector_refresh()`         | Knowledge centroids go stale, so the Delta slowly stops filtering |
| `enable_log_retention()`                    | Operational logs grow until the free tier's storage runs out      |
| `enable_guest_sweep()`                      | Guest accounts accumulate for ever — see below                    |

The last one is newer than the others and fails differently. `sweep_guest_accounts`
deletes anonymous accounts after a day of disuse, and that retention promise is
load-bearing: `docs/privacy.md` states it to readers, the sign-in screen prints it before
anybody presses the button, and it is half the argument for letting a guest write to the
personal tables at all (`20260901190000`). Unscheduled, `auth.users` only grows, and all
three of those say something the database is not doing.

Its schedule is part of the promise rather than an operator's taste. `enable_guest_sweep`
defaults to hourly (`20260901220000`) because a nightly job and a one-day lifetime do not
compose: a guest who stops reading just after the sweep runs survives nearly two days, and
"a day" is then wrong by a factor of two in the one document a reader is most likely to
hold us to. An operator passing their own cron expression is choosing the accuracy of that
sentence, not just a time.

**Two auth settings live only in the dashboard, and one of them breaks everything.**
`supabase/config.toml` configures the local stack and nothing else, so `[auth]
enable_anonymous_sign_ins` has no effect on the hosted project — the guest button fails
there with `anonymous_provider_disabled` until somebody flips the same switch under
Authentication → Sign In / Providers.

The trap is what the dashboard recommends alongside it. Supabase's anonymous sign-ins
documentation advises enabling CAPTCHA protection in the same breath, and that setting is
on a different page (Project Settings → Authentication → Bot and Abuse Protection). This
app renders no CAPTCHA widget and sends no `captchaToken`, and Supabase's CAPTCHA covers
sign-in, sign-up and password reset alike — so switching it on does not merely fail to
help, it rejects **every** authentication request with `captcha_failed`, the email route
included. On 2026-09-01 that is exactly what happened: the auth logs cross one config
reload and go straight from `anonymous_provider_disabled` to `captcha_failed`, with no
working sign-in in between. `lib/auth-errors.ts` names the setting in the console for
whoever is running the deployment, because the reader-facing error cannot.

**Expect the advisor to light up once anonymous sign-ins are on.** Supabase's security
advisor emits an `auth_allow_anonymous_sign_ins` WARN for every table whose policies are
written `to authenticated`, because an anonymous user holds that role — around forty of
them here, where before the toggle there were eight. None of it is new exposure and none
of it is an ERROR: it is the advisor restating the premise `20260901190000` is built on,
and the four doors that premise closes (generation, authorship, reports, publishing) do
not appear in the policy lists it prints, because those policies now exclude guests. The
number is worth knowing in advance so nobody reads it as a regression at the wrong moment.

What guards guest abuse here instead of a CAPTCHA: an IP rate limit of 30 anonymous
sign-ins an hour, the money door shut in the database (`enqueue_generation_job` refuses a
guest outright — a per-requester ceiling means nothing against an identity that is free to
mint), length caps on every guest-writable column, and the hourly sweep with a one-day
lifetime. Supabase's own documentation says automatic cleanup of anonymous users is not
available and suggests deleting them manually after thirty days; `20260901220000` is
tighter than that by a factor of thirty.

**The frontend deploys itself and the database does not.** Vercel redeploys `apps/web`
from git on every push to `main`; migrations reach the hosted project only when somebody
runs `supabase db push` (step 2 of `scripts/go-live.sh`). So a pull request that adds a
column and selects it — an ordinary, correct pull request — ships the query to every
reader on merge and the column whenever the next person remembers.

That is not a hypothetical. On 2026-09-01 the hosted project was seven migrations behind:
`works.source_url` arrived in `20260901160000`, `apps/web/src/lib/source-api.ts` selected
it, and every source page a reader opened from a card answered `42703: column
works.source_url does not exist`. Nothing was broken except the gap between the two. The
source page now recognises that class of failure and says the two are out of step — without
guessing which side is behind, because the error does not say: a column dropped by a newer
migration and read by an older cached bundle is the same code pointing the other way. The
commands go to the console, where an operator looks, rather than into reader copy on a page
any visitor can open.

**The push itself is not currently possible on this project, and that is a separate
repair.** `db push` refuses when the remote history holds a version with no local file.
This project has 70 rows of history, 18 of them stamped by `apply_migration` rather than by
the CLI — so their versions match no filename here, and `--include-all` does not override it
(`missing-local` is checked first). Reconciling it is `supabase migration repair --status
applied <version>` per row, against production. `go-live.sh` therefore treats a failed push
as loud but not fatal: the worker deploy and the secrets are the reason that script exists,
they do not depend on the schema, and it exits non-zero at the end so a failed push cannot
read as a clean deploy.

**Anonymous sign-ins must also be on in the hosted project** — Authentication → Sign In /
Providers. `supabase/config.toml` configures the local stack and nothing else, so a
deploy without that switch shows every visitor a guest button that reports it cannot
work.

## Offline

Built on the web **before** any native wrapper, so Capacitor becomes an enhancement
rather than a rescue operation. Service worker for the bundle, the
stylesheet and the three self-hosted typefaces; IndexedDB for a pending-mutation queue
that drains on reconnect, and for the last page of feed rows.

Two limits, stated because "offline" is one of the five things law 3 promises and a
vaguer sentence would be doing work it has not earned. **Nothing caches audio** — it is
synthesised on the device by `speechSynthesis`, so there is nothing to cache and it works
offline for free. And **only the feed writes to the cache** (`cachePulls`, called from
`Feed.tsx`): the Library, Source, Search, Daily and History screens read through to the
network and fail without it. Widening that is the obvious next piece of offline work.

## Why Vite and not a server framework

The interactive app is built client-side so the identical bundle can later go into
Capacitor with `npx cap add ios && npx cap sync`. Share pages still need real Open Graph
metadata for the growth loop, so `whatapull.com/pull/:id` is served by the `og` Edge
Function — SSR for the one route that needs it, rather than for the whole app.
