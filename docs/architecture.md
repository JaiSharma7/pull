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
│  PostgREST ── RPCs ── Auth ── Storage        │
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

```ts
interface SummaryProvider {
  generateSummary(i: SummaryInput): Promise<CanonicalSummary>;
}
interface ImageProvider {
  generateArtwork(i: ArtworkInput): Promise<Artwork>;
}
interface EmbeddingProvider {
  embed(i: string[]): Promise<number[][]>;
}
interface SpeechProvider {
  synthesize(i: SpeechInput): Promise<AudioAsset>;
}
```

Selected by environment, so a self-hosted instance is never forced to reproduce our
vendors:

```env
SUMMARY_PROVIDER=openai       # or local
IMAGE_PROVIDER=openai         # or disabled
EMBEDDING_PROVIDER=local
SPEECH_PROVIDER=device        # Web Speech — free, and the default
```

## Offline

Built on the web **before** any native wrapper, so Capacitor becomes an enhancement
rather than a rescue operation. Service worker + Cache API for the bundle, images and
audio; IndexedDB for saved Pulls, summaries, history, progress and a pending-mutation
queue that drains on reconnect.

## Why Vite and not a server framework

The interactive app is built client-side so the identical bundle can later go into
Capacitor with `npx cap add ios && npx cap sync`. Share pages still need real Open Graph
metadata for the growth loop, so `whatapull.com/pull/:id` is served by the `og` Edge
Function — SSR for the one route that needs it, rather than for the whole app.
