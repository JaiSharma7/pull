#!/usr/bin/env bash
#
# Everything between "the pipeline exists in git" and "the pipeline runs in production".
#
#   login ──→ deploy worker ──→ set REQUIRE_REAL_PROVIDERS ──→ schedule cron ──→ enqueue
#                    ▲
#                    └── the step nothing else does. Vercel redeploys from git on
#                        every push; Edge Functions do not. The worker in production
#                        is version 1 from 05:16 UTC on 2026-08-30 — six hours older
#                        than the commit that made the pipeline write real content.
#                        Nothing errors, no CI check fails, and no job ever completes.
#
# Safe to re-run. Every step is idempotent: deploying twice makes a new version,
# setting a secret twice sets the same value, and the job insert is a new row you
# can watch independently.
#
# Usage:  bash scripts/go-live.sh
set -euo pipefail

PROJECT_REF="zjvfwhjwaytyogdxeddo"

cd "$(dirname "$0")/.."

# Node is not on a non-interactive PATH in this WSL install; nvm's copy is.
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
command -v node >/dev/null 2>&1 || {
  echo "no node on PATH; run 'nvm use' first" >&2
  exit 1
}

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "1/4  Authenticate"
# Persists to ~/.supabase/access-token, so this is a one-time cost.
if npx --yes supabase projects list >/dev/null 2>&1; then
  echo "already logged in"
else
  echo "A browser will open. Approve, and the token is stored for next time."
  npx --yes supabase login
fi

step "2/4  Deploy the worker"
# --no-verify-jwt because the worker authenticates the dispatcher itself against a
# Vault token; the platform cannot do it, since pg_net is not a signed-in user.
# Dropping this would make every dispatcher tick 401 and the queue would never drain.
npx --yes supabase functions deploy worker \
  --project-ref "$PROJECT_REF" \
  --no-verify-jwt

step "3/4  Require real providers"
# Without this, a rotated or quota-exhausted key silently falls back to stub summaries:
# zero cost, nothing in cost_ledger, no error anywhere, and readers get placeholder
# prose. With it, the worker refuses to start rather than pretend. The key itself
# stays in Vault — this flag only forbids the fallback.
npx --yes supabase secrets set REQUIRE_REAL_PROVIDERS=1 --project-ref "$PROJECT_REF"

step "4/5  Schedule the background jobs"
cat <<'SQL'

  Run this in the SQL editor. Every one of these is idempotent — cron.schedule upserts
  by job name — so re-running the script re-runs them harmlessly.

    select public.enable_generation_dispatcher_with_token();  -- or the plain variant
    select public.enable_knowledge_vector_refresh();
    select public.enable_log_retention();
    select public.enable_guest_sweep();

  None of these is applied by a migration, and that is deliberate: CI check 4 replays
  every migration from zero, and a migration that calls cron.schedule makes that replay
  depend on pg_cron running as a background worker inside a test container. The cost is
  that they are a deploy step, which is why they are written down here.

  The last one is the newest and it fails quietly. Without it, guest accounts accumulate
  for ever — and docs/privacy.md tells readers, as a fact, that a guest session unused
  for 30 days is deleted. That sentence is only true once this has been run.

  Guest sessions also need Authentication → Sign In / Providers → "Allow anonymous
  sign-ins" turned on in the dashboard. supabase/config.toml configures the local stack
  and nothing else, so without it the guest button on the title page reports that it is
  switched off.

SQL

step "5/5  Enqueue one real job"
cat <<'SQL'

  Run this in the SQL editor (or let Claude run it — it has database access):

    select public.enqueue_generation_job(jsonb_build_object(
      'title',         'On Liberty — of the liberty of thought and discussion',
      'kind',          'essay',
      'rights_status', 'public_domain',
      'text',          '<paste a public-domain passage, 200+ characters>'
    ));

  Then watch it walk:

    select step, status, attempt, provider, model, cost_cents, duration_ms
    from public.job_steps order by created_at;

  What proves it worked: `provider` reads 'gemini', not 'stub'.

SQL

step "Done"
echo "The worker now runs the reviewed pipeline. Tell Claude and it will enqueue,"
echo "watch every step, and report what a reader would actually see."
