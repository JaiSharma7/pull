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

## The generation step-machine

Supabase Edge Functions cap at **150s wall-clock and 2s CPU** per request on the free
plan. A generation pipeline — acquire, chunk, extract, synthesise, critique, embed,
illustrate — does not fit in one invocation and must never be written as though it does.

So generation is a resumable state machine. Each invocation executes **exactly one step**
and enqueues the next:

```
pg_cron (every 10s) ──pg_net──> worker function
                                    │
                            pgmq.read('generation')
                                    │
                            execute ONE step
                                    │
                    write job_steps + cost_ledger
                                    │
                    enqueue next step, delete message
```

Steps: `resolve_identity → acquire → chunk → extract_evidence → synthesize → template →
critic → cards → artwork → embed → moderate → publish`.

Each step is keyed `unique (job_id, step, attempt)`, so a retry after a mid-step crash
cannot duplicate work. Every step records its model, prompt version, token counts,
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
deletes anonymous accounts after 30 days, and that retention promise is load-bearing:
`docs/privacy.md` states it to readers, and it is half the argument for letting a guest
write to the personal tables at all (`20260901190000`). Unscheduled, `auth.users` only
grows, and the policy says something the database is not doing.

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
