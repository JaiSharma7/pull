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

## Who may call the worker

`worker` ships with JWT verification **off**, and authenticates the caller itself. That
is not a weaker posture than `verify_jwt`; it is what removes the manual step.

Scheduling the dispatcher against a JWT-verifying worker means pg_cron has to present the
service_role key, and the only place that key exists is the dashboard — so generation
stays off until a human pastes it. `enable_generation_dispatcher_with_token` instead mints
a token inside Postgres, keeps it in Vault, and sends it as `x-worker-token`. Nothing has
to leave the database.

The function accepts either credential, so both dispatchers keep working:

| Dispatcher                                | Credential presented                     |
| ----------------------------------------- | ---------------------------------------- |
| `enable_generation_dispatcher_with_token` | `x-worker-token`, compared against Vault |
| `enable_generation_dispatcher`            | `Authorization: Bearer <service_role>`   |

Both comparisons are constant-time, and a worker with **no** credential configured
returns 401 to everything rather than running open — this endpoint spends money, so
misconfigured must not mean public.

Locally, set `WORKER_DISPATCH_TOKEN` in `supabase/.env` (gitignored) so you are not
re-seeding Vault after every `db:reset`.
