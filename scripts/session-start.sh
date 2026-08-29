#!/usr/bin/env bash
# SessionStart hook: make a fresh session able to run checks immediately instead of
# spending its first minutes on setup. Best-effort — never fail the session.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 0

if [ ! -d node_modules ]; then
  echo "[what-a-pull] installing dependencies…"
  pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 || true
fi

echo "[what-a-pull] $(git branch --show-current 2>/dev/null || echo 'detached')"
echo "[what-a-pull] laws: CLAUDE.md · process: AGENTS.md · review gate: Codex → /code-review → merge"
exit 0
