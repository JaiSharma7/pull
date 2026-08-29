# Edge Functions

| Function  | Purpose                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `worker`  | One tick of the generation step-machine — reads pgmq, runs **one** step per job, records cost, enqueues the next |
| `enqueue` | Authenticated job creation with a sustainability quota (never a paywall)                                         |
| `og`      | Open Graph metadata for `/pull/:id`, so shared links unfurl without SSR for the whole app                        |

## Why a step-machine

Edge Functions cap at **150s wall clock and 2s CPU** per request on the free
plan. A generation pipeline — acquire, chunk, extract, synthesise, critique,
embed, illustrate — does not fit in one invocation, so it must not be written
as though it does.

`pg_cron` ticks the dispatcher; each tick runs one step per job and re-enqueues.
`unique (job_id, step, attempt)` on `job_steps` makes retries idempotent: a
worker that dies mid-step cannot double-charge or duplicate work.

## Round 1

Providers are stubs, so the whole machine is exercisable with **no API key**.
Round 2 swaps in real ones without touching the pipeline.

## Deploy

```bash
supabase functions deploy worker --no-verify-jwt
supabase functions deploy enqueue
supabase functions deploy og --no-verify-jwt
```
