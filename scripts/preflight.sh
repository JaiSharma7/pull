#!/usr/bin/env bash
#
# What this container can actually do, before a night depends on it.
#
# The most expensive discovery of an unattended run is a capability the plan assumed and
# the machine does not have. No Docker daemon means `db:reset`, `db:start` and `db:lint`
# cannot run and CI becomes the only migration replay oracle -- survivable at dusk,
# night-ending at three. Every line below is probed, not remembered.
#
# Usage: ./scripts/preflight.sh [extra-host ...]
# Exit: 0 ready · 1 a hard blocker (nothing can be verified locally at all).
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || { echo "not a git repository"; exit 1; }

blockers=0
row() { printf '  %-34s %-9s %s\n' "$1" "$2" "$3"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo
echo "what-a-pull · preflight $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo

echo "toolchain"
if have node; then
  v="$(node -v)"; [[ "${v#v}" == 2[2-9].* || "${v#v}" == [3-9][0-9].* ]] \
    && row node "$v" "" || row node "$v" "engines wants >=22"
else
  row node MISSING "hard blocker — nothing runs"; blockers=$((blockers + 1))
fi
have pnpm && row pnpm "$(pnpm -v)" "" || { row pnpm MISSING "hard blocker"; blockers=$((blockers + 1)); }
[ -d node_modules ] && row node_modules present "" \
  || row node_modules absent "run pnpm install — the SessionStart hook usually does"
have psql && row psql "$(psql -V 2>/dev/null | awk '{print $3}')" "" \
  || row psql absent "db:lint and db:test cannot run locally"

echo
echo "local database"
if have docker && docker info >/dev/null 2>&1; then
  row docker running "db:start / db:reset / db:lint available"
else
  row docker unavailable "NO local stack. CI check 4 is the only migration replay oracle."
  echo "                                              Do not spend the night trying to start one."
fi

echo
echo "service CLIs        (absent is fine — the MCP servers substitute)"
for c in supabase vercel gh; do
  have "$c" && row "$c" present "" || row "$c" absent "use the $c MCP server instead"
done

echo
echo "egress"
probe() {
  if curl -sS -o /dev/null -m 6 --head "https://$1" 2>/dev/null; then row "$1" reachable ""
  else row "$1" blocked "${2:-}"; fi
}
probe github.com
probe api.github.com
probe generativelanguage.googleapis.com "provider calls must go through the Edge worker"
for extra in "$@"; do probe "$extra"; done
echo "  note: the database has its own egress even when this container does not —"
echo "        pg_net from a SQL session can reach hosts curl here cannot."

echo
echo "git"
branch="$(git branch --show-current 2>/dev/null || echo detached)"
row branch "$branch" ""
dirty="$(git status --porcelain | wc -l | tr -d ' ')"
[ "$dirty" = "0" ] && row worktree clean "" || row worktree "$dirty file(s)" "commit or stash before dispatching sessions"
if git rev-parse --verify --quiet origin/main >/dev/null; then
  git fetch -q origin main 2>/dev/null || true
  counts="$(git rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo '? ?')"
  row "vs origin/main" "$(echo "$counts" | awk '{print $1" behind, "$2" ahead"}')" "rebase before every push"
else
  row "vs origin/main" unknown "run git fetch origin main"
fi

echo
echo "gates that will run"
row "pnpm check" "$( [ -d node_modules ] && echo available || echo "needs install" )" "format:check · lint · typecheck · test"
row "secret-scan" "$( [ -x scripts/secret-scan.sh ] && echo armed || echo MISSING )" "PreToolUse hook on git commit/push"
row "CI" "4 checks" "lint · typecheck · test · db"

echo
if [ "$blockers" -gt 0 ]; then
  echo "NOT READY — $blockers hard blocker(s). Fix before dispatching an unattended run."
  exit 1
fi
echo "Ready. Copy the constraints above into the run plan's environment table, each one"
echo "with its consequence — a fact nobody drew a conclusion from gets re-derived at 3am."
echo
