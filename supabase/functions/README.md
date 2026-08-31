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

## Hosted configuration the repo cannot set

Almost everything about this project is in git. These are the exceptions, and they are
worth listing precisely because nothing here will fail a build when they drift.

`supabase/config.toml` configures the **local stack only** — its `site_url` is
`http://127.0.0.1:5173`. The Supabase CLI (2.116.0) has `db push` for migrations and
`secrets set` for Edge Function secrets, but **no command that pushes auth
configuration** to a hosted project. So the settings below exist in the dashboard and
nowhere else, and a mismatch is silent: no error, no failing check, just a reader who
cannot sign in.

| Setting                   | Where                              | Must be                                              |
| ------------------------- | ---------------------------------- | ---------------------------------------------------- |
| Magic Link email template | Authentication → Email Templates   | The contents of `supabase/templates/magic_link.html` |
| Site URL                  | Authentication → URL Configuration | The deployed origin, not `localhost`                 |
| Redirect URLs             | Authentication → URL Configuration | The deployed origin, plus any preview origin used    |

**The template is the one that fails most quietly.** Supabase's default magic-link
template renders `{{ .ConfirmationURL }}` and nothing else, so the email carries a link
but no code — while the sign-in screen shows a six-box code input as its primary
action. A reader stares at six empty boxes and an email with no code in it. The
committed template puts `{{ .Token }}` first for the reason given in `config.toml`: a
link opened on a phone often lands in a different browser than the one that started the
sign-in, and the session then arrives where nobody is looking.

**Site URL matters for the same class of reason.** `emailRedirectTo` is validated
against the allow-list; when validation fails GoTrue does not error, it silently falls
back to Site URL. If that is still the default, a stranger's magic link points at
`http://localhost:3000` — a URL that works perfectly on the machine of the person who
set it up and nowhere else.

To check both without guessing: request a sign-in code, and look at the email that
arrives. A visible six-digit code means the template is right; a link whose host is the
deployed origin means the URL configuration is right. That is a thirty-second test and
it is the only one that actually proves it.
